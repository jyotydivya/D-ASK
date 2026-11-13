using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Universal application control: ANY application Windows registers (Start menu, App Paths, packaged apps, Windows tools) can be opened
/// by NAME, after approval of exactly what Windows will start; Windows Settings pages open as a low-risk, audited, gated action.
/// Decision logic with fakes (real policy engine, approval and audit journal); discovery against this computer (read-only); real launches
/// in <see cref="UniversalAppLaunchLiveTests"/> (DASK_LIVE_APPS=1).
/// </summary>
[Collection("AgentHost")]
public class UniversalAppLaunchTests
{
    private const string Owner = "hud-session-owner";

    internal sealed class FakeSource : IInstalledAppSource
    {
        public List<InstalledApp> Apps = new();
        public int Calls;
        public IReadOnlyList<InstalledApp> Discover() { Calls++; return Apps.ToList(); }
    }

    internal sealed class FakeActivator : IAppActivator
    {
        public readonly List<string> Started = new();
        public readonly List<string> Uris = new();
        public Action<InstalledApp>? OnStart;
        public Action<string>? OnUri;
        public Exception? Throw;
        public int? Pid;
        public InstalledApp? Last;
        public AppActivationResult Start(InstalledApp app)
        {
            if (Throw != null) throw Throw;
            Last = app;
            Started.Add(app.Target);
            OnStart?.Invoke(app);
            return new AppActivationResult(Pid, false);
        }
        public void OpenSettingsUri(string uri) { Uris.Add(uri); OnUri?.Invoke(uri); }
        public readonly List<long> Fronted = new();
        public void BringToFront(long hwnd) => Fronted.Add(hwnd);
    }

    private static InstalledApp Exe(string name, string exe, string source = "start-menu", string? args = null) =>
        new(name, InstalledApp.KindExe, $@"C:\Apps\{exe}", args, @"C:\Apps", null, source);
    private static InstalledApp Pkg(string name, string aumid) => new(name, InstalledApp.KindPackaged, null, null, null, aumid, "packaged");

    internal static List<InstalledApp> Sample() => new()
    {
        Exe("Word", "WINWORD.EXE"), Exe("Excel", "EXCEL.EXE"), Exe("PowerPoint", "POWERPNT.EXE"),
        Exe("Google Chrome", "chrome.exe"), Exe("Microsoft Edge", "msedge.exe"),
        Exe("Visual Studio Code", "Code.exe"), Exe("Visual Studio 2022", "devenv.exe"), Exe("Visual Studio Installer", "setup.exe"),
        Exe("Command Prompt", "cmd.exe", "windows"), Exe("Windows PowerShell", "powershell.exe", "windows"), Exe("File Explorer", "explorer.exe", "windows"),
        Exe("Microsoft Word", "WINWORD.EXE", "app-paths"),
        Pkg("Settings", "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel"),
        Pkg("Terminal", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"),
    };

    private sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly AppLaunchRequestService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly Phase7B1bTests.FakeWindows Windows = new();
        public readonly Phase7B1bTests.FakeUia Uia = new();
        public readonly FakeSource Source = new() { Apps = Sample() };
        public readonly FakeActivator Activator = new();
        public readonly LaunchedWindowRegistry Registry = new();
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly HashSet<string> Live = new() { Owner };
        public bool Stopped;
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-ulaunch-{Guid.NewGuid():N}.db");

        public Rig(bool catalog = true, int waitMs = 800, bool webSearch = false)
        {
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder, Windows);
            Policy.SetSessionLivenessGate(s => Live.Contains(s));
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Windows.Windows.Add(Phase7B1bTests.W(900, 4000, "chrome.exe", "Some page - Chrome"));
            var reader = new DesktopReadService(Windows, Uia, new DesktopReadOptions());
            Service = new AppLaunchRequestService(reader, Policy, () => Stopped, () => 1, Recorder, s => Live.Contains(s),
                new AppLaunchOptions
                {
                    Enabled = true, WaitForWindowMs = waitMs, WaitForAppWindowMs = waitMs, PollMs = 20, ApprovalTtl = TimeSpan.FromSeconds(10),
                    SystemDirectoryOverride = Path.GetTempPath(), Catalog = catalog ? new InstalledAppCatalog(Source) : null, Activator = Activator, WebSearchAllowed = webSearch,
                }, Registry);
        }

