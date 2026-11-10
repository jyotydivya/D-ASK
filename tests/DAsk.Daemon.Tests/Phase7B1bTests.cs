using System.Diagnostics;
using System.Text.Json;
using DAsk.Daemon.AgentHost;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Observation;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 7B.1b — read-only desktop intelligence. Identity rules, the desktop read service (fake and real windows),
/// observation failure reporting, and the agent-host protocol v2 (read-only calls).
/// Real-window tests use a disposable fixture process (tests/DAsk.Daemon.Tests/Fixtures/desktop-fixture.ps1) and an
/// allowlist restricted to that process, so no personal window is ever observed. Nothing here sends input.
/// </summary>
[Collection("AgentHost")]
public class Phase7B1bTests
{
    private static readonly string Root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    private const string ProtoHost = "tests/agent-host/fixtures/desktopProtoHost.cjs";
    private readonly ITestOutputHelper _output;
    public Phase7B1bTests(ITestOutputHelper output) => _output = output;

    // ── fakes ────────────────────────────────────────────────────────────────

    internal static readonly long T0 = new DateTime(2026, 11, 8, 10, 0, 0, DateTimeKind.Utc).ToFileTimeUtc();

    internal static WindowIdentity W(long hwnd, int pid, string image, string title, long created = 0, string cls = "FixtureClass",
        int thread = 7, int display = 0, uint dpi = 96, bool primary = true) => new()
    {
        Hwnd = hwnd, ProcessId = pid, ThreadId = thread, ProcessCreationFileTime = created == 0 ? T0 : created,
        ImagePath = $@"C:\Fixture\{image}", WindowClass = cls, SessionId = 1, Title = title, Visible = true, Minimized = false,
        Maximized = false, Foreground = false, Bounds = new[] { 100, 100, 500, 400 }, DisplayDevice = $@"\\.\DISPLAY{display + 1}",
        DisplayIndex = display, DisplayIsPrimary = primary, Dpi = dpi,
    };

    internal sealed class FakeWindows : IWindowSource
    {
        public List<WindowIdentity> Windows = new();
        public int Incomplete;
        /// <summary>Overrides for Read (re-validation): hwnd → identity now (null = gone).</summary>
        public Dictionary<long, WindowIdentity?> Now = new();
        public IReadOnlyList<WindowIdentity> Enumerate(out int excludedIncomplete) { excludedIncomplete = Incomplete; return Windows.ToList(); }
        public WindowIdentity? Read(long hwnd) => Now.TryGetValue(hwnd, out var w) ? w : Windows.FirstOrDefault(x => x.Hwnd == hwnd);
    }

    internal sealed class FakeUia : IUiAutomationService
    {
        public Action? DuringInspect;
        public UiaInspection Result = new("ok", new[]
        {
            new UiaNode(new[] { 42, 1 }, 0, -1, "Window", "", "Fixture", "FixtureClass", new[] { 100, 100, 500, 400 }, true, false, false, true, new[] { "Window" }),
            new UiaNode(new[] { 42, 2 }, 1, 0, "Edit", "pw", "Password", "Edit", new[] { 110, 110, 300, 130 }, true, false, true, true, new[] { "Value" }),
        }, false, DateTimeOffset.UtcNow, null);
        public int Calls;
        public Task<(IReadOnlyList<UiElementInfo> Elements, string Status)> InspectWindowAsync(IntPtr hwnd, int timeoutMs = 300, int maxElements = 100, CancellationToken cancellationToken = default)
            => Task.FromResult(((IReadOnlyList<UiElementInfo>)Array.Empty<UiElementInfo>(), "Skipped"));
        public Task<UiaInspection> InspectTreeAsync(IntPtr hwnd, int maxDepth, int maxElements, int timeoutMs, CancellationToken cancellationToken = default)
        {
            Calls++;
            DuringInspect?.Invoke();
            return Task.FromResult(Result);
        }
    }

    private static JsonElement Args(object o) => JsonSerializer.SerializeToElement(o);
    private static JsonElement ToJson(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);

    private static DesktopReadService Service(FakeWindows w, FakeUia? u = null, Func<DateTimeOffset>? clock = null, DesktopReadOptions? o = null) =>
        new(w, u ?? new FakeUia(), o ?? new DesktopReadOptions(), clock);

    // ── A. identity rules ───────────────────────────────────────────────────

    [Fact]
    public void Identity_ZeroOrMissingMandatoryFields_AreRejected()
    {
        var ok = W(10, 100, "app.exe", "A");
        Assert.Null(WindowIdentityRules.Incomplete(ok));
        Assert.Equal("window handle is zero", WindowIdentityRules.Incomplete(ok with { Hwnd = 0 }));
        Assert.Equal("process id is zero", WindowIdentityRules.Incomplete(ok with { ProcessId = 0 }));
        Assert.Equal("process creation time unavailable", WindowIdentityRules.Incomplete(ok with { ProcessCreationFileTime = 0 }));
        Assert.NotNull(WindowIdentityRules.Incomplete(ok with { ImagePath = "" }));
        Assert.NotNull(WindowIdentityRules.Incomplete(ok with { WindowClass = " " }));
        Assert.Equal("logon session unavailable", WindowIdentityRules.Incomplete(ok with { SessionId = uint.MaxValue }));
    }

