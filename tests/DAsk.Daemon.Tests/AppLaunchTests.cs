using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// desktop.launch_app: the agent names a known application (never a path or arguments); the daemon resolves the executable,
/// asks for approval of exactly that, starts it ONCE with no arguments, and reports success only when a fresh enumeration shows
/// exactly one NEW window of that application. Real policy engine, approval and audit; the process start and the window list are
/// fakes (the real Windows 11 Notepad was observed separately: notepad.exe is a stub that exits, the window is another process).
/// </summary>
[Collection("AgentHost")]
public class AppLaunchTests
{
    private const string Owner = "hud-session-owner";

    private sealed class FakeStarter : IAppProcessStarter
    {
        public readonly List<string> Started = new();
        public Action<Phase7B1bTests.FakeWindows>? OnStart;
        public Exception? Throw;
        private readonly Phase7B1bTests.FakeWindows _w;
        public FakeStarter(Phase7B1bTests.FakeWindows w) => _w = w;
        public void Start(string exePath, string workingDirectory)
        {
            if (Throw != null) throw Throw;
            Started.Add(exePath);
            OnStart?.Invoke(_w);
        }
    }

    private sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly AppLaunchRequestService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly Phase7B1bTests.FakeWindows Windows = new();
        public readonly FakeStarter Starter;
        public readonly LaunchedWindowRegistry Registry = new();
        public readonly DesktopReadService Reader;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly HashSet<string> Live = new() { Owner };
        public readonly string SysDir = Path.Combine(Path.GetTempPath(), $"dask-sys-{Guid.NewGuid():N}");
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-launch-{Guid.NewGuid():N}.db");

