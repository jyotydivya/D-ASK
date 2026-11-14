using System.Collections.Concurrent;
using System.Diagnostics;
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

/// <summary>
/// Complete desktop input on the REAL OS (2026-11-14): right-click, double-click, wheel scroll, OLE drag and drop, TextPattern selection,
/// the clipboard, and Emergency Stop / cancellation between events. The only target is the disposable fixture (its pid is the only one
/// allowed). The TEST plays the HUD (it approves programmatically): this is not a human-in-the-loop test.
/// The fixture independently reports what it actually received.
/// </summary>
[Collection("AgentHost")]
public class CompleteInputLiveTests
{
    private readonly ITestOutputHelper _out;
    public CompleteInputLiveTests(ITestOutputHelper o) { _out = o; DpiCoordinateConverter.InitializeDpiAwareness(); }
    private static string Root => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    [LiveInputFact]
    [Trait("Category", "GuardedInputLive")]
    public async Task Live_RightClick_DoubleClick_Scroll_Drag_Select_Clipboard_Stop()
    {
        string title = $"DASK Input2 Fixture {Guid.NewGuid():N}"[..30];
        var lines = new ConcurrentQueue<string>();
        using var fx = Process.Start(new ProcessStartInfo("powershell.exe",
            $"-NoProfile -STA -ExecutionPolicy Bypass -File \"{Path.Combine(Root, "tests", "DAsk.Daemon.Tests", "Fixtures", "input-fixture2.ps1")}\" -Title \"{title}\"")
            { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true })!;
        fx.OutputDataReceived += (_, e) => { if (e.Data != null) lines.Enqueue(e.Data); };
        fx.BeginOutputReadLine();
        string db = Path.Combine(Path.GetTempPath(), $"dask-input2-live-{Guid.NewGuid():N}.db");
        try
        {
            async Task<string> WaitLine(string prefix, int ms = 15000)
            {
                var sw = Stopwatch.StartNew();
                while (sw.ElapsedMilliseconds < ms) { foreach (var l in lines) if (l.StartsWith(prefix, StringComparison.Ordinal)) return l; await Task.Delay(50); }
                throw new TimeoutException($"fixture never reported '{prefix}'. Lines: {string.Join(" | ", lines)}");
            }
            await WaitLine("READY");
            await Task.Delay(500);

            var recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, db);
            await recorder.InitializeAsync();
            var os = new Win32WindowSource();
            var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, recorder, os);
            policy.SetSessionLivenessGate(_ => true);
            var approvedTypes = new ConcurrentQueue<string>();
            policy.ApprovalRequested += (_, r) => Task.Run(async () =>
            {
                await Task.Delay(150);
                approvedTypes.Enqueue(r.ActionType);
                policy.SubmitApprovalDecision(new ActionApprovalResponse
                {
                    ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                    ActionDigest = r.ActionDigest, Approved = true, DecisionSource = "UserExplicitConfirmation",
                }, "live-session", () => false, () => 1);
            });
            using var uia = new WindowsUiAutomationService();
            var reader = new DesktopReadService(os, uia, new DesktopReadOptions { AllowedProcessIds = new HashSet<int> { fx.Id } });
            bool stopped = false;
            Func<int, Task>? between = null;
            var service = new GuardedInputRequestService(reader, uia, policy, () => stopped, () => 1, recorder, _ => true, new Win32DesktopInputPlatform(),
                new GuardedInputOptions { MouseEnabled = true, KeyboardEnabled = true, TestHookBetweenEvents = i => between?.Invoke(i) ?? Task.CompletedTask });
            var ctx = new DesktopActionContext("live-task", "c1", "live-session");
            async Task<DesktopCallResult> Do(string tool, object args)
            {
                var r = await service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), ctx, CancellationToken.None);
                _out.WriteLine($"{tool}: {r.Status} {JsonSerializer.Serialize((object?)r.Result ?? r.Error)}");
                return r;
            }

            // 1. Double-click a list item: the fixture's DoubleClick handler runs for exactly that item.
            var dbl = await Do(GuardedInputTools.DoubleClick, new { titleContains = title, element = new { controlType = "ListItem", name = "Beta" } });
            Assert.Equal("ok", dbl.Status);
            Assert.Equal("DOUBLE Beta", await WaitLine("DOUBLE"));

            // 2. Right-click a button: its context menu opens (fixture reports MENU). Then close it with Escape (an allowed chord).
            var rc = await Do(GuardedInputTools.RightClick, new { titleContains = title, element = new { controlType = "Button", automationId = "menu" } });
            Assert.Equal("ok", rc.Status);
            await WaitLine("MENU");
            await Task.Delay(300);
            SendEscape();
            await Task.Delay(400);

            // 3. Scroll the long list down 3 notches: its top index really changes.
            var sc = await Do(GuardedInputTools.Scroll, new { titleContains = title, element = new { controlType = "List", automationId = "rows" }, direction = "down", amount = 3 });
            Assert.Equal("ok", sc.Status);
            var top = await WaitLine("TOP ");
            Assert.True(int.Parse(top[4..]) > 0, top);

            // 4. Drag "Apple" from one list and drop it on the other: a real OLE drag and drop (fixture reports DROP Apple).
            var dr = await Do(GuardedInputTools.Drag, new { titleContains = title, element = new { controlType = "ListItem", name = "Apple" }, to = new { controlType = "List", automationId = "target" } });
            Assert.Equal("ok", dr.Status);
            Assert.Equal("DROP Apple", await WaitLine("DROP"));

            // 5. Select "quick" in the text box through UI Automation (no keys): selection start 4, length 5 reported by the fixture.
            var se = await Do(GuardedInputTools.SelectText, new { titleContains = title, element = new { controlType = "Edit", automationId = "sel" }, text = "quick" });
            Assert.Equal("ok", se.Status);
            await WaitLine("SEL 4 5");
            // ... and select all of it.
            var sa = await Do(GuardedInputTools.SelectText, new { titleContains = title, element = new { controlType = "Edit", automationId = "sel" } });
            Assert.Equal("ok", sa.Status);
            await WaitLine("SEL 0 19");

            // 6. Emergency Stop between wheel notches: the sequence stops before the next notch; nothing more is sent.
            between = i => { if (i == 2) stopped = true; return Task.CompletedTask; };
            var stop = await Do(GuardedInputTools.Scroll, new { titleContains = title, element = new { controlType = "List", automationId = "rows" }, direction = "down", amount = 10 });
            between = null;
            Assert.Equal("emergency_stopped", stop.Error?.Code);
            Assert.Contains("Stopped after", stop.Error!.Message);
            // ... and while stopped nothing new can even be requested.
            var refused = await Do(GuardedInputTools.DoubleClick, new { titleContains = title, element = new { controlType = "ListItem", name = "Alpha" } });
            Assert.Equal("emergency_stopped", refused.Error?.Code);
            stopped = false;

            // 7. Clipboard: write (verified by read-back), then read it back through the read tool. Restores the user's clipboard text afterwards.
            var clipPlatform = new Win32ClipboardPlatform();
            var saved = await Sta(() => clipPlatform.ReadText());
            var clip = new ClipboardService(new ApprovalGate(policy, () => stopped, () => 1, recorder, _ => true, "Clipboard"), clipPlatform, new ClipboardOptions { Enabled = true });
            string marker = $"D-ASK clipboard test {Guid.NewGuid():N}";
            var w = await clip.ExecuteAsync(ClipboardService.Write, JsonSerializer.SerializeToElement(new { text = marker }), ctx, CancellationToken.None);
            _out.WriteLine($"clipboard write: {w.Status} {JsonSerializer.Serialize((object?)w.Result ?? w.Error)}");
            Assert.Equal("ok", w.Status);
            Assert.Equal(marker, (await Sta(() => clipPlatform.ReadText())).Text);   // independent read
            var rd = await clip.ExecuteAsync(ClipboardService.Read, JsonSerializer.SerializeToElement(new { }), ctx, CancellationToken.None);
            Assert.Equal("ok", rd.Status);
            Assert.Contains(marker, JsonSerializer.Serialize(rd.Result));
            // A secret-looking clipboard is not handed over.
            await Sta(() => clipPlatform.WriteText("password = hunter2hunter2"));
            var rs = await clip.ExecuteAsync(ClipboardService.Read, JsonSerializer.SerializeToElement(new { }), ctx, CancellationToken.None);
            Assert.Equal("secret_refused", rs.Error?.Code);
            if (saved.Text != null) await Sta(() => clipPlatform.WriteText(saved.Text));

            _out.WriteLine("approved action types: " + string.Join(",", approvedTypes));
            Assert.True((await recorder.VerifyAuditChainAsync()).Ok);
        }
        finally
        {
            try { if (!fx.HasExited) fx.Kill(true); } catch { }
            SqliteConnection.ClearAllPools(); try { File.Delete(db); } catch { }
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    private static void SendEscape() { keybd_event(0x1B, 0, 0, UIntPtr.Zero); keybd_event(0x1B, 0, 2, UIntPtr.Zero); }

    private static Task<T> Sta<T>(Func<T> f)
    {
        var tcs = new TaskCompletionSource<T>();
        var t = new Thread(() => { try { tcs.SetResult(f()); } catch (Exception ex) { tcs.SetException(ex); } });
        t.SetApartmentState(ApartmentState.STA); t.Start();
        return tcs.Task;
    }
}