    [Fact]
    public void Identity_ProcessReplacement_HwndReuse_AndTitleChange()
    {
        var a = W(10, 100, "app.exe", "A");
        Assert.Null(WindowIdentityRules.Mismatch(a, a));
        Assert.Contains("no longer exists", WindowIdentityRules.Mismatch(a, null));
        // Same PID reused by a new process instance: the creation time differs.
        Assert.Contains("replaced", WindowIdentityRules.Mismatch(a, a with { ProcessCreationFileTime = T0 + 10_000_000 }));
        // The HWND value reused by another process / another window class / another thread.
        Assert.Contains("reused", WindowIdentityRules.Mismatch(a, a with { ProcessId = 200 }));
        Assert.Contains("reused", WindowIdentityRules.Mismatch(a, a with { WindowClass = "Other" }));
        Assert.Contains("reused", WindowIdentityRules.Mismatch(a, a with { ThreadId = 99 }));
        Assert.Contains("image", WindowIdentityRules.Mismatch(a, a with { ImagePath = @"C:\Other\app.exe" }));
        Assert.Contains("can no longer be established", WindowIdentityRules.Mismatch(a, a with { ProcessCreationFileTime = 0 }));
        // A title change is not an identity change.
        Assert.Null(WindowIdentityRules.Mismatch(a, a with { Title = "A (edited)" }));
    }

    // ── B. desktop read service (fake windows) ──────────────────────────────

    [Fact]
    public async Task List_ReportsIdentity_Display_AndExcludesDaskWindows()
    {
        var w = new FakeWindows { Incomplete = 1 };
        w.Windows.Add(W(10, 100, "app.exe", "Report.txt - App"));
        w.Windows.Add(W(11, 101, "hud-native.exe", "D-ASK"));
        w.Windows.Add(W(12, 102, "other.exe", "Other", display: 1, dpi: 144, primary: false) with { WindowDpi = 96 });
        var s = Service(w, o: new DesktopReadOptions { OwnProcessIds = () => new[] { 999 } });
        var r = await s.ExecuteAsync(DesktopReadService.ListWindows, Args(new { }), CancellationToken.None);
        Assert.Equal("ok", r.Status);
        var j = ToJson(r);
        var wins = j.GetProperty("windows").EnumerateArray().ToList();
        Assert.Equal(2, wins.Count);
        Assert.DoesNotContain(wins, x => x.GetProperty("process").GetString() == "hud-native.exe");
        Assert.Equal(1, j.GetProperty("excludedDaskWindows").GetInt32());
        Assert.Equal(1, j.GetProperty("excludedIncompleteIdentity").GetInt32());
        Assert.False(j.GetProperty("complete").GetBoolean()); // a skipped window makes the list incomplete
        var id = wins[0].GetProperty("identity");
        Assert.Equal(10, id.GetProperty("hwnd").GetInt64());
        Assert.Equal(100, id.GetProperty("pid").GetInt32());
        Assert.False(string.IsNullOrEmpty(id.GetProperty("processCreationTimeUtc").GetString()));
        // Mixed-DPI fixture: the second window is on a non-primary 150% display; physical bounds are reported unchanged.
        var d = wins[1].GetProperty("display");
        Assert.Equal(1, d.GetProperty("index").GetInt32());
        Assert.False(d.GetProperty("primary").GetBoolean());
        Assert.Equal(1.5, d.GetProperty("scale").GetDouble());
        // A DPI-unaware window on a 150% display: reported as scaled by Windows, never mistaken for a 100% display.
        Assert.Equal(96, wins[1].GetProperty("windowDpi").GetInt32());
        Assert.True(wins[1].GetProperty("dpiScaledByWindows").GetBoolean());
        Assert.Equal(new[] { 100, 100, 500, 400 }, wins[1].GetProperty("boundsPhysical").EnumerateArray().Select(x => x.GetInt32()));
    }

    [Fact]
    public async Task List_WithExcludedIncompleteIdentity_OrTruncation_IsNotComplete()
    {
        var w = new FakeWindows { Incomplete = 2 };
        w.Windows.Add(W(10, 100, "app.exe", "A"));
        var j = ToJson(await Service(w).ExecuteAsync(DesktopReadService.ListWindows, Args(new { }), CancellationToken.None));
        Assert.False(j.GetProperty("complete").GetBoolean());
        Assert.Contains("identity could not be established", j.GetProperty("incompleteReason").GetString());

        var w2 = new FakeWindows();
        for (int i = 0; i < 3; i++) w2.Windows.Add(W(10 + i, 100 + i, "app.exe", $"D{i}"));
        var t = ToJson(await Service(w2).ExecuteAsync(DesktopReadService.ListWindows, Args(new { limit = 1 }), CancellationToken.None));
        Assert.False(t.GetProperty("complete").GetBoolean());

        var full = ToJson(await Service(w2).ExecuteAsync(DesktopReadService.ListWindows, Args(new { }), CancellationToken.None));
        Assert.True(full.GetProperty("complete").GetBoolean());
        Assert.Equal(JsonValueKind.Null, full.GetProperty("incompleteReason").ValueKind);
    }