        public Rig(bool enabled = true, bool withAudit = true, bool createExe = true, int waitMs = 600)
        {
            Directory.CreateDirectory(SysDir);
            if (createExe) File.WriteAllText(Path.Combine(SysDir, "notepad.exe"), "stub");
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => Live.Contains(s));
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Windows.Windows.Add(Phase7B1bTests.W(900, 4000, "chrome.exe", "Some page - Chrome"));
            Starter = new FakeStarter(Windows);
            Reader = new DesktopReadService(Windows, new Phase7B1bTests.FakeUia(), new DesktopReadOptions());
            Service = new AppLaunchRequestService(Reader, Policy, () => false, () => 1, withAudit ? Recorder : null, s => Live.Contains(s),
                new AppLaunchOptions { Enabled = enabled, WaitForWindowMs = waitMs, PollMs = 20, ApprovalTtl = TimeSpan.FromSeconds(10), SystemDirectoryOverride = SysDir, Starter = Starter }, Registry);
        }

        public Task<DesktopCallResult> Ask(object args, string task = "t1", CancellationToken ct = default) =>
            Service.ExecuteAsync(AppLaunchRequestService.Launch, JsonSerializer.SerializeToElement(args), new DesktopActionContext(task, "c1", Owner), ct);

        public async Task<ActionApprovalRequest?> DeliveredAsync(int ms = 5000)
        {
            var until = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < until) { lock (Delivered) if (Delivered.Count > 0) return Delivered[^1]; await Task.Delay(5); }
            return null;
        }

        public bool Decide(ActionApprovalRequest r, bool approved) => Policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
            ActionDigest = r.ActionDigest, Approved = approved, DecisionSource = "UserExplicitConfirmation",
        }, Owner, () => false, () => 1);

        public async Task<(DesktopCallResult res, ActionApprovalRequest req)> Run(object args, bool approve = true, string task = "t1")
        {
            lock (Delivered) Delivered.Clear();
            var call = Ask(args, task);
            var r = await DeliveredAsync();
            if (r == null) { var early = call.IsCompleted ? await call : null; throw new TimeoutException($"no approval reached the HUD ({early?.Error?.Code}: {early?.Error?.Message})"); }
            Assert.True(Decide(r, approve));
            return (await call, r);
        }

        public async Task<List<string>> Events() => (await Recorder.GetSafetyAuditRecordsAsync(200)).Select(e => e.EventType).Reverse().ToList();
        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(_db); } catch { } try { Directory.Delete(SysDir, true); } catch { } }
    }

    private static readonly object Notepad = new { app = "notepad" };
    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);
    private static WindowIdentity NewNotepad(long hwnd = 5000, int pid = 7000, string title = "Untitled - Notepad", long created = 0) => Phase7B1bTests.W(hwnd, pid, "Notepad.exe", title, created);

    [Fact]
    public async Task Approved_StartsOnce_AndReportsOnlyTheNewWindow()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        // An unrelated Notepad the user already had open must never count as the launch.
        rig.Windows.Windows.Add(NewNotepad(hwnd: 111, pid: 6000, title: "old notes - Notepad"));
        rig.Starter.OnStart = w => w.Windows.Add(NewNotepad());
        var (res, req) = await rig.Run(Notepad);
        Assert.Equal("ok", res.Status);
        Assert.Equal("App.Launch", req.ActionType);
        Assert.Equal("Elevated", req.RiskLevel);
        Assert.Equal("Open Notepad", req.ActionParameters["operation"]);
        Assert.Equal("notepad.exe", req.ActionParameters["application"]);
        Assert.Equal(Path.Combine(rig.SysDir, "notepad.exe"), req.ActionParameters["executable"]);
        Assert.Equal("none", req.ActionParameters["arguments"]);
        Assert.Single(rig.Starter.Started);
        Assert.Equal(Path.Combine(rig.SysDir, "notepad.exe"), rig.Starter.Started[0]);
        var j = J(res);
        Assert.True(j.GetProperty("launched").GetBoolean());
        Assert.True(j.GetProperty("verified").GetBoolean());
        Assert.Equal("Untitled - Notepad", j.GetProperty("window").GetProperty("title").GetString());
        Assert.Equal(7000, j.GetProperty("window").GetProperty("pid").GetInt32());
        // The window is remembered for THIS task, so typing can be bound to it.
        Assert.Equal(5000, rig.Registry.For("t1")!.Hwnd);
        Assert.Null(rig.Registry.For("t2"));
        var ev = await rig.Events();
        Assert.Contains("AppLaunchRequested", ev); Assert.Contains("AppLaunchAdmitted", ev); Assert.Contains("AppLaunchPerformed", ev);
    }

    [Fact]
    public async Task Calculator_ConfirmedOnlyByANewCalculatorFrameWindow()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        File.WriteAllText(Path.Combine(rig.SysDir, "calc.exe"), "stub");
        // Another packaged app's frame window (same host image) and an older Calculator must not count.
        rig.Windows.Windows.Add(Phase7B1bTests.W(300, 3528, "ApplicationFrameHost.exe", "Settings"));
        rig.Windows.Windows.Add(Phase7B1bTests.W(301, 3528, "ApplicationFrameHost.exe", "Calculator"));
        rig.Starter.OnStart = w => { w.Windows.Add(Phase7B1bTests.W(302, 3528, "ApplicationFrameHost.exe", "Settings - Display")); w.Windows.Add(Phase7B1bTests.W(5374636, 3528, "ApplicationFrameHost.exe", "Calculator")); };
        var (res, req) = await rig.Run(new { app = "calculator" });
        Assert.Equal("ok", res.Status);
        Assert.Equal("Open Calculator", req.ActionParameters["operation"]);
        Assert.Equal("calc.exe", req.ActionParameters["application"]);
        Assert.Equal(Path.Combine(rig.SysDir, "calc.exe"), rig.Starter.Started.Single());
        Assert.Equal("Calculator", J(res).GetProperty("window").GetProperty("title").GetString());
        Assert.Equal(5374636, rig.Registry.For("t1")!.Hwnd);
    }

    [Fact]
    public async Task CharacterMap_Opens_AndUnknownAppsAreRefusedBeforeAnyApproval()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        File.WriteAllText(Path.Combine(rig.SysDir, "charmap.exe"), "stub");
        rig.Starter.OnStart = w => w.Windows.Add(Phase7B1bTests.W(6000, 8000, "charmap.exe", "Character Map"));
        var (res, req) = await rig.Run(new { app = "charmap" });
        Assert.Equal("ok", res.Status);
        Assert.Equal("Open Character Map", req.ActionParameters["operation"]);
        lock (rig.Delivered) rig.Delivered.Clear();
        var bad = await rig.Ask(new { app = "cmd" });
        Assert.Equal("error", bad.Status);
        Assert.Contains("notepad, calculator, charmap", bad.Error!.Message);
        Assert.Empty(rig.Delivered);
        Assert.Single(rig.Starter.Started);
    }

    [Fact]
    public async Task Denied_NothingIsStarted()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Starter.OnStart = w => w.Windows.Add(NewNotepad());
        var (res, _) = await rig.Run(Notepad, approve: false);
        Assert.Equal("error", res.Status);
        Assert.Equal("approval_denied", res.Error!.Code);
        Assert.Empty(rig.Starter.Started);
        Assert.Null(rig.Registry.For("t1"));
    }

    [Fact]
    public async Task NoNewWindow_IsNotReportedAsLaunched()
    {
        using var rig = new Rig(waitMs: 500);
        await rig.Recorder.InitializeAsync();
        rig.Windows.Windows.Add(NewNotepad(hwnd: 111, pid: 6000));      // already open
        rig.Starter.OnStart = _ => { };                                  // the start "worked" but nothing new appeared (e.g. a tab in the old window)
        var (res, _) = await rig.Run(Notepad);
        Assert.Equal("error", res.Status);
        Assert.Equal("launch_unverified", res.Error!.Code);
        Assert.Single(rig.Starter.Started);
        Assert.Null(rig.Registry.For("t1"));
        Assert.Contains("AppLaunchUnverified", await rig.Events());
    }

    [Fact]
    public async Task TwoNewWindows_AreAmbiguous_AndNotClaimed()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Starter.OnStart = w => { w.Windows.Add(NewNotepad(5000, 7000)); w.Windows.Add(NewNotepad(5001, 7001)); };
        var (res, _) = await rig.Run(Notepad);
        Assert.Equal("launch_ambiguous", res.Error!.Code);
        Assert.Null(rig.Registry.For("t1"));
    }

    [Fact]
    public async Task AnotherApplicationsNewWindow_IsNotTheLaunch()
    {
        using var rig = new Rig(waitMs: 400);
        await rig.Recorder.InitializeAsync();
        rig.Starter.OnStart = w => w.Windows.Add(Phase7B1bTests.W(5000, 7000, "slack.exe", "Notepad notes - Slack"));
        var (res, _) = await rig.Run(Notepad);
        Assert.Equal("launch_unverified", res.Error!.Code);
    }

    [Theory]
    [InlineData("{\"app\":\"cmd\"}")]
    [InlineData("{\"app\":\"C:\\\\Windows\\\\System32\\\\cmd.exe\"}")]
    [InlineData("{\"app\":\"notepad\",\"args\":\"C:\\\\secret.txt\"}")]
    [InlineData("{\"app\":\"notepad\",\"path\":\"C:\\\\x.exe\"}")]
    [InlineData("{\"app\":\"notepad\",\"command\":\"notepad C:\\\\x.txt\"}")]
    [InlineData("{}")]
    [InlineData("{\"app\":5}")]
    [InlineData("[\"notepad\"]")]
    public async Task UnknownAppsPathsAndExtraFields_AreRefusedBeforeAnythingIsAsked(string json)
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var res = await rig.Service.ExecuteAsync(AppLaunchRequestService.Launch, JsonDocument.Parse(json).RootElement, new DesktopActionContext("t1", "c1", Owner), default);
        Assert.Equal("error", res.Status);
        Assert.Equal("invalid_args", res.Error!.Code);
        Assert.Empty(rig.Delivered);
        Assert.Empty(rig.Starter.Started);
    }

    [Fact]
    public async Task OffByDefault_NotOffered_AndRefused()
    {
        using var off = new Rig(enabled: false);
        Assert.Empty(off.Service.Tools);
        var res = await off.Ask(Notepad);
        Assert.Equal("launch_disabled", res.Error!.Code);
        Assert.Empty(off.Delivered); Assert.Empty(off.Starter.Started);
        using var noAudit = new Rig(withAudit: false);
        Assert.Empty(noAudit.Service.Tools);
        using var on = new Rig();
        Assert.Equal(new[] { "desktop.launch_app" }, on.Service.Tools);
    }

    [Fact]
    public async Task MissingExecutable_IsRefusedBeforeAsking()
    {
        using var rig = new Rig(createExe: false);
        await rig.Recorder.InitializeAsync();
        var res = await rig.Ask(Notepad);
        Assert.Equal("app_unavailable", res.Error!.Code);
        Assert.Empty(rig.Delivered); Assert.Empty(rig.Starter.Started);
    }

    [Fact]
    public async Task StartFailure_IsReported_NotSuccess()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Starter.Throw = new InvalidOperationException("access denied");
        var (res, _) = await rig.Run(Notepad);
        Assert.Equal("launch_failed", res.Error!.Code);
        Assert.Contains("AppLaunchFailed", await rig.Events());
    }

    [Fact]
    public void PolicyNeverAutoAllowsALaunch()
    {
        using var rig = new Rig();
        var (allowed, risk, _) = rig.Policy.EvaluatePolicy(DesktopActionTypes.AppLaunch, new Dictionary<string, string>(), "notepad.exe");
        Assert.False(allowed);
        Assert.Equal(ActionRiskLevel.Elevated, risk);
    }

    [Fact]
    public void LaunchedWindow_IsResolvedOnlyWhileItIsTheSameWindow()
    {
        using var rig = new Rig();
        var w = NewNotepad();
        rig.Windows.Windows.Add(w);
        rig.Windows.Windows.Add(NewNotepad(111, 6000, "old notes - Notepad"));       // a second Notepad: the selector alone would be ambiguous
        Assert.NotNull(rig.Reader.ResolveLaunched(w.Hwnd, w.ProcessId, w.ProcessCreationFileTime, "notepad.exe", "Notepad"));
        Assert.Null(rig.Reader.ResolveLaunched(w.Hwnd, w.ProcessId + 1, w.ProcessCreationFileTime, "notepad.exe", "Notepad"));           // pid differs
        Assert.Null(rig.Reader.ResolveLaunched(w.Hwnd, w.ProcessId, w.ProcessCreationFileTime + 1, "notepad.exe", "Notepad"));           // pid reused
        Assert.Null(rig.Reader.ResolveLaunched(w.Hwnd, w.ProcessId, w.ProcessCreationFileTime, "chrome.exe", "Notepad"));                // selector no longer matches
        Assert.Null(rig.Reader.ResolveLaunched(w.Hwnd, w.ProcessId, w.ProcessCreationFileTime, "notepad.exe", "Something else"));
        rig.Windows.Now[w.Hwnd] = null;                                                                                                  // closed
        Assert.Null(rig.Reader.ResolveLaunched(w.Hwnd, w.ProcessId, w.ProcessCreationFileTime, "notepad.exe", "Notepad"));
    }
    [Theory]
    [InlineData("Untitled - Notepad", "*HE - Notepad", true)]               // what Notepad really does while text is typed
    [InlineData("*HE - Notepad", "*HELLO - Notepad", true)]
    [InlineData("Untitled - Notepad", "Untitled - Notepad", true)]
    [InlineData("Untitled - Notepad", "Untitled - Paint", false)]           // another application
    [InlineData("Untitled - Notepad", "Notepad", false)]                    // no document part: not the same shape
    [InlineData("Notepad", "Notepad - x", false)]
    [InlineData("Untitled - Ab", "x - Ab", false)]                          // a 2-character suffix proves nothing
    [InlineData("Home - Chrome", "Bank login - Firefox", false)]
    public void TitleMayFollowContent_OnlyWhileTheApplicationPartStaysTheSame(string before, string after, bool expected) =>
        Assert.Equal(expected, DAsk.Daemon.Automation.Input.GuardedInputRequestService.SameApplicationSuffix(before, after));
}
