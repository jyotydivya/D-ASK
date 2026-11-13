using System.Runtime.InteropServices;
using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Daemon.State;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>
/// REAL Windows: the daemon's own launch service (real discovery, real activation, real window enumeration and UI Automation, real policy
/// engine, approvals, Emergency Stop and audit journal) opens installed applications by name and opens Settings at Display. The test plays
/// the HUD: it approves exactly the card the daemon delivered. Every window the test opened is closed again (WM_CLOSE) at the end.
/// Evidence: results/universal-control/&lt;stamp&gt;/acceptance.json.   Run with:  DASK_LIVE_APPS=1  --filter "FullyQualifiedName~UniversalAppLaunchLive"
/// </summary>
[Trait("Category", "UniversalAppsLive")]
[Collection("UniversalAppsLive")]   // sequential with the Office live test
public class UniversalAppLaunchLiveTests
{
    private const string Owner = "live-hud-session";
    private readonly ITestOutputHelper _out;
    public UniversalAppLaunchLiveTests(ITestOutputHelper o) => _out = o;

    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);

    public static bool Enabled => Environment.GetEnvironmentVariable("DASK_LIVE_APPS") == "1";

    [SkippableLiveFact]
    public async Task Live_OpenInstalledApplicationsAndSettings_StopAndResume()
    {
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        string outDir = Path.Combine(root, "results", "universal-control", DateTime.Now.ToString("yyyyMMddTHHmmss"));
        Directory.CreateDirectory(outDir);
        string db = Path.Combine(outDir, "audit.db");

        // Wi-Fi-off acceptance (scripts\hud\offline-universal-control-acceptance.ps1 sets DASK_LIVE_OFFLINE=1): offline-first, so web
        // search stays switched off and is expected to be REFUSED before Chrome is started.
        bool offline = Environment.GetEnvironmentVariable("DASK_LIVE_OFFLINE") == "1";
        var os = new Win32WindowSource();
        var recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, db);
        await recorder.InitializeAsync();
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, recorder, os);
        policy.SetSessionLivenessGate(_ => true);
        var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, new StateManager(NullLogger<StateManager>.Instance), policy, recorder);
        engine.SetPanicHotkeyStatus(true, "live test", 0);
        var cards = new List<ActionApprovalRequest>();
        policy.ApprovalRequested += (_, r) => Task.Run(async () =>
        {
            lock (cards) cards.Add(r);
            await Task.Delay(150);   // the test plays the HUD: it approves exactly what was delivered
            policy.SubmitApprovalDecision(new ActionApprovalResponse
            {
                ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                ActionDigest = r.ActionDigest, Approved = true, DecisionSource = "UserExplicitConfirmation",
            }, Owner, () => engine.IsEmergencyStopped, () => engine.CurrentStopGeneration);
        });
        using var uia = new WindowsUiAutomationService();
        var reader = new DesktopReadService(os, uia, new DesktopReadOptions());
        var registry = new LaunchedWindowRegistry();
        var catalog = new InstalledAppCatalog(new Win32InstalledAppSource());
        var service = new AppLaunchRequestService(reader, policy, () => engine.IsEmergencyStopped, () => engine.CurrentStopGeneration, recorder, _ => true,
            new AppLaunchOptions { Enabled = true, Catalog = catalog, WaitForAppWindowMs = 45_000, ApprovalTtl = TimeSpan.FromSeconds(30), WebSearchAllowed = !offline }, registry);

        var steps = new List<object>();
        var opened = new List<(long Hwnd, int Pid, string App)>();
        int n = 0;
        async Task<DesktopCallResult> Step(string request, string tool, object args)
        {
            int before; lock (cards) before = cards.Count;
            string task = $"live-{++n}";
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var res = await service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext(task, $"c{n}", Owner), CancellationToken.None);
            ActionApprovalRequest? card; lock (cards) card = cards.Count > before ? cards[^1] : null;
            if (res.Status == "ok" && registry.For(task) is { } w) opened.Add((w.Hwnd, w.ProcessId, w.ImageName));
            var entry = new
            {
                request, capability = tool, args, ms = sw.ElapsedMilliseconds,
                approval = card == null ? "no approval card (low risk or refused before asking)" : $"approved by the test acting as the HUD: {card.ActionParameters.GetValueOrDefault("operation")} → {card.ActionParameters.GetValueOrDefault("target")}",
                osOperation = card?.ActionParameters.GetValueOrDefault("target") ?? (tool == AppLaunchRequestService.OpenSettings ? "ms-settings protocol activation" : tool),
                status = res.Status, error = res.Error, result = res.Result,
            };
            steps.Add(entry);
            _out.WriteLine(JsonSerializer.Serialize(entry));
            return res;
        }

        try
        {
            var word = await Step("Open Microsoft Word.", AppLaunchRequestService.Launch, new { app = "Microsoft Word" });
            var chrome = await Step("Open Chrome.", AppLaunchRequestService.Launch, new { app = "chrome" });
            var code = await Step("Open VS Code.", AppLaunchRequestService.Launch, new { app = "VS Code" });
            var excel = await Step("Open Excel.", AppLaunchRequestService.Launch, new { app = "Excel" });
            var search = await Step("Open Chrome and search for offline speech recognition.", AppLaunchRequestService.Launch, new { app = "chrome", search = "offline speech recognition" });
            var project = await Step("Open VS Code and inspect my project.", AppLaunchRequestService.Launch, new { app = "VS Code", folder = root });
            var settings = await Step("Open Windows Settings and navigate to Display.", AppLaunchRequestService.OpenSettings, new { page = "display" });
            var running = reader.SnapshotNow().Select(w => $"{w.ImageName}: {w.Title}").ToList();
            steps.Add(new { request = "Show me the currently running applications.", capability = DesktopReadService.ListWindows, osOperation = "EnumWindows (read-only)", status = "ok", result = running });

            // Emergency Stop: no new action until a valid, explicit resume.
            var stop = await engine.TriggerEmergencyStopAsync("LiveTest", "Stop the current action immediately.", sessionId: Owner);
            ulong gen = engine.CurrentStopGeneration;
            steps.Add(new { request = "Stop the current action immediately.", capability = "EmergencyStop", status = stop.Success ? "ok" : "error", result = new { stopped = engine.IsEmergencyStopped, generation = gen } });
            var blocked = await Step("Open Windows Terminal. (while stopped)", AppLaunchRequestService.Launch, new { app = "terminal" });
            var badResume = await engine.ResumeExecutionAsync("LiveTest", "resume without the right generation", gen + 7, sessionId: Owner);
            var resume = await engine.ResumeExecutionAsync("LiveTest", "Resume execution after explicit authorization.", gen, sessionId: Owner);
            steps.Add(new { request = "Resume execution after explicit authorization.", capability = "ResumeExecution", status = resume.Success ? "ok" : "error",
                result = new { wrongGenerationRefused = !badResume.Success, resumed = resume.Success, stoppedNow = engine.IsEmergencyStopped } });
            var terminal = await Step("Open Windows Terminal. (after resume)", AppLaunchRequestService.Launch, new { app = "terminal" });

            File.WriteAllText(Path.Combine(outDir, "acceptance.json"), JsonSerializer.Serialize(steps, new JsonSerializerOptions { WriteIndented = true }));
            _out.WriteLine($"Evidence: {outDir}");

            Assert.True(word.Status == "ok", "Word: " + word.Error?.Message);
            Assert.True(chrome.Status == "ok", "Chrome: " + chrome.Error?.Message);
            Assert.True(code.Status == "ok", "VS Code: " + code.Error?.Message);
            Assert.True(excel.Status == "ok", "Excel: " + excel.Error?.Message);
            if (offline) Assert.True(search.Error?.Code == "offline_mode", "Chrome search offline: expected the offline refusal, got " + (search.Error?.Code ?? search.Status));
            else Assert.True(search.Status == "ok", "Chrome search: " + search.Error?.Message);
            Assert.True(project.Status == "ok", "VS Code project: " + project.Error?.Message);
            Assert.True(settings.Status == "ok", "Settings: " + settings.Error?.Message);
            Assert.Equal("emergency_stopped", blocked.Error?.Code);
            Assert.False(badResume.Success);
            Assert.True(resume.Success, resume.ErrorMessage);
            Assert.True(terminal.Status == "ok", "Terminal: " + terminal.Error?.Message);
        }
        finally
        {
            // Deterministic cleanup: close exactly the windows this test opened, then wait (bounded) for their processes to end. A process
            // that does not end (e.g. Chrome or Word kept alive by the user's other windows) is reported, never killed: it may be the user's.
            var cleanup = System.Diagnostics.Stopwatch.StartNew();
            foreach (var (h, _, _) in opened) PostMessage(new IntPtr(h), 0x0010 /* WM_CLOSE */, IntPtr.Zero, IntPtr.Zero);
            var survivors = new List<string>();
            foreach (var (h, pid, app) in opened)
            {
                bool gone = false;
                for (int i = 0; i < 40 && !gone; i++) { gone = os.Read(h) == null; if (!gone) await Task.Delay(250); }
                if (!gone) survivors.Add($"{app} window {h} (process {pid}) still open");
            }
            steps.Add(new { request = "(harness cleanup)", closedWindows = opened.Count, survivors, ms = cleanup.ElapsedMilliseconds });
            File.WriteAllText(Path.Combine(outDir, "acceptance.json"), JsonSerializer.Serialize(steps, new JsonSerializerOptions { WriteIndented = true }));
            engine.Dispose();
            SqliteConnection.ClearAllPools();
            _out.WriteLine($"cleanup: closed {opened.Count} windows in {cleanup.ElapsedMilliseconds} ms; still open: {(survivors.Count == 0 ? "none" : string.Join("; ", survivors))}");
        }
    }
}

/// <summary>A fact that runs only when DASK_LIVE_APPS=1 (it opens real applications on this computer).</summary>
public sealed class SkippableLiveFactAttribute : FactAttribute
{
    public SkippableLiveFactAttribute()
    {
        if (!UniversalAppLaunchLiveTests.Enabled) Skip = "Real Windows test: set DASK_LIVE_APPS=1 to run it (it opens Word, Excel, Chrome, VS Code, Terminal and Settings, then closes the windows it opened).";
    }
}