    [Fact]
    public async Task Inspect_UiaDataOutsideTheObservationWindow_IsStale()
    {
        var w = new FakeWindows();
        w.Windows.Add(W(10, 100, "app.exe", "A"));
        var old = new FakeUia();
        old.Result = old.Result with { InspectedAtUtc = DateTimeOffset.UtcNow - TimeSpan.FromMinutes(5) };
        var r = await Service(w, old).ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "app.exe" }), CancellationToken.None);
        Assert.Equal("observation_stale", r.Error!.Code);

        var future = new FakeUia();
        future.Result = future.Result with { InspectedAtUtc = DateTimeOffset.UtcNow + TimeSpan.FromMinutes(5) };
        Assert.Equal("observation_stale", (await Service(w, future).ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "app.exe" }), CancellationToken.None)).Error!.Code);

        var fresh = await Service(w).ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "app.exe" }), CancellationToken.None);
        var j = ToJson(fresh);
        Assert.True(DateTimeOffset.Parse(j.GetProperty("completedAtUtc").GetString()!) <= DateTimeOffset.Parse(j.GetProperty("expiresAtUtc").GetString()!));
    }

    [Fact]
    public async Task List_WindowThatDisappears_IsCounted_NotReported()
    {
        var w = new FakeWindows();
        w.Windows.Add(W(10, 100, "app.exe", "A"));
        w.Windows.Add(W(11, 101, "app.exe", "B"));
        w.Now[11] = null; // closed between enumeration and revalidation
        var j = ToJson(await Service(w).ExecuteAsync(DesktopReadService.ListWindows, Args(new { }), CancellationToken.None));
        Assert.Single(j.GetProperty("windows").EnumerateArray());
        Assert.Equal(1, j.GetProperty("disappeared").GetInt32());
    }

    [Fact]
    public async Task List_ProcessFilter_Limit_AndSensitiveTitles()
    {
        var w = new FakeWindows();
        for (int i = 0; i < 5; i++) w.Windows.Add(W(10 + i, 100 + i, "app.exe", $"Doc {i}"));
        w.Windows.Add(W(50, 500, "KeePass.exe", "Passwords.kdbx - KeePass"));
        var s = Service(w);
        var j = ToJson(await s.ExecuteAsync(DesktopReadService.ListWindows, Args(new { process = "app", limit = 2 }), CancellationToken.None));
        Assert.Equal(2, j.GetProperty("returned").GetInt32());
        Assert.Equal(5, j.GetProperty("total").GetInt32());
        Assert.True(j.GetProperty("truncated").GetBoolean());
        var all = ToJson(await s.ExecuteAsync(DesktopReadService.ListWindows, Args(new { }), CancellationToken.None)).GetRawText();
        Assert.DoesNotContain("Passwords.kdbx", all);
        Assert.Contains("[hidden: sensitive application]", all);
        // A title filter never matches a sensitive window's hidden title.
        var t = ToJson(await s.ExecuteAsync(DesktopReadService.ListWindows, Args(new { titleContains = "Passwords" }), CancellationToken.None));
        Assert.Empty(t.GetProperty("windows").EnumerateArray());
    }

    [Theory]
    [InlineData("{\"hwnd\":10}")]
    [InlineData("{\"pid\":100}")]
    [InlineData("{\"process\":\"app.exe\",\"sessionId\":\"s1\"}")]
    [InlineData("{\"process\":\"app.exe\",\"approvalId\":\"x\"}")]
    [InlineData("{\"process\":\"..\\\\..\\\\x\"}")]
    [InlineData("{\"process\":\"app.exe\",\"limit\":500}")]
    [InlineData("{\"titleContains\":\"\"}")]
    [InlineData("{\"process\":\"app.exe\",\"action\":\"close\"}")]
    public async Task Args_AnyIdentityOrUnknownField_IsRejected(string json)
    {
        var w = new FakeWindows();
        w.Windows.Add(W(10, 100, "app.exe", "A"));
        var s = Service(w);
        using var doc = JsonDocument.Parse(json);
        var r = await s.ExecuteAsync(DesktopReadService.ListWindows, doc.RootElement, CancellationToken.None);
        Assert.Equal("error", r.Status);
        Assert.Equal("invalid_args", r.Error!.Code);
    }

    [Fact]
    public async Task Inspect_RequiresASelector_AndAsksWhenAmbiguousOrMissing()
    {
        var w = new FakeWindows();
        w.Windows.Add(W(10, 100, "app.exe", "a.txt - App"));
        w.Windows.Add(W(11, 101, "app.exe", "b.txt - App"));
        var u = new FakeUia();
        var s = Service(w, u);
        var none = await s.ExecuteAsync(DesktopReadService.InspectWindow, Args(new { }), CancellationToken.None);
        Assert.Equal("invalid_args", none.Error!.Code);
        var amb = await s.ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "app.exe" }), CancellationToken.None);
        Assert.Equal("ambiguous_target", amb.Error!.Code);
        Assert.Contains("Which one do you mean?", amb.Error.Message);
        Assert.Equal(2, JsonSerializer.SerializeToElement(amb.Error.Candidates).GetArrayLength());
        var missing = await s.ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "nothere.exe" }), CancellationToken.None);
        Assert.Equal("target_not_found", missing.Error!.Code);
        Assert.Equal(0, u.Calls); // nothing was inspected for an ambiguous or missing target
        var one = await s.ExecuteAsync(DesktopReadService.InspectWindow, Args(new { titleContains = "b.txt" }), CancellationToken.None);
        Assert.Equal("ok", one.Status);
        Assert.Equal(11, ToJson(one).GetProperty("window").GetProperty("identity").GetProperty("hwnd").GetInt64());
    }

    [Fact]
    public async Task Inspect_SensitiveApplication_IsForbidden()
    {
        var w = new FakeWindows();
        w.Windows.Add(W(50, 500, "KeePass.exe", "db - KeePass"));
        var u = new FakeUia();
        var r = await Service(w, u).ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "KeePass.exe" }), CancellationToken.None);
        Assert.Equal("target_forbidden", r.Error!.Code);
        Assert.Equal(0, u.Calls);
    }

    [Fact]
    public async Task Inspect_WindowDisappearsOrIsReplaced_DuringInspection_IsReported()
    {
        var w = new FakeWindows();
        w.Windows.Add(W(10, 100, "app.exe", "A"));
        var u = new FakeUia { DuringInspect = () => w.Now[10] = null };
        var gone = await Service(w, u).ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "app.exe" }), CancellationToken.None);
        Assert.Equal("target_disappeared", gone.Error!.Code);

        var u2 = new FakeUia { DuringInspect = () => w.Now[10] = W(10, 100, "app.exe", "A", created: T0 + 1) };
        var replaced = await Service(w, u2).ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "app.exe" }), CancellationToken.None);
        Assert.Equal("target_changed", replaced.Error!.Code);

        var u3 = new FakeUia { DuringInspect = () => w.Now[10] = W(10, 200, "app.exe", "A") };
        var reused = await Service(w, u3).ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "app.exe" }), CancellationToken.None);
        Assert.Equal("target_changed", reused.Error!.Code);
        Assert.Contains("reused", reused.Error.Message);
    }

    [Fact]
    public async Task Inspect_TitleChange_IsReported_NotAnIdentityFailure()
    {
        var w = new FakeWindows();
        w.Windows.Add(W(10, 100, "app.exe", "Draft"));
        var u = new FakeUia { DuringInspect = () => w.Now[10] = W(10, 100, "app.exe", "Draft *") };
        var r = await Service(w, u).ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "app.exe" }), CancellationToken.None);
        Assert.Equal("ok", r.Status);
        var j = ToJson(r);
        Assert.True(j.GetProperty("titleChanged").GetBoolean());
        Assert.True(j.GetProperty("identityRevalidated").GetBoolean());
        Assert.False(j.GetProperty("atomic").GetBoolean());
    }

    [Fact]
    public async Task StaleObservation_IsRejected()
    {
        var w = new FakeWindows();
        w.Windows.Add(W(10, 100, "app.exe", "A"));
        var t = DateTimeOffset.UtcNow;
        int n = 0;
        DateTimeOffset Clock() => n++ == 0 ? t : t + TimeSpan.FromSeconds(30);
        var list = await Service(w, clock: Clock).ExecuteAsync(DesktopReadService.ListWindows, Args(new { }), CancellationToken.None);
        Assert.Equal("observation_stale", list.Error!.Code);
        n = 0;
        var insp = await Service(w, clock: Clock).ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "app.exe" }), CancellationToken.None);
        Assert.Equal("observation_stale", insp.Error!.Code);
    }

    [Fact]
    public async Task UiaFailure_IsReported_NotFabricated()
    {
        var w = new FakeWindows();
        w.Windows.Add(W(10, 100, "app.exe", "A"));
        var u = new FakeUia { Result = new UiaInspection("timeout", Array.Empty<UiaNode>(), false, DateTimeOffset.UtcNow, "UI Automation did not answer") };
        var j = ToJson(await Service(w, u).ExecuteAsync(DesktopReadService.InspectWindow, Args(new { process = "app.exe" }), CancellationToken.None));
        Assert.Equal("timeout", j.GetProperty("uia").GetProperty("status").GetString());
        Assert.Equal(0, j.GetProperty("uia").GetProperty("elementCount").GetInt32());
    }

    [Fact]
    public async Task UnknownTool_AndCancellation()
    {
        var s = Service(new FakeWindows());
        Assert.Equal("unknown_tool", (await s.ExecuteAsync("desktop.click", Args(new { }), CancellationToken.None)).Error!.Code);
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var w = new FakeWindows();
        w.Windows.Add(W(10, 100, "app.exe", "A"));
        Assert.Equal("cancelled", (await Service(w).ExecuteAsync(DesktopReadService.ListWindows, Args(new { }), cts.Token)).Status);
    }

    [Fact]
    public void DesktopReadService_ExposesOnlyReadOnlyTools()
    {
        var s = Service(new FakeWindows());
        Assert.Equal(new[] { "desktop.list_windows", "desktop.inspect_window" }, s.Tools);
        // The service has no dependency through which it could act: only a window reader and a UIA reader.
        var ctorParams = typeof(DesktopReadService).GetConstructors().Single().GetParameters().Select(p => p.ParameterType).ToList();
        Assert.DoesNotContain(ctorParams, t => t.Name.Contains("Execution") || t.Name.Contains("Input") || t.Name.Contains("Policy"));
    }

    // ── C. observation capture failure (Blit seam; no real screen is read) ──

    private sealed class BlitService : Win32ScreenObservationService
    {
        private readonly bool _ok;
        public int Calls;
        public BlitService(ObservationBufferManager b, IUiAutomationService u, bool ok) : base(b, u) => _ok = ok;
        protected override bool Blit(IntPtr hdcDest, int width, int height, IntPtr hdcSrc, int x, int y, int rop) { Calls++; return _ok; }
    }

    [Fact]
    public async Task Capture_Failure_IsNeverReportedAsSuccess_AndPublishesNoImage()
    {
        using var buffers = new ObservationBufferManager();
        var svc = new BlitService(buffers, new FakeUia(), ok: false);
        var r = await svc.CaptureAsync(new CaptureObservationRequest { IncludeUiAutomation = false, GeneratePreviewThumbnail = true, TargetDisplayIndex = 0, TargetHwnd = null });
        Assert.Equal(2, svc.Calls); // both capture modes were tried and both results checked
        Assert.False(r.Success);
        Assert.Equal("Failed", r.Status);
        Assert.Equal("CaptureFailed", r.RejectionCode);
        Assert.Equal("failed", r.CaptureStatus);
        Assert.True(string.IsNullOrEmpty(r.SharedMemoryName));
        Assert.Null(r.TargetHandle);
        Assert.Null(r.PreviewThumbnailBase64);
        Assert.Equal(0, r.DataSizeBytes);
        Assert.False(r.IsAtomic);
        Assert.True(r.ExpiresAtUtc > r.CapturedAtUtc);
    }

    [Fact]
    public async Task Capture_Success_CarriesFreshnessFields()
    {
        using var buffers = new ObservationBufferManager();
        var svc = new BlitService(buffers, new FakeUia(), ok: true); // pretends to copy; the real screen is not read
        var r = await svc.CaptureAsync(new CaptureObservationRequest { IncludeUiAutomation = false, TargetDisplayIndex = 0 });
        Assert.True(r.Success);
        Assert.Equal("ok", r.CaptureStatus);
        Assert.Equal("Skipped", r.UiaStatus);
        Assert.Null(r.UiaInspectedAtUtc);
        Assert.False(r.IsAtomic);
        Assert.Equal(Win32ScreenObservationService.ObservationMaxAge, r.ExpiresAtUtc - r.CapturedAtUtc);
    }

    // ── D. real windows (disposable fixture process; allowlisted) ───────────

    internal sealed class Fixture : IDisposable
    {
        public Process Process { get; }
        public long Hwnd { get; }
        public string Title { get; }
        public const string Secret = "dask-fixture-secret-7b1b";
        public Fixture(string title, int x = 40, int y = 40)
        {
            Title = title;
            string script = Path.Combine(Root, "tests", "DAsk.Daemon.Tests", "Fixtures", "desktop-fixture.ps1");
            var psi = new ProcessStartInfo("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{script}\" -Title \"{title}\" -Secret \"{Secret}\" -X {x} -Y {y}")
            { RedirectStandardOutput = true, RedirectStandardInput = true, UseShellExecute = false, CreateNoWindow = true };
            Process = Process.Start(psi)!;
            var line = Process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
            Assert.True(line != null && line.StartsWith("READY "), $"fixture did not start: {line}");
            Hwnd = long.Parse(line!["READY ".Length..]);
            Assert.NotEqual(0, Hwnd);
        }
        public void Dispose()
        {
            try { if (!Process.HasExited) { Process.Kill(); Process.WaitForExit(5000); } } catch { }
            Process.Dispose();
        }
    }

    [Fact]
    public async Task Real_FixtureWindow_ListInspect_Identity_Password_AndBounds()
    {
        using var fx = new Fixture($"D-ASK Fixture {Guid.NewGuid():N}"[..30]);
        var source = new Win32WindowSource();
        using var uia = new WindowsUiAutomationService();
        var opts = new DesktopReadOptions { AllowedProcessIds = new HashSet<int> { fx.Process.Id } };
        var s = new DesktopReadService(source, uia, opts);

        // Identity independently resolved from the OS.
        var id = source.Read(fx.Hwnd);
        Assert.NotNull(id);
        Assert.Null(WindowIdentityRules.Incomplete(id!));
        Assert.Equal(fx.Process.Id, id!.ProcessId);
        Assert.EndsWith("powershell.exe", id.ImagePath, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("DAskDesktopFixture", id.WindowClass);
        Assert.Equal(fx.Process.StartTime.ToUniversalTime().ToFileTimeUtc() / 10_000_000, id.ProcessCreationFileTime / 10_000_000);
        Assert.False(id.Foreground); // the fixture is shown without activation: nothing took focus
        Assert.True(id.DisplayIndex >= 0 && id.Dpi >= 96);
        _output.WriteLine($"fixture display dpi {id.Dpi}, window dpi {id.WindowDpi}, physical bounds {string.Join(",", id.Bounds)}");
        // The fixture (powershell.exe) is DPI-unaware: on a scaled display its own DPI is 96 while the display's is not.
        Assert.True(id.WindowDpi <= id.Dpi);

        var list = await s.ExecuteAsync(DesktopReadService.ListWindows, Args(new { }), CancellationToken.None);
        Assert.Equal("ok", list.Status);
        var lj = ToJson(list);
        var only = Assert.Single(lj.GetProperty("windows").EnumerateArray()); // the allowlist admits the fixture only
        Assert.Equal(fx.Title, only.GetProperty("title").GetString());
        _output.WriteLine(lj.GetRawText());

        var insp = await s.ExecuteAsync(DesktopReadService.InspectWindow, Args(new { titleContains = fx.Title }), CancellationToken.None);
        Assert.Equal("ok", insp.Status);
        var ij = ToJson(insp);
        string raw = ij.GetRawText();
        _output.WriteLine(raw);
        Assert.DoesNotContain(Fixture.Secret, raw); // the password value is never read
        var uiaEl = ij.GetProperty("uia");
        Assert.Contains(uiaEl.GetProperty("status").GetString(), new[] { "ok", "partial" });
        var els = uiaEl.GetProperty("elements").EnumerateArray().ToList();
        var button = Assert.Single(els, e => e.GetProperty("controlType").GetString() == "Button" && e.GetProperty("name").GetString() == "Fixture OK");
        Assert.Contains("Invoke", button.GetProperty("patterns").EnumerateArray().Select(p => p.GetString()));
        Assert.Equal(JsonValueKind.Array, button.GetProperty("runtimeId").ValueKind);
        var b = button.GetProperty("boundsPhysical").EnumerateArray().Select(x => x.GetInt32()).ToArray();
        Assert.True(b[2] > b[0] && b[3] > b[1], "button bounds are a real rectangle");
        Assert.Contains(els, e => e.GetProperty("controlType").GetString() == "Edit" && e.GetProperty("isPassword").GetBoolean());
        Assert.True(ij.GetProperty("identityRevalidated").GetBoolean());
    }

    [Fact]
    public async Task Real_BoundedUia_And_ProcessReplacement()
    {
        string title = $"D-ASK Bounded {Guid.NewGuid():N}"[..30];
        using var uia = new WindowsUiAutomationService();
        var source = new Win32WindowSource();
        WindowIdentity first;
        using (var fx = new Fixture(title))
        {
            var s = new DesktopReadService(source, uia, new DesktopReadOptions { AllowedProcessIds = new HashSet<int> { fx.Process.Id }, UiaMaxElements = 2 });
            var j = ToJson(await s.ExecuteAsync(DesktopReadService.InspectWindow, Args(new { titleContains = title }), CancellationToken.None));
            Assert.True(j.GetProperty("uia").GetProperty("elementCount").GetInt32() <= 2);
            Assert.True(j.GetProperty("uia").GetProperty("truncated").GetBoolean());
            first = source.Read(fx.Hwnd)!;
        }
        // The fixture process ended: its identity can no longer be confirmed, so nothing may be reported for it.
        Assert.NotNull(WindowIdentityRules.Mismatch(first, source.Read(first.Hwnd)));
        using var fx2 = new Fixture(title);
        var second = source.Read(fx2.Hwnd)!;
        Assert.False(first.ProcessCreationFileTime == second.ProcessCreationFileTime && first.ProcessId == second.ProcessId);
        Assert.NotNull(WindowIdentityRules.Mismatch(first, second with { Hwnd = first.Hwnd }));
    }

    [Fact]
    public async Task Real_AllowlistAndOwnProcess_AreNeverObservedOutsideTheFixture()
    {
        using var fx = new Fixture($"D-ASK Allow {Guid.NewGuid():N}"[..30]);
        using var uia = new WindowsUiAutomationService();
        var s = new DesktopReadService(new Win32WindowSource(), uia, new DesktopReadOptions { AllowedProcessIds = new HashSet<int> { fx.Process.Id }, OwnProcessIds = () => new[] { fx.Process.Id } });
        // When the fixture is treated as D-ASK's own process it is excluded, so nothing at all is observable.
        var j = ToJson(await s.ExecuteAsync(DesktopReadService.ListWindows, Args(new { }), CancellationToken.None));
        Assert.Empty(j.GetProperty("windows").EnumerateArray());
        Assert.Equal(1, j.GetProperty("excludedDaskWindows").GetInt32());
    }

    // ── E. protocol v2 over the real stdio pipes (fake read service; no desktop access) ──

    internal sealed class FakeDesktop : IDesktopReadService
    {
        public IReadOnlyList<string> Tools { get; } = new[] { "desktop.list_windows", "desktop.inspect_window" };
        public int Executed;
        public bool SawCancellation;
        public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, CancellationToken ct)
        {
            Interlocked.Increment(ref Executed);
            if (args.TryGetProperty("process", out var p) && p.GetString() == "slow.exe")
            {
                try { await Task.Delay(10_000, ct); }
                catch (OperationCanceledException) { SawCancellation = true; return DesktopCallResult.Cancelled(); }
            }
            return DesktopCallResult.Ok(new { tool, complete = true, windows = Array.Empty<object>() });
        }
    }

    internal static object Call(string id, object? args = null, string tool = "desktop.list_windows", string task = "$TASK", int? deadline = null) =>
        deadline is int d
            ? new { line = new { v = 2, kind = "call", callId = id, taskId = task, tool, args = args ?? new { }, deadlineMs = d } }
            : new { line = new { v = 2, kind = "call", callId = id, taskId = task, tool, args = args ?? new { } } };

    /// <summary>Script step: wait until n replies have arrived ("await" is reserved in async C#).</summary>
    internal static Dictionary<string, object> Await(int n) => new() { ["await"] = n };

    private static AgentHostManager ProtoManager(FakeDesktop d, object[] script, string hello = "echo", int settle = 300) =>
        new(Microsoft.Extensions.Options.Options.Create(AgentHostManagerTests.Options(ProtoHost, o =>
        {
            o.ExtraEnvironment["DASK_DESKTOP_HELLO"] = hello;
            o.ExtraEnvironment["DASK_DESKTOP_SCRIPT"] = JsonSerializer.Serialize(script);
            o.ExtraEnvironment["DASK_DESKTOP_SETTLE"] = settle.ToString();
        })), NullLogger<AgentHostManager>.Instance, null, null, d);

    private static async Task<List<JsonElement>> RunScriptAsync(AgentHostManager m)
    {
        var ok = await m.SubmitAsync("list windows", "s1");
        Assert.True(ok.Accepted, ok.ErrorMessage);
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            var r = m.GetTask(ok.TaskId!, "s1")?.Result;
            if (r != null)
            {
                Assert.False(r.Interrupted, "the host was not expected to be killed");
                return JsonDocument.Parse(r.Response).RootElement.EnumerateArray().Select(e => e.Clone()).ToList();
            }
            await Task.Delay(20);
        }
        throw new TimeoutException();
    }

    private static string Code(JsonElement reply) => reply.GetProperty("error").GetProperty("code").GetString()!;

    [Fact]
    public async Task Proto_ValidCall_IsAnsweredOnce_WithCorrelation()
    {
        var d = new FakeDesktop();
        await using var m = ProtoManager(d, new object[] { Call("c1"), Await(1), Call("c2", tool: "desktop.inspect_window", args: new { process = "a.exe" }) });
        var replies = await RunScriptAsync(m);
        Assert.Equal(2, replies.Count);
        Assert.All(replies, r => { Assert.Equal(2, r.GetProperty("v").GetInt32()); Assert.Equal("reply", r.GetProperty("kind").GetString()); });
        Assert.Equal(new[] { "c1", "c2" }, replies.Select(r => r.GetProperty("callId").GetString()).OrderBy(x => x));
        Assert.All(replies, r => Assert.Equal("ok", r.GetProperty("status").GetString()));
        Assert.Equal(2, d.Executed);
        Assert.True(m.DesktopEnabled);
    }

    [Fact]
    public async Task Proto_Duplicate_Unauthorized_WrongTask_Oversized_BadArgs_AreRefused_NotExecuted()
    {
        var d = new FakeDesktop();
        string big = new('x', 17 * 1024);
        await using var m = ProtoManager(d, new object[]
        {
            Call("c5"), Await(1),
            Call("c5"), Await(2),                                   // duplicate id
            Call("c3"), Await(3),                                   // not increasing
            Call("c6", tool: "desktop.click"), Await(4),            // not negotiated (actuation)
            Call("c7", tool: "system.exec"), Await(5),              // arbitrary daemon operation
            Call("c8", task: "someone-elses-task"), Await(6),       // not this host's running task
            Call("c9", args: new { pad = big }), Await(7),          // oversized
            new { line = new { v = 2, kind = "call", callId = "c10", taskId = "$TASK", tool = "desktop.list_windows", args = "x" } }, Await(8),
            Call("c11", deadline: 5), Await(9),                     // deadline below minimum
        });
        var r = await RunScriptAsync(m);
        string C(string id, int nth = 0) => Code(r.Where(x => x.GetProperty("callId").GetString() == id).ElementAt(nth));
        Assert.Equal("ok", r[0].GetProperty("status").GetString());
        Assert.Equal("duplicate_call", C("c5", 1));
        Assert.Equal("duplicate_call", C("c3"));
        Assert.Equal("unknown_tool", C("c6"));
        Assert.Equal("unknown_tool", C("c7"));
        Assert.Equal("task_not_running", C("c8"));
        Assert.Equal("message_too_large", C("c9"));
        Assert.Equal("invalid_args", C("c10"));
        Assert.Equal("invalid_args", C("c11"));
        Assert.Equal(1, d.Executed); // only the first, valid call ran
    }

    [Fact]
    public async Task Proto_Cancellation_Timeout_AndBusy()
    {
        var d = new FakeDesktop();
        await using var m = ProtoManager(d, new object[]
        {
            Call("c1", args: new { process = "slow.exe" }),
            Call("c2"),                                                      // busy: c1 still running
            new { sleep = 150 },
            new { line = new { v = 2, kind = "call.cancel", callId = "c1" } },
            Await(2),
            Call("c3", args: new { process = "slow.exe" }, deadline: 200),   // deadline
            Await(3),
        });
        var r = await RunScriptAsync(m);
        JsonElement R(string id) => r.Single(x => x.GetProperty("callId").GetString() == id);
        Assert.Equal("busy", Code(R("c2")));
        Assert.Equal("cancelled", R("c1").GetProperty("status").GetString());
        Assert.Equal("deadline_exceeded", Code(R("c3")));
        Assert.True(d.SawCancellation);
    }

    [Fact]
    public async Task Proto_RateLimited()
    {
        var d = new FakeDesktop();
        var script = new List<object>();
        for (int i = 1; i <= AgentHostManager.MaxCallsPerMinute + 1; i++) { script.Add(Call($"c{i}")); script.Add(Await(i)); }
        await using var m = ProtoManager(d, script.ToArray());
        var r = await RunScriptAsync(m);
        Assert.Equal("rate_limited", Code(r.Last()));
        Assert.Equal(AgentHostManager.MaxCallsPerMinute, d.Executed);
    }

    [Theory]
    [InlineData("v1-call")]
    [InlineData("v3-call")]
    [InlineData("session-field")]
    [InlineData("not-negotiated")]
    [InlineData("claim-extra")]
    [InlineData("malformed-cancel")]
    public async Task Proto_Violations_KillTheHost(string mode)
    {
        var d = new FakeDesktop();
        object step = mode switch
        {
            "v1-call" => new { line = new { v = 1, kind = "call", callId = "c1", taskId = "$TASK", tool = "desktop.list_windows", args = new { } } },
            "v3-call" => new { line = new { v = 3, kind = "call", callId = "c1", taskId = "$TASK", tool = "desktop.list_windows", args = new { } } },
            "session-field" => new { line = new { v = 2, kind = "call", callId = "c1", taskId = "$TASK", tool = "desktop.list_windows", args = new { }, sessionId = "s2" } },
            "malformed-cancel" => new { line = new { v = 2, kind = "call.cancel", callId = "c1", hwnd = 5 } },
            _ => Call("c1"),
        };
        await using var m = ProtoManager(d, new[] { step, new { sleep = 2000 } }, hello: mode == "not-negotiated" ? "none" : mode == "claim-extra" ? "claim-extra" : "echo");
        var ok = await m.SubmitAsync("list windows", "s1");
        if (mode == "claim-extra")
        {
            // The violation happens during hello: the host is refused before it can run anything.
            Assert.Equal(0, d.Executed);
            return;
        }
        Assert.True(ok.Accepted, ok.ErrorMessage);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        AgentTaskResultNotification? res = null;
        while (DateTime.UtcNow < deadline && (res = m.GetTask(ok.TaskId!, "s1")?.Result) == null) await Task.Delay(20);
        Assert.NotNull(res);
        Assert.True(res!.Interrupted);
        Assert.NotEqual("completed", res.Outcome);
        Assert.Contains("invalid protocol message", m.Health().LastError);
        Assert.Equal(0, d.Executed);
    }

    [Fact]
    public async Task Proto_HostExit_CancelsTheRunningCall()
    {
        var d = new FakeDesktop();
        await using var m = ProtoManager(d, new object[] { Call("c1", args: new { process = "slow.exe" }), new { sleep = 300 }, new { exit = 0 } });
        var ok = await m.SubmitAsync("list windows", "s1");
        Assert.True(ok.Accepted);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline && !d.SawCancellation) await Task.Delay(20);
        Assert.True(d.SawCancellation, "a disconnect must cancel the daemon-side operation");
        var res = m.GetTask(ok.TaskId!, "s1")?.Result;
        Assert.True(res == null || res.Outcome != "completed");
    }

    [Fact]
    public async Task Proto_DesktopDisabled_CallIsAViolation()
    {
        var d = new FakeDesktop();
        var o = AgentHostManagerTests.Options(ProtoHost, o =>
        {
            o.DesktopRead = false;
            o.ExtraEnvironment["DASK_DESKTOP_SCRIPT"] = JsonSerializer.Serialize(new object[] { Call("c1"), new { sleep = 2000 } });
        });
        await using var m = new AgentHostManager(Microsoft.Extensions.Options.Options.Create(o), NullLogger<AgentHostManager>.Instance, null, null, d);
        Assert.False(m.DesktopEnabled);
        var ok = await m.SubmitAsync("list windows", "s1");
        Assert.True(ok.Accepted);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        AgentTaskResultNotification? res = null;
        while (DateTime.UtcNow < deadline && (res = m.GetTask(ok.TaskId!, "s1")?.Result) == null) await Task.Delay(20);
        Assert.True(res!.Interrupted);
        Assert.Equal(0, d.Executed);
    }
}