        public Task<DesktopCallResult> Call(string tool, object args, string task = "t1") =>
            Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext(task, "c1", Owner), default);

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

        public async Task<(DesktopCallResult res, ActionApprovalRequest req)> Launch(string name, bool approve = true, Action? afterApproval = null)
        {
            lock (Delivered) Delivered.Clear();
            var call = Call(AppLaunchRequestService.Launch, new { app = name });
            var r = await DeliveredAsync();
            if (r == null) { var early = call.IsCompleted ? await call : null; throw new TimeoutException($"no approval reached the HUD ({early?.Error?.Code}: {early?.Error?.Message})"); }
            afterApproval?.Invoke();
            Assert.True(Decide(r, approve));
            return (await call, r);
        }

        public async Task<List<string>> Events() => (await Recorder.GetSafetyAuditRecordsAsync(200)).Select(e => e.EventType).Reverse().ToList();
        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(_db); } catch { } }
    }

    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);

    // ── name resolution ───────────────────────────────────────────────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("Microsoft Word", "Word")]
    [InlineData("word", "Word")]
    [InlineData("the Excel app", "Excel")]
    [InlineData("chrome", "Google Chrome")]
    [InlineData("Google Chrome", "Google Chrome")]
    [InlineData("edge", "Microsoft Edge")]
    [InlineData("VS Code", "Visual Studio Code")]
    [InlineData("vscode", "Visual Studio Code")]
    [InlineData("cmd", "Command Prompt")]
    [InlineData("PowerShell", "Windows PowerShell")]
    [InlineData("file explorer", "File Explorer")]
    [InlineData("Windows Settings", "Settings")]
    [InlineData("terminal", "Terminal")]
    [InlineData("powerpoint", "PowerPoint")]
    public void Resolve_FindsExactlyTheNamedApplication(string spoken, string expected)
    {
        var catalog = new InstalledAppCatalog(new FakeSource { Apps = Sample() });
        var r = catalog.Resolve(spoken);
        Assert.Null(r.Problem);
        Assert.Equal(expected, r.App!.Name);
    }

    [Fact]
    public void Resolve_NeverGuesses_AmbiguityAndAbsenceAreReported_AndDuplicatesPreferTheStartMenu()
    {
        var source = new FakeSource { Apps = Sample() };
        var catalog = new InstalledAppCatalog(source);
        var amb = catalog.Resolve("visual studio");
        Assert.Null(amb.App);
        Assert.Equal(new[] { "Visual Studio 2022", "Visual Studio Code", "Visual Studio Installer" }, amb.Candidates.OrderBy(x => x).ToArray());
        var none = catalog.Resolve("photoshop");
        Assert.Null(none.App);
        Assert.Empty(none.Candidates);
        Assert.Equal(2, source.Calls);   // absent: Windows is asked once more before saying so
        // "Microsoft Word" (App Paths) and "Word" (Start menu) normalize alike: the Start-menu shortcut wins.
        Assert.Equal("start-menu", catalog.Resolve("word").App!.Source);
        Assert.Single(catalog.All(), a => InstalledAppCatalog.Normalize(a.Name) == "word");
    }

    [Theory]
    [InlineData(@"C:\Windows\System32\cmd.exe")]
    [InlineData("cmd.exe")]
    [InlineData("notepad.lnk")]
    [InlineData("word\"; del *")]
    [InlineData("C:word")]
    public async Task PathsFilesAndCommands_AreNeverNames_EvenWithTheCatalog(string app)
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var res = await rig.Call(AppLaunchRequestService.Launch, new { app });
        Assert.Equal("invalid_args", res.Error!.Code);
        Assert.Empty(rig.Delivered);
        Assert.Empty(rig.Activator.Started);
    }

    [Fact]
    public async Task ANameIsOnlyEverLookedUp_NeverExecuted()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var res = await rig.Call(AppLaunchRequestService.Launch, new { app = "calc & whoami" });
        Assert.Equal("app_not_found", res.Error!.Code);
        Assert.Empty(rig.Delivered);
        Assert.Empty(rig.Activator.Started);
    }

    // ── launching a discovered application ───────────────────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task AnyInstalledApp_IsOpenedAfterApprovalOfExactlyWhatWindowsStarts_AndVerifiedByItsNewWindow()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Activator.OnStart = _ => rig.Windows.Windows.Add(Phase7B1bTests.W(5100, 7100, "WINWORD.EXE", "Word"));
        var (res, req) = await rig.Launch("Microsoft Word");

        Assert.Equal("ok", res.Status);
        Assert.Equal(@"C:\Apps\WINWORD.EXE", req.ActionParameters["target"]);
        Assert.Equal("none", req.ActionParameters["arguments"]);
        Assert.Contains("UAC", req.ActionParameters["administrator"]);
        Assert.Equal(new[] { @"C:\Apps\WINWORD.EXE" }, rig.Activator.Started);
        var r = J(res);
        Assert.True(r.GetProperty("launched").GetBoolean() && r.GetProperty("verified").GetBoolean() && r.GetProperty("newWindow").GetBoolean());
        Assert.Equal(5100, rig.Registry.For("t1")!.Hwnd);
        var ev = await rig.Events();
        Assert.True(ev.IndexOf("AppLaunchAdmitted") >= 0 && ev.IndexOf("AppLaunchAdmitted") < ev.IndexOf("AppLaunchPerformed"), string.Join(",", ev));
    }

    [Fact]
    public async Task PackagedApp_IsActivatedByItsAppId_AndVerifiedByTheProcessWindowsReported()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Activator.Pid = 8800;
        rig.Activator.OnStart = _ => rig.Windows.Windows.Add(Phase7B1bTests.W(5200, 8800, "WindowsTerminal.exe", "Windows PowerShell"));
        var (res, req) = await rig.Launch("terminal");
        Assert.Equal("ok", res.Status);
        Assert.Equal("app Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", req.ActionParameters["target"]);
        Assert.Equal("Store / packaged app", req.ActionParameters["kind"]);
    }

    [Fact]
    public async Task AlreadyOpenSingleInstanceApp_BroughtToFront_IsVerifiedAsSuch()
    {
        using var rig = new Rig(waitMs: 4000);
        await rig.Recorder.InitializeAsync();
        rig.Windows.Windows.Add(Phase7B1bTests.W(5300, 9000, "ApplicationFrameHost.exe", "Settings"));
        rig.Activator.OnStart = _ =>
        {
            var w = rig.Windows.Windows.Single(x => x.Hwnd == 5300);
            rig.Windows.Windows.Remove(w);
            rig.Windows.Windows.Add(w with { Foreground = true });
        };
        var (res, _) = await rig.Launch("settings");
        Assert.Equal("ok", res.Status);
        Assert.False(J(res).GetProperty("newWindow").GetBoolean());
        Assert.Null(rig.Registry.For("t1"));   // not a window D-ASK opened: never a typing target by itself
    }

    [Fact]
    public async Task Declined_Ambiguous_Absent_Changed_Stopped_UacDeclined_Unverified_NothingIsClaimed()
    {
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            var (res, _) = await rig.Launch("excel", approve: false);
            Assert.Equal("approval_denied", res.Error!.Code);
            Assert.Empty(rig.Activator.Started);
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            var amb = await rig.Call(AppLaunchRequestService.Launch, new { app = "visual studio" });
            Assert.Equal("app_ambiguous", amb.Error!.Code);
            Assert.Contains("Visual Studio Code", amb.Error.Message);
            var none = await rig.Call(AppLaunchRequestService.Launch, new { app = "photoshop" });
            Assert.Equal("app_not_found", none.Error!.Code);
            Assert.Empty(rig.Delivered);
            Assert.Empty(rig.Activator.Started);
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            // Between approval and start, the registered program changed: what was approved is no longer what would start.
            var (res, _) = await rig.Launch("excel", afterApproval: () =>
                rig.Source.Apps[rig.Source.Apps.FindIndex(a => a.Name == "Excel")] = Exe("Excel", "EVIL.EXE"));
            Assert.Equal("target_changed", res.Error!.Code);   // Windows is read again right before starting
            Assert.Empty(rig.Activator.Started);
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            var (res, _) = await rig.Launch("excel", afterApproval: () => rig.Stopped = true);
            Assert.Equal("emergency_stopped", res.Error!.Code);
            Assert.Empty(rig.Activator.Started);
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            rig.Activator.Throw = new System.ComponentModel.Win32Exception(1223);
            var (res, _) = await rig.Launch("command prompt");
            Assert.Equal("elevation_declined", res.Error!.Code);
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            var (res, _) = await rig.Launch("powerpoint");   // started, but no window ever appears
            Assert.Equal("launch_unverified", res.Error!.Code);
            Assert.Contains("AppLaunchUnverified", await rig.Events());
        }
    }

    [Fact]
    public async Task WithoutTheCatalog_OnlyTheFixedListExists_AsBefore()
    {
        using var rig = new Rig(catalog: false);
        await rig.Recorder.InitializeAsync();
        Assert.Equal(new[] { AppLaunchRequestService.Launch }, rig.Service.Tools);
        var res = await rig.Call(AppLaunchRequestService.Launch, new { app = "word" });
        Assert.Equal("invalid_args", res.Error!.Code);
        Assert.Empty(rig.Activator.Started);
    }

    [Fact]
    public async Task ListApps_IsReadOnly_AndFilters()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        Assert.Contains(AppLaunchRequestService.ListApps, rig.Service.Tools);
        var res = await rig.Call(AppLaunchRequestService.ListApps, new { filter = "visual studio" });
        Assert.Equal("ok", res.Status);
        Assert.Equal(3, J(res).GetProperty("shown").GetInt32());
        Assert.Empty(rig.Delivered);
        Assert.Empty(rig.Activator.Started);
    }

    // ── what to open in the application: a web search (browsers) or an existing folder (VS Code, File Explorer) ──

    private async Task<(DesktopCallResult res, ActionApprovalRequest? card)> LaunchWith(Rig rig, object args)
    {
        lock (rig.Delivered) rig.Delivered.Clear();
        var call = rig.Call(AppLaunchRequestService.Launch, args);
        var card = await rig.DeliveredAsync(1500);
        if (card != null) rig.Decide(card, true);
        return (await call, card);
    }

    [Fact]
    public async Task Search_TheDaemonBuildsOneEncodedUrlArgument_ShownOnTheCard_AndVerifiedByTheResultsTitle()
    {
        using var rig = new Rig(webSearch: true);
        await rig.Recorder.InitializeAsync();
        rig.Activator.OnStart = _ => rig.Windows.Windows.Add(Phase7B1bTests.W(5500, 4000, "chrome.exe", "offline speech recognition & whisper - Google Search"));
        var (res, card) = await LaunchWith(rig, new { app = "chrome", search = "offline speech recognition & whisper" });
        Assert.Equal("ok", res.Status);
        const string url = "https://www.google.com/search?q=offline%20speech%20recognition%20%26%20whisper";
        Assert.Equal(url, card!.ActionParameters["opens"]);
        Assert.Equal($"\"{url}\"", rig.Activator.Last!.Arguments);   // ONE quoted argument; the words cannot become options
        Assert.Equal("Search the web in Google Chrome", card.ActionParameters["operation"]);
    }

    [Fact]
    public async Task OfflineMode_WebSearchIsRefusedBeforeAnythingHappens_OpeningTheBrowserItselfStillWorks()
    {
        using var rig = new Rig();   // the product default: web search switched off (offline-first)
        await rig.Recorder.InitializeAsync();
        var res = await rig.Call(AppLaunchRequestService.Launch, new { app = "chrome", search = "weather" });
        Assert.Equal("offline_mode", res.Error!.Code);
        Assert.Contains("needs internet access", res.Error.Message);
        Assert.Contains("open chrome itself", res.Error.Message);
        Assert.Empty(rig.Delivered);              // no approval card
        Assert.Empty(rig.Activator.Started);      // nothing started
        Assert.Equal(0, rig.Source.Calls);        // not even looked up
        // Opening the browser itself is not a web search: unaffected.
        rig.Activator.OnStart = _ => rig.Windows.Windows.Add(Phase7B1bTests.W(5800, 4100, "chrome.exe", "New Tab - Google Chrome"));
        var (open, _) = await LaunchWith(rig, new { app = "chrome" });
        Assert.Equal("ok", open.Status);
    }

    [Fact]
    public async Task Folder_OpensInVsCode_AndIsVerifiedByTheWindowTitle()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        string folder = Path.Combine(Path.GetTempPath(), $"dask-proj-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        try
        {
            rig.Activator.OnStart = _ => rig.Windows.Windows.Add(Phase7B1bTests.W(5600, 7700, "Code.exe", $"Welcome - {Path.GetFileName(folder)} - Visual Studio Code"));
            var (res, card) = await LaunchWith(rig, new { app = "VS Code", folder });
            Assert.Equal("ok", res.Status);
            Assert.Equal(folder, card!.ActionParameters["opens"]);
            Assert.Equal($"\"{folder}\"", rig.Activator.Last!.Arguments);
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public async Task Targets_InjectionWrongAppMissingFolderOrUnshownTarget_AreRefusedOrUnverified()
    {
        using var rig = new Rig(webSearch: true);
        await rig.Recorder.InitializeAsync();
        // A quote could end the argument and add browser options: refused before anything is asked.
        Assert.Equal("invalid_args", (await rig.Call(AppLaunchRequestService.Launch, new { app = "chrome", search = "x\" --remote-debugging-port=9222" })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Call(AppLaunchRequestService.Launch, new { app = "chrome", search = "a", folder = @"C:\" })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Call(AppLaunchRequestService.Launch, new { app = "excel", search = "budget" })).Error!.Code);   // not a browser
        Assert.Equal("invalid_args", (await rig.Call(AppLaunchRequestService.Launch, new { app = "chrome", folder = @"C:\Windows" })).Error!.Code);   // not a folder app
        Assert.Equal("invalid_args", (await rig.Call(AppLaunchRequestService.Launch, new { app = "VS Code", folder = @"C:\does\not\exist\anywhere" })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Call(AppLaunchRequestService.Launch, new { app = "VS Code", folder = @"relative\path" })).Error!.Code);
        Assert.Empty(rig.Delivered);
        Assert.Empty(rig.Activator.Started);

        // Started, but no window shows the search (e.g. offline): never reported as done.
        rig.Activator.OnStart = _ => rig.Windows.Windows.Add(Phase7B1bTests.W(5700, 4000, "chrome.exe", "No internet"));
        var (res, _) = await LaunchWith(rig, new { app = "chrome", search = "weather" });
        Assert.Equal("launch_unverified", res.Error!.Code);
        Assert.Contains("showing the search", res.Error.Message);
    }

    // ── Windows Settings pages (low risk) ────────────────────────────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("display", "ms-settings:display")]
    [InlineData("Display settings", "ms-settings:display")]
    [InlineData("screen", "ms-settings:display")]
    [InlineData("wi-fi", "ms-settings:network-wifi")]
    [InlineData("power and sleep", "ms-settings:powersleep")]
    [InlineData("", "ms-settings:")]
    public void SettingsPages_AreAFixedTable(string spoken, string uri) => Assert.Equal(uri, SettingsPages.Find(spoken)!.Value.Uri);

    [Fact]
    public async Task SettingsPage_OpensWithoutAnApprovalCard_AuditedFirst_AndVerifiedByThePageHeading()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Uia.Result = new UiaInspection("ok", new[]
        {
            new UiaNode(new[] { 1 }, 0, -1, "Window", "", "Settings", "", new[] { 0, 0, 800, 600 }, true, false, false, true, Array.Empty<string>()),
            new UiaNode(new[] { 2 }, 1, 0, "Text", "", "Display", "", new[] { 10, 10, 200, 40 }, true, false, false, false, Array.Empty<string>()),
        }, false, DateTimeOffset.UtcNow, null);
        rig.Activator.OnUri = _ => rig.Windows.Windows.Add(Phase7B1bTests.W(5400, 9100, "ApplicationFrameHost.exe", "Settings"));

        var res = await rig.Call(AppLaunchRequestService.OpenSettings, new { page = "display" });
        Assert.Equal("ok", res.Status);
        Assert.Equal(new[] { "ms-settings:display" }, rig.Activator.Uris);
        Assert.Empty(rig.Delivered);   // risk-based: no approval card for a page that changes nothing
        var ev = await rig.Events();
        Assert.True(ev.IndexOf("SettingsPageAdmitted") >= 0 && ev.IndexOf("SettingsPageAdmitted") < ev.IndexOf("SettingsPageOpened"), string.Join(",", ev));
    }

    [Fact]
    public async Task SettingsPage_UnknownStoppedNotLiveOrUnconfirmed_IsNotClaimed()
    {
        using var rig = new Rig(waitMs: 300);
        await rig.Recorder.InitializeAsync();
        Assert.Equal("invalid_args", (await rig.Call(AppLaunchRequestService.OpenSettings, new { page = "registry hacks" })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Call(AppLaunchRequestService.OpenSettings, new { page = "display", uri = "ms-settings:x" })).Error!.Code);
        rig.Stopped = true;
        Assert.Equal("emergency_stopped", (await rig.Call(AppLaunchRequestService.OpenSettings, new { page = "display" })).Error!.Code);
        rig.Stopped = false; rig.Live.Clear();
        Assert.Equal("hud_unavailable", (await rig.Call(AppLaunchRequestService.OpenSettings, new { page = "display" })).Error!.Code);
        Assert.Empty(rig.Activator.Uris);
    }

    [Fact]
    public void Policy_SettingsPagesAreLowRisk_LaunchesStayElevated()
    {
        var p = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance);
        Assert.Equal((true, ActionRiskLevel.LowRisk), Pick(p.EvaluatePolicy(DesktopActionTypes.OpenSettingsPage, new(), "x")));
        Assert.Equal((false, ActionRiskLevel.Elevated), Pick(p.EvaluatePolicy(DesktopActionTypes.AppLaunch, new(), "x")));
        static (bool, ActionRiskLevel) Pick((bool a, ActionRiskLevel r, string? _) t) => (t.a, t.r);
    }

    [Theory]
    [InlineData("WINWORD.EXE", "Document1 - Word", true)]
    [InlineData("WindowsTerminal.exe", @"C:\Apps\cmd.exe", true)]
    [InlineData("explorer.exe", "Control Panel", false)]
    public void IsWindowOf_MatchesProgramProcessOrName(string image, string title, bool expected)
    {
        var app = image == "explorer.exe" ? Exe("Word", "WINWORD.EXE") : image == "WindowsTerminal.exe" ? Exe("Command Prompt", "cmd.exe") : Exe("Word", "WINWORD.EXE");
        Assert.Equal(expected, AppLaunchRequestService.IsWindowOf(app, Phase7B1bTests.W(1, 2, image, title), null));
    }
}

/// <summary>
/// Live run 20261114T015224 regressions: (1) Terminal's new window is titled "Windows PowerShell" — a packaged app's windows are recognised
/// by its package identity; (2) VS Code inherited ELECTRON_RUN_AS_NODE=1 from the launching host, ran as headless Node.js and, holding the
/// parent's inherited output pipe, kept the parent alive — programs are started without handle inheritance and without host-private variables.
/// </summary>
public class LaunchRegressionTests
{
    private static readonly InstalledApp Terminal = new("Terminal", InstalledApp.KindPackaged, null, null, null, "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", "packaged");

    [Theory]
    [InlineData(@"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.24.12741.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe", true)]
    [InlineData(@"C:\Program Files\WindowsApps\Microsoft.WindowsTerminalPreview_1.24.1.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe", false)]
    [InlineData(@"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.24.1.0_x64__otherpublisher\WindowsTerminal.exe", false)]
    [InlineData(@"C:\Evil\WindowsApps-like\Microsoft.WindowsTerminal_1_x64__8wekyb3d8bbwe\x.exe", false)]
    [InlineData(@"C:\Windows\System32\conhost.exe", false)]
    [InlineData(@"C:\Users\x\WindowsApps\Microsoft.WindowsTerminal_1.24.1.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe", false)]
    [InlineData(@"D:\WindowsApps\Microsoft.WindowsTerminal_1.24.1.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe", true)]
    public void PackagedAppWindows_AreRecognisedByPackageIdentity(string imagePath, bool expected) =>
        Assert.Equal(expected, AppLaunchRequestService.IsInPackage(Terminal, imagePath));

    [Fact]
    public void TerminalWindowTitledWindowsPowerShell_IsTerminal()
    {
        var w = Phase7B1bTests.W(77, 4242, "WindowsTerminal.exe", "Windows PowerShell") with
            { ImagePath = @"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.24.12741.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe" };
        Assert.True(AppLaunchRequestService.IsWindowOf(Terminal, w, pid: 9999));
    }

    [Fact]
    public void ChildEnvironment_DropsHostPrivateVariables_KeepsTheRest()
    {
        var env = NativeLaunch.ChildEnvironment(new System.Collections.Hashtable
        {
            ["ELECTRON_RUN_AS_NODE"] = "1", ["VSCODE_IPC_HOOK"] = @"\\.\pipe\x", ["electron_no_attach_console"] = "1",
            ["PATH"] = @"C:\Windows", ["USERPROFILE"] = @"C:\Users\u", ["=C:"] = @"C:\",
        });
        Assert.Equal(new[] { "PATH", "USERPROFILE" }, env.Keys.ToArray());
    }

    [Fact]
    public async Task RealChildProcess_DoesNotReceiveElectronOrVsCodeVariables()
    {
        string dir = Path.Combine(Path.GetTempPath(), $"dask-env-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        string outFile = Path.Combine(dir, "env.txt");
        string? prevE = Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE"), prevV = Environment.GetEnvironmentVariable("VSCODE_TEST_MARKER");
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");
        Environment.SetEnvironmentVariable("VSCODE_TEST_MARKER", "x");
        Environment.SetEnvironmentVariable("DASK_TEST_MARKER", "kept");
        try
        {
            int pid = NativeLaunch.Start(Path.Combine(Environment.SystemDirectory, "cmd.exe"), $"/c set > \"{outFile}\"", dir);
            Assert.True(pid > 0);
            for (int i = 0; i < 100 && !(File.Exists(outFile) && new FileInfo(outFile).Length > 0); i++) await Task.Delay(50);
            await Task.Delay(200);
            string env = File.ReadAllText(outFile);
            Assert.Contains("DASK_TEST_MARKER=kept", env);
            Assert.DoesNotContain("ELECTRON_RUN_AS_NODE", env);
            Assert.DoesNotContain("VSCODE_TEST_MARKER", env);
        }
        finally
        {
            Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", prevE);
            Environment.SetEnvironmentVariable("VSCODE_TEST_MARKER", prevV);
            Environment.SetEnvironmentVariable("DASK_TEST_MARKER", null);
            try { Directory.Delete(dir, true); } catch { }
        }
    }
}

/// <summary>Read-only: what this Windows computer registers. Machine-dependent; prints what it found.</summary>
public class InstalledAppDiscoveryTests
{
    private readonly ITestOutputHelper _out;
    public InstalledAppDiscoveryTests(ITestOutputHelper o) => _out = o;

    [Fact]
    public void Discovery_FindsTheStartMenuAppPathsPackagedAndWindowsApplications()
    {
        var catalog = new InstalledAppCatalog(new Win32InstalledAppSource());
        var all = catalog.All();
        _out.WriteLine($"{all.Count} applications: " + string.Join(" | ", all.Select(a => $"{a.Name} [{a.Source}]")));
        Assert.True(all.Count >= 10, $"only {all.Count} applications discovered");
        Assert.Contains(all, a => a.Source == "windows");
        foreach (var name in new[] { "command prompt", "file explorer", "task manager", "settings" })
        {
            var r = catalog.Resolve(name);
            _out.WriteLine($"{name} -> {r.App?.Name} ({r.App?.Target}) {r.Problem}");
            Assert.NotNull(r.App);
        }
    }
}
