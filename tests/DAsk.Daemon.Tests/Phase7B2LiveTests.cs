using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using System.Threading.Channels;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 7B.2 end-to-end over the REAL daemon process, no mock on the daemon side:
///   this test plays the HUD's wire role (same messages, same liveness heartbeats, digest echo) →
///   real DAsk.Daemon.exe → real agent host + local model → protocol v2 → DesktopActionRequestService → OS-resolved
///   identity of a disposable fixture window → ActionPolicyEngine → owner-only ActionApprovalRequest over the pipe →
///   decision → daemon validation → ApprovalStateNotification + task result.
/// The displayed content is checked with the HUD page's own parser (hooks/approvalLifecycle.ts).
/// Observation is restricted to the fixture (AgentHost:DesktopReadAllowedProcessIds). Nothing is ever performed.
/// Run with: --filter "Category=Phase7B2Live".
/// </summary>
[Collection("AgentHost")]
[Trait("Category", "Phase7B2Live")]
public class Phase7B2LiveTests
{
    private static readonly string Root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    private readonly ITestOutputHelper _output;
    public Phase7B2LiveTests(ITestOutputHelper output) => _output = output;
    private void Log(string s) { try { _output.WriteLine(s); } catch { } }

    /// <summary>A pipe client that behaves like the HUD on the wire: one reader, serialized writes, a heartbeat lease.</summary>
    internal sealed class HudWire : IAsyncDisposable
    {
        private readonly NamedPipeClientStream _pipe;
        private readonly SemaphoreSlim _write = new(1, 1);
        private readonly CancellationTokenSource _cts = new();
        public readonly Channel<(IpcEnvelope Env, int Bytes, DateTime At)> Inbox = Channel.CreateUnbounded<(IpcEnvelope, int, DateTime)>();
        private long _seq;
        private Task? _reader, _heart;

        private HudWire(NamedPipeClientStream p) => _pipe = p;

        public static async Task<HudWire> ConnectAsync(string pipe)
        {
            var p = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous);
            await p.ConnectAsync(30_000);
            var w = new HudWire(p);
            w._reader = Task.Run(w.ReadLoop);
            await w.SendAsync(IpcEnvelope.Create(nameof(HandshakeRequest), new HandshakeRequest
            {
                ClientName = "Phase7B2Live", ProtocolVersion = IpcConstants.CurrentProtocolVersion, ClientProcessId = Environment.ProcessId, Capabilities = ["agent"],
            }));
            var hs = await w.NextAsync(e => e.Type == nameof(HandshakeResponse), 10_000);
            Assert.Equal("Accepted", hs.Env.DeserializePayload<HandshakeResponse>()!.Status);
            // What a healthy HUD does after the handshake: report its panic hotkey, then keep the liveness lease.
            await w.SendAsync(IpcEnvelope.Create(nameof(PanicHotkeyStatusNotification), new PanicHotkeyStatusNotification { IsAvailable = true, Reason = "live test" }));
            w._heart = Task.Run(w.HeartbeatLoop);
            await Task.Delay(500);
            return w;
        }

        public async Task SendAsync(IpcEnvelope e)
        {
            await _write.WaitAsync();
            try { await _pipe.WriteAsync(e.ToLengthPrefixedBytes()); await _pipe.FlushAsync(); }
            finally { _write.Release(); }
        }

        private async Task HeartbeatLoop()
        {
            while (!_cts.IsCancellationRequested)
            {
                long s = Interlocked.Increment(ref _seq);
                try
                {
                    await SendAsync(IpcEnvelope.Create(nameof(HeartbeatPing), new HeartbeatPing
                    { Sequence = s, Timestamp = DateTimeOffset.UtcNow, EventLoopAck = s - 1, HotkeyAck = s - 1, HotkeyRegistered = true }));
                }
                catch { return; }
                try { await Task.Delay(2_000, _cts.Token); } catch { return; }
            }
        }

