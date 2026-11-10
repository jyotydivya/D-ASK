using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Input;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>Runs only when DASK_LIVE_INPUT=1: it moves the real pointer and types into a disposable fixture window.</summary>
public sealed class LiveInputFactAttribute : FactAttribute
{
    public LiveInputFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("DASK_LIVE_INPUT") != "1")
            Skip = "Real input test: set DASK_LIVE_INPUT=1 to run it (it clicks and types into a disposable fixture window; don't touch the mouse or keyboard).";
    }
}

/// <summary>
/// P1/P2 on the REAL OS: SendInput, low-level hooks, UI Automation focus/value, real window identity, the real policy
/// engine and audit journal. The only target is the disposable input fixture (its process id is the only one allowed).
/// The test plays the HUD (it approves). The fixture independently reports what it actually received.
/// </summary>
[Collection("AgentHost")]
public class GuardedInputLiveTests
{
    private readonly ITestOutputHelper _out;
    public GuardedInputLiveTests(ITestOutputHelper o) { _out = o; DpiCoordinateConverter.InitializeDpiAwareness(); }

    [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    private static string Root => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    private static string Sha(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s)));

    [LiveInputFact]
    [Trait("Category", "GuardedInputLive")]
    public async Task Live_Click_Type_Keys_OnTheFixture_AndForeignInputStopsTyping()
    {
        string title = $"DASK Input Fixture {Guid.NewGuid():N}"[..28];
        var lines = new ConcurrentQueue<string>();
        using var fx = Process.Start(new ProcessStartInfo("powershell.exe",
            $"-NoProfile -STA -ExecutionPolicy Bypass -File \"{Path.Combine(Root, "tests", "DAsk.Daemon.Tests", "Fixtures", "input-fixture.ps1")}\" -Title \"{title}\"")
            { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true })!;
        fx.OutputDataReceived += (_, e) => { if (e.Data != null) lines.Enqueue(e.Data); };
        fx.BeginOutputReadLine();
        string db = Path.Combine(Path.GetTempPath(), $"dask-input-live-{Guid.NewGuid():N}.db");
        try
        {
            async Task<string> WaitLine(string prefix, int ms = 15000)
            {
                var sw = Stopwatch.StartNew();
                while (sw.ElapsedMilliseconds < ms) { foreach (var l in lines) if (l.StartsWith(prefix, StringComparison.Ordinal)) return l; await Task.Delay(50); }
                throw new TimeoutException($"fixture never reported '{prefix}'. Lines: {string.Join(" | ", lines)}");
            }
            await WaitLine("READY");

            var recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, db);
            await recorder.InitializeAsync();
            var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, recorder);
            policy.SetSessionLivenessGate(_ => true);
            policy.ApprovalRequested += (_, r) => Task.Run(async () =>
            {
                await Task.Delay(200); // the test plays the HUD: it approves exactly what was delivered
                policy.SubmitApprovalDecision(new ActionApprovalResponse
                {
                    ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                    ActionDigest = r.ActionDigest, Approved = true, DecisionSource = "UserExplicitConfirmation",
                }, "live-session", () => false, () => 1);
            });
            using var uia = new WindowsUiAutomationService();
            var reader = new DesktopReadService(new Win32WindowSource(), uia, new DesktopReadOptions { AllowedProcessIds = new HashSet<int> { fx.Id } });
            Func<int, Task>? between = null;
            var service = new GuardedInputRequestService(reader, uia, policy, () => false, () => 1, recorder, _ => true, new Win32DesktopInputPlatform(),
                new GuardedInputOptions { MouseEnabled = true, KeyboardEnabled = true, InterEventDelayMs = 30, TestHookBetweenEvents = i => between?.Invoke(i) ?? Task.CompletedTask });
            var ctx = new DesktopActionContext("live-task", "c1", "live-session");
            Task<DesktopCallResult> Do(string tool, object args) => service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), ctx, CancellationToken.None);

            // 1. Click the button: the daemon verifies the label changed; the fixture independently reports one click.
            var click = await Do(GuardedInputTools.ClickElement, new { titleContains = title, element = new { controlType = "Button", automationId = "go" } });
            _out.WriteLine($"click: {click.Status} {JsonSerializer.Serialize(click.Result ?? click.Error)}");
            Assert.Equal("ok", click.Status);
            Assert.Equal("CLICKS 1", await WaitLine("CLICKS"));

            // 2. Type text: verified by exact insertion; the fixture reports exactly this text.
            const string text = "hello d-ask";
            var type = await Do(GuardedInputTools.TypeText, new { titleContains = title, element = new { controlType = "Edit", automationId = "notes" }, text });
            _out.WriteLine($"type: {type.Status} {JsonSerializer.Serialize(type.Result ?? type.Error)}");
            Assert.Equal("ok", type.Status);
            await WaitLine($"TEXT {text.Length} {Sha(text)}");

            // 3. A key chord: Backspace removes one character, verified by the value change.
            var keys = await Do(GuardedInputTools.PressKeys, new { titleContains = title, element = new { controlType = "Edit", automationId = "notes" }, keys = "Backspace" });
            _out.WriteLine($"keys: {keys.Status} {JsonSerializer.Serialize(keys.Result ?? keys.Error)}");
            Assert.Equal("ok", keys.Status);
            await WaitLine($"TEXT {text.Length - 1} {Sha(text[..^1])}");

            // 4. D-4: input injected by another program (no D-ASK marker) during typing stops the sequence before the next event.
            between = i => { if (i == 1) { keybd_event(0x87 /* F24: no effect in a text box */, 0, 0, UIntPtr.Zero); keybd_event(0x87, 0, 2, UIntPtr.Zero); Thread.Sleep(100); } return Task.CompletedTask; };
            var stopped = await Do(GuardedInputTools.TypeText, new { titleContains = title, element = new { controlType = "Edit", automationId = "notes" }, text = "XYZW" });
            between = null;
            _out.WriteLine($"interrupted: {stopped.Status} {JsonSerializer.Serialize(stopped.Error)}");
            Assert.Equal("user_interrupted", stopped.Error?.Code);
            string expected = text[..^1] + "X";
            await WaitLine($"TEXT {expected.Length} {Sha(expected)}");
            await Task.Delay(300);
            Assert.DoesNotContain(lines, l => l.StartsWith($"TEXT {expected.Length + 1} ", StringComparison.Ordinal)); // nothing after the stop

            var events = (await recorder.GetSafetyAuditRecordsAsync(500)).Select(e => e.EventType).ToList();
            _out.WriteLine("audit: " + string.Join(",", Enumerable.Reverse(events)));
            Assert.True((await recorder.VerifyAuditChainAsync()).Ok);
        }
        finally
        {
            try { if (!fx.HasExited) fx.Kill(true); } catch { }
            SqliteConnection.ClearAllPools(); try { File.Delete(db); } catch { }
        }
    }
}