        private async Task ReadLoop()
        {
            var header = new byte[4];
            try
            {
                while (!_cts.IsCancellationRequested)
                {
                    await _pipe.ReadExactlyAsync(header, _cts.Token);
                    var body = new byte[BitConverter.ToUInt32(header)];
                    await _pipe.ReadExactlyAsync(body, _cts.Token);
                    Inbox.Writer.TryWrite((IpcEnvelope.FromJsonBytes(body)!, body.Length, DateTime.UtcNow));
                }
            }
            catch { Inbox.Writer.TryComplete(); }
        }

        public async Task<(IpcEnvelope Env, int Bytes, DateTime At)> NextAsync(Func<IpcEnvelope, bool> match, int timeoutMs)
        {
            using var cts = new CancellationTokenSource(timeoutMs);
            while (true)
            {
                var m = await Inbox.Reader.ReadAsync(cts.Token);
                if (match(m.Env)) return m;
            }
        }

        public async ValueTask DisposeAsync()
        {
            _cts.Cancel();
            try { _pipe.Dispose(); } catch { }
            try { if (_reader != null) await _reader; } catch { }
            try { if (_heart != null) await _heart; } catch { }
        }
    }

    private static class ForegroundNative
    {
        [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
        [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    }

    /// <summary>Diagnostics only (read-only): the current foreground window's handle, title (bounded) and process.</summary>
    internal static string DescribeForeground()
    {
        IntPtr h = ForegroundNative.GetForegroundWindow();
        if (h == IntPtr.Zero) return "none";
        var sb = new System.Text.StringBuilder(256);
        ForegroundNative.GetWindowText(h, sb, sb.Capacity);
        string title = sb.Length > 100 ? sb.ToString(0, 100) + "..." : sb.ToString();
        ForegroundNative.GetWindowThreadProcessId(h, out uint pid);
        string process;
        try { using var p = Process.GetProcessById((int)pid); process = p.ProcessName; } catch { process = "(exited)"; }
        return $"hwnd {h.ToInt64()}, title \"{title}\", process {process} (pid {pid})";
    }

    internal static ActionApprovalResponse Decision(ActionApprovalRequest r, bool approved) => new()
    {
        ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
        ActionDigest = r.ActionDigest, Approved = approved, DecisionSource = "UserExplicitConfirmation",
        RejectionReason = approved ? null : "Declined by user",
    };

    private async Task<(string TaskId, ActionApprovalRequest Request, int Bytes, long MsToApproval)> AskAsync(HudWire w, string objective)
    {
        var req = IpcEnvelope.Create(nameof(AgentTaskSubmitRequest), new AgentTaskSubmitRequest { Objective = objective });
        var sw = Stopwatch.StartNew();
        await w.SendAsync(req);
        var ack = (await w.NextAsync(e => e.ReplyToId == req.Id, 30_000)).Env.DeserializePayload<AgentTaskSubmitResponse>()!;
        Assert.True(ack.Accepted, $"{ack.RejectionCode}: {ack.ErrorMessage}");
        var a = await w.NextAsync(e => e.Type == nameof(ActionApprovalRequest) || (e.Type == nameof(AgentTaskResultNotification) &&
            e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == ack.TaskId), 180_000);
        Assert.True(a.Env.Type == nameof(ActionApprovalRequest), $"no approval: the task ended first: {a.Env.DeserializePayload<AgentTaskResultNotification>()?.Response}");
        long ms = sw.ElapsedMilliseconds;
        Log($"\nREQUEST  {objective}\nMEASURED submit → approval in the HUD's inbox: {ms} ms; envelope {a.Bytes} bytes");
        return (ack.TaskId!, a.Env.DeserializePayload<ActionApprovalRequest>()!, a.Bytes, ms);
    }

    private async Task<AgentTaskResultNotification> ResultAsync(HudWire w, string taskId, int timeoutMs = 120_000)
    {
        var r = (await w.NextAsync(e => e.Type == nameof(AgentTaskResultNotification) && e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == taskId, timeoutMs))
            .Env.DeserializePayload<AgentTaskResultNotification>()!;
        Log($"OUTCOME  {r.Outcome}\nRESPONSE {r.Response}");
        return r;
    }

    private static Task<(IpcEnvelope Env, int Bytes, DateTime At)> StateAsync(HudWire w, string approvalId, string? state = null, int timeoutMs = 40_000) =>
        w.NextAsync(e => e.Type == nameof(ApprovalStateNotification) && e.DeserializePayload<ApprovalStateNotification>() is { } n &&
            n.ApprovalId == approvalId && (state == null || n.State == state), timeoutMs);

    /// <summary>What the HUD page would show for this request, from its own parser.</summary>
    private static JsonElement PageView(IpcEnvelope approvalEnvelope)
    {
        string file = Path.Combine(Path.GetTempPath(), $"dask-7b2-approval-{Guid.NewGuid():N}.json");
        File.WriteAllText(file, approvalEnvelope.Payload.GetRawText());
        try
        {
            // Plain node (built-in type stripping): no npx, so nothing is resolved or downloaded from a registry.
            var psi = new ProcessStartInfo("node", $"tests\\hud-agent\\fixtures\\parse-approval.ts \"{file}\"")
            { WorkingDirectory = Root, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
            using var p = Process.Start(psi)!;
            string outp = p.StandardOutput.ReadToEnd();
            p.WaitForExit(60_000);
            return JsonDocument.Parse(outp).RootElement.Clone();
        }
        finally { File.Delete(file); }
    }

    [Fact]
    public async Task Live_ApprovalPathway_ThroughTheRealDaemon_HostAndLocalModel()
    {
        // A previous live test's model server may still be exiting: wait for it (never kill it), then require a clean start.
        for (int i = 0; i < 75 && Process.GetProcessesByName("llama-server").Length > 0; i++) await Task.Delay(200);
        foreach (var existing in Process.GetProcessesByName("llama-server")) Assert.Fail($"llama-server pid {existing.Id} is already running; this test needs a clean start");
        string exe = Path.Combine(Root, "src", "DAsk.Daemon", "bin", "Debug", "net8.0", "DAsk.Daemon.exe");
        Assert.True(File.Exists(exe), $"Build the daemon first: {exe}");

        string tag = Guid.NewGuid().ToString("N")[..6];
        using var fx = new Phase7B1bTests.Fixture($"DASK Approval Fixture {tag}", 60, 60);
        var fxStart = fx.Process.StartTime.ToUniversalTime();

        // Precondition (before the daemon exists, so before D-ASK can act): the fixture is shown without activation and
        // must not be the foreground window. If it is, something outside D-ASK focused it and the final "unchanged"
        // check could not tell D-ASK's behaviour apart from that; the run is invalid rather than evidence either way.
        var fxBaseline = new DAsk.Daemon.Automation.Observation.Win32WindowSource().Read(fx.Hwnd);
        Assert.NotNull(fxBaseline);
        Assert.False(fxBaseline!.Foreground,
            "Precondition violated: the fixture window was already the foreground window before the daemon started " +
            $"(foreground now: {DescribeForeground()}). Leave the desktop untouched during the run and run it again.");

        string pipe = "dask-7b2-live-" + Guid.NewGuid().ToString("N");
        var psi = new ProcessStartInfo { FileName = exe, WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        for (int i = 0; i < 2; i++) psi.Environment[$"DASK_Daemon__AllowedClientImagePaths__{i}"] = Environment.ProcessPath!;
        psi.Environment["DASK_Daemon__PipeName"] = pipe;
        psi.Environment["DASK_AgentHost__DesktopReadAllowedProcessIds__0"] = fx.Process.Id.ToString();
        // Phase 7B.2 verifies the approval-only mode: execution (Phase 7B.3, on in appsettings) is switched off explicitly.
        psi.Environment["DASK_AgentHost__DesktopActionExecution"] = "false";
        using var daemon = new Process { StartInfo = psi };
        var daemonLog = new List<string>();
        daemon.OutputDataReceived += (_, e) => { if (e.Data != null) lock (daemonLog) daemonLog.Add(e.Data); };
        daemon.ErrorDataReceived += (_, e) => { if (e.Data != null) lock (daemonLog) daemonLog.Add("[err] " + e.Data); };
        daemon.Start();
        daemon.BeginOutputReadLine();
        daemon.BeginErrorReadLine();
        var measured = new Dictionary<string, object>();
        try
        {
            await using var hud = await HudWire.ConnectAsync(pipe);

            // Still a precondition: no agent request has been made yet, so nothing D-ASK does can have focused it.
            var fxBeforeRequests = new DAsk.Daemon.Automation.Observation.Win32WindowSource().Read(fx.Hwnd)!;
            Assert.False(fxBeforeRequests.Foreground,
                "Precondition violated: the fixture window became the foreground window before any request was made " +
                $"(foreground now: {DescribeForeground()}). Leave the desktop untouched during the run and run it again.");

            // ── 1. Deny ──
            var (t1, r1, bytes1, ms1) = await AskAsync(hud, $"Minimize the window titled \"{fx.Title}\"");
            measured["submitToApprovalMs_first"] = ms1;
            measured["approvalEnvelopeBytes"] = bytes1;
            Assert.Equal("Desktop.SetWindowState", r1.ActionType);
            Assert.Equal(fx.Hwnd, r1.TargetHwnd);                              // OS-resolved, the fixture's real HWND
            Assert.Equal(fx.Process.Id, r1.TargetProcessId);
            Assert.True(Math.Abs((r1.TargetProcessCreationTime!.Value.UtcDateTime - fxStart).TotalSeconds) < 1);
            Assert.Equal("minimize", r1.ActionParameters["state"]);
            Assert.EndsWith("powershell.exe", r1.ActionParameters["imagePath"], StringComparison.OrdinalIgnoreCase);
            Assert.Equal("DAskDesktopFixture", r1.ActionParameters["windowClass"]);
            Assert.True(r1.ExpiresAtUtc - r1.CreatedAtUtc <= TimeSpan.FromSeconds(30));
            Assert.False(string.IsNullOrEmpty(r1.ActionDigest));
            Assert.DoesNotContain(fx.Title, r1.Reason);

            var page = PageView(IpcEnvelope.Create(nameof(ActionApprovalRequest), r1));
            Log("PAGE VIEW " + page.GetRawText());
            Assert.True(page.TryGetProperty("view", out var view), "the HUD page must be able to display this approval: " + page.GetRawText());
            Assert.Equal(fx.Title, view.GetProperty("windowTitle").GetString());
            Assert.Equal(fx.Process.Id, view.GetProperty("processId").GetInt32());
            Assert.True(view.GetProperty("approvalOnly").GetBoolean());
            Assert.Equal("Elevated", view.GetProperty("risk").GetString());
            var shownParams = view.GetProperty("parameters").EnumerateArray().Select(p => p.GetProperty("name").GetString()).ToHashSet();
            Assert.True(r1.ActionParameters.Keys.All(shownParams.Contains), "every parameter is displayed");

            await Task.Delay(1_100); // the panel arms after 1 s
            var sw = Stopwatch.StartNew();
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r1, false)));
            await StateAsync(hud, r1.ApprovalId, ApprovalStates.Denied);
            measured["denyToDaemonConfirmationMs"] = sw.ElapsedMilliseconds;
            var res1 = await ResultAsync(hud, t1);
            measured["denyToTaskResultMs"] = sw.ElapsedMilliseconds;
            Assert.NotEqual("completed", res1.Outcome);
            Assert.Contains("You declined", res1.Response);

            // ── 2. Approve (approval only) + duplicate decision ──
            var (t2, r2, _, ms2) = await AskAsync(hud, $"Bring the window titled \"{fx.Title}\" to the front");
            measured["submitToApprovalMs_warm"] = ms2;
            Assert.Equal("Desktop.FocusWindow", r2.ActionType);
            await Task.Delay(1_100);
            sw.Restart();
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r2, true)));
            await StateAsync(hud, r2.ApprovalId, ApprovalStates.Approved);
            measured["approveToDaemonConfirmationMs"] = sw.ElapsedMilliseconds;
            var res2 = await ResultAsync(hud, t2);
            measured["approveToTaskResultMs"] = sw.ElapsedMilliseconds;
            Assert.NotEqual("completed", res2.Outcome);
            Assert.Contains("did not perform it", res2.Response);
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r2, true))); // replayed decision
            var dup = (await StateAsync(hud, r2.ApprovalId, timeoutMs: 5_000)).Env.DeserializePayload<ApprovalStateNotification>()!;
            Assert.False(dup.DecisionAccepted ?? true);

            // ── 3. Tampered digest ──
            var (t3, r3, _, _) = await AskAsync(hud, $"Restore the window titled \"{fx.Title}\"");
            await Task.Delay(1_100);
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r3, true) with { ActionDigest = new string('0', 64) }));
            var st3 = (await StateAsync(hud, r3.ApprovalId, ApprovalStates.Rejected)).Env.DeserializePayload<ApprovalStateNotification>()!;
            var res3 = await ResultAsync(hud, t3);
            Assert.NotEqual("completed", res3.Outcome);
            Log($"tampered digest → {st3.State}: {st3.Reason}");

            // ── 4. Emergency Stop while the approval is pending ──
            var (t4, r4, _, _) = await AskAsync(hud, $"Maximize the window titled \"{fx.Title}\"");
            sw.Restart();
            await hud.SendAsync(IpcEnvelope.Create(nameof(EmergencyStopRequest), new EmergencyStopRequest { Source = "phase7b2-live", Reason = "pending approval", StopId = "7b2-" + Guid.NewGuid().ToString("N") }));
            await StateAsync(hud, r4.ApprovalId, ApprovalStates.InvalidatedByEmergencyStop, 10_000);
            measured["stopToApprovalInvalidatedMs"] = sw.ElapsedMilliseconds;
            var res4 = await ResultAsync(hud, t4, 30_000);
            measured["stopToTaskEndedMs"] = sw.ElapsedMilliseconds;
            Assert.NotEqual("completed", res4.Outcome);
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r4, true))); // too late: stopped and invalidated
            var late = (await StateAsync(hud, r4.ApprovalId, timeoutMs: 5_000)).Env.DeserializePayload<ApprovalStateNotification>()!;
            Assert.False(late.DecisionAccepted ?? true);

            // The fixture was never changed: no executor exists.
            Assert.False(fx.Process.HasExited);
            var id = new DAsk.Daemon.Automation.Observation.Win32WindowSource().Read(fx.Hwnd)!;
            string foregroundAtCheck = DescribeForeground();
            Assert.False(id.Minimized);
            Assert.False(id.Maximized);
            Assert.False(id.Foreground,
                $"The fixture window (hwnd {fx.Hwnd}, pid {fx.Process.Id}) is the foreground window at the final check. " +
                $"Foreground window: {foregroundAtCheck}. It was not foreground before the daemon started or before the first request. " +
                "Neither the daemon nor the agent contains a focus API; check what else had input during the run.");

            Log("\nMEASUREMENTS " + JsonSerializer.Serialize(measured));
        }
        finally
        {
            lock (daemonLog) foreach (var l in daemonLog.Where(l => l.Contains("DesktopAction") || l.Contains("Registered pending approval") || l.Contains("AUTHORIZED") || l.Contains("consumed") || l.Contains("Protocol v2") || l.Contains("EMERGENCY") || l.Contains("fail:")).Take(60)) Log("[daemon] " + l);
            try { daemon.Kill(entireProcessTree: true); await daemon.WaitForExitAsync(); } catch { }
        }
    }
}
