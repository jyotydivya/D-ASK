using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 7B.1b end-to-end demonstration, no mock on the path:
///   this test (pipe client) → real DAsk.Daemon.exe → real stdio agent host → AgentRuntime → real llama-server +
///   local GGUF → protocol v2 read-only call → the daemon's real DesktopReadService (Win32 enumeration, identity,
///   UI Automation) → independent verification → back over the pipe.
/// Observation is restricted, through the daemon's normal configuration (AgentHost:DesktopReadAllowedProcessIds), to
/// disposable fixture windows created by this test, so no personal window is ever listed or inspected. Nothing is
/// clicked, typed or focused. Run with: --filter "Category=Phase7B1bLive".
/// </summary>
[Collection("AgentHost")]
[Trait("Category", "Phase7B1bLive")]
public class Phase7B1bLiveTests
{
    private static readonly string Root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    private readonly ITestOutputHelper _output;
    public Phase7B1bLiveTests(ITestOutputHelper output) => _output = output;
    private void Log(string s) { try { _output.WriteLine(s); } catch { } }

    private static async Task SendAsync(Stream s, IpcEnvelope e) { await s.WriteAsync(e.ToLengthPrefixedBytes()); await s.FlushAsync(); }

    // DIAGNOSTICS (Phase 7B.3 blocker investigation; observation only, no change to what the test reads or asserts):
    // every envelope this client receives is recorded, including the ones ReadUntilAsync skips because they do not match.
    private readonly List<string> _trace = new();
    private void Trace(string line) { lock (_trace) _trace.Add($"{DateTime.UtcNow:O} {line}"); }

    private static string TaskIdOf(IpcEnvelope env)
    {
        try
        {
            if (env.Type == nameof(AgentTaskSubmitResponse)) return env.DeserializePayload<AgentTaskSubmitResponse>()?.TaskId ?? "-";
            if (env.Type == nameof(AgentTaskResultNotification)) return env.DeserializePayload<AgentTaskResultNotification>()?.TaskId ?? "-";
        }
        catch { }
        return "-";
    }

    // FIX (Phase 7B.3 blocker): the daemon may deliver a task's progress and RESULT notifications before that task's
    // submit acknowledgement (they are written from the host reader thread; the acknowledgement from a continuation),
    // as the HUD page already allows for (hooks/nativeAgent.ts buffers "early" messages). Envelopes that a read does not
    // match are therefore kept, not discarded, and every later read looks in this backlog first. Bounded.
    private readonly List<IpcEnvelope> _backlog = new();
    private const int MaxBacklog = 512;

    internal static async Task<IpcEnvelope> ReadUntilAsync(Stream s, Func<IpcEnvelope, bool> match, int timeoutMs, Action<string>? trace = null, string phase = "",
        List<IpcEnvelope>? backlog = null)
    {
        if (backlog != null)
        {
            lock (backlog)
            {
                int i = backlog.FindIndex(e => match(e));
                if (i >= 0)
                {
                    var early = backlog[i];
                    backlog.RemoveAt(i);
                    trace?.Invoke($"BACKLOG phase={phase} type={early.Type} id={early.Id} taskId={TaskIdOf(early)} MATCHED (received earlier)");
                    return early;
                }
            }
        }
        using var cts = new CancellationTokenSource(timeoutMs);
        var header = new byte[4];
        try
        {
            while (true)
            {
                await s.ReadExactlyAsync(header, cts.Token);
                var body = new byte[BitConverter.ToUInt32(header)];
                await s.ReadExactlyAsync(body, cts.Token);
                var env = IpcEnvelope.FromJsonBytes(body)!;
                bool matched = match(env);
                if (trace != null && env.Type is not ("TelemetryUpdate" or "HeartbeatPong" or "StateUpdate" or "ResourceAlert"))
                    trace($"RECV phase={phase} type={env.Type} id={env.Id} replyTo={env.ReplyToId ?? "-"} taskId={TaskIdOf(env)} bytes={body.Length} {(matched ? "MATCHED" : backlog != null ? "KEPT" : "SKIPPED")}");
                if (matched) return env;
                if (backlog != null && env.Type is nameof(AgentTaskResultNotification) or nameof(AgentTaskProgressNotification) or nameof(AgentTaskSubmitResponse))
                    lock (backlog) { backlog.Add(env); if (backlog.Count > MaxBacklog) backlog.RemoveAt(0); }
            }
        }
        catch (OperationCanceledException) { trace?.Invoke($"TIMEOUT phase={phase} after {timeoutMs} ms"); throw; }
    }

    private async Task<AgentTaskResultNotification> AskAsync(Stream s, string objective, int timeoutMs = 180_000)
    {
        var req = IpcEnvelope.Create(nameof(AgentTaskSubmitRequest), new AgentTaskSubmitRequest { Objective = objective });
        var sw = Stopwatch.StartNew();
        Trace($"SEND-START request id={req.Id} objectiveChars={objective.Length}");
        await SendAsync(s, req);
        Trace($"SEND-DONE request id={req.Id}");
        var ack = (await ReadUntilAsync(s, e => e.ReplyToId == req.Id, 30_000, Trace, "ack", _backlog)).DeserializePayload<AgentTaskSubmitResponse>()!;
        Trace($"ACK request id={req.Id} taskId={ack.TaskId} accepted={ack.Accepted}");
        Assert.True(ack.Accepted, $"{ack.RejectionCode}: {ack.ErrorMessage}");
        var r = (await ReadUntilAsync(s, e => e.Type == nameof(AgentTaskResultNotification) &&
            e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == ack.TaskId, timeoutMs, Trace, "result", _backlog)).DeserializePayload<AgentTaskResultNotification>()!;
        Trace($"RESULT taskId={r.TaskId} outcome={r.Outcome}");
        Log($"\nREQUEST  {objective}\nMEASURED {sw.ElapsedMilliseconds} ms\nOUTCOME  {r.Outcome}\nRESPONSE {r.Response}\nSTEPS    {r.Steps}");
        return r;
    }

    private static List<(string Tool, string Status)> Steps(AgentTaskResultNotification r) =>
        r.Steps is { } st ? st.EnumerateArray().Select(x => (x.GetProperty("tool").GetString()!, x.GetProperty("status").GetString()!)).ToList() : new();

    [Fact]
    public async Task Live_NaturalLanguage_ListAndInspect_ThroughTheRealDaemon_AndLocalModel()
    {
        // A previous live test's model server may still be exiting: wait for it (never kill it), then require a clean start.
        for (int i = 0; i < 75 && Process.GetProcessesByName("llama-server").Length > 0; i++) await Task.Delay(200);
        foreach (var existing in Process.GetProcessesByName("llama-server")) Assert.Fail($"llama-server pid {existing.Id} is already running; this test needs a clean start");
        string exe = Path.Combine(Root, "src", "DAsk.Daemon", "bin", "Debug", "net8.0", "DAsk.Daemon.exe");
        Assert.True(File.Exists(exe), $"Build the daemon first: {exe}");
        Assert.True(File.Exists(Path.Combine(Root, "dist", "agent-host", "agent", "host", "stdioHost.js")), "Build the host first: npm run build:agent-host");

        string tag = Guid.NewGuid().ToString("N")[..6];
        using var main = new Phase7B1bTests.Fixture($"DASK Live Fixture {tag}", 40, 40);
        using var twinA = new Phase7B1bTests.Fixture($"DASK Twin {tag} A", 480, 40);
        using var twinB = new Phase7B1bTests.Fixture($"DASK Twin {tag} B", 480, 300);

        string pipe = "dask-7b1b-live-" + Guid.NewGuid().ToString("N");
        var psi = new ProcessStartInfo { FileName = exe, WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        for (int i = 0; i < 2; i++) psi.Environment[$"DASK_Daemon__AllowedClientImagePaths__{i}"] = Environment.ProcessPath!;
        psi.Environment["DASK_Daemon__PipeName"] = pipe;
        int k = 0;
        foreach (var f in new[] { main, twinA, twinB }) psi.Environment[$"DASK_AgentHost__DesktopReadAllowedProcessIds__{k++}"] = f.Process.Id.ToString();

        using var daemon = new Process { StartInfo = psi };
        var daemonLog = new List<string>();
        // DIAGNOSTICS: every daemon line is kept (written to the diagnostics folder at the end); the test's own output below
        // still shows only the filtered lines it always showed.
        daemon.OutputDataReceived += (_, e) => { if (e.Data != null) lock (daemonLog) daemonLog.Add(e.Data); };
        daemon.ErrorDataReceived += (_, e) => { if (e.Data != null) lock (daemonLog) daemonLog.Add("[err] " + e.Data); };
        daemon.Start();
        daemon.BeginOutputReadLine();
        daemon.BeginErrorReadLine();
        try
        {
            using var s = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous);
            await s.ConnectAsync(30_000);
            await SendAsync(s, IpcEnvelope.Create(nameof(HandshakeRequest), new HandshakeRequest
            {
                ClientName = "Phase7B1bLive", ProtocolVersion = IpcConstants.CurrentProtocolVersion, ClientProcessId = Environment.ProcessId, Capabilities = ["agent"],
            }));
            Assert.Equal("Accepted", (await ReadUntilAsync(s, e => e.Type == nameof(HandshakeResponse), 10_000)).DeserializePayload<HandshakeResponse>()!.Status);

            // 1. Natural-language list request.
            var list = await AskAsync(s, "What windows are open right now?");
            Assert.False(list.Interrupted);
            Assert.Contains(Steps(list), x => x.Tool == "desktop.list_windows");
            if (list.Outcome == "completed")
            {
                Assert.Contains(main.Title, list.Response);
                Assert.Contains($"DASK Twin {tag} A", list.Response);
            }

            // 2. Natural-language inspection of a named window.
            var insp = await AskAsync(s, $"Inspect the window titled \"{main.Title}\"");
            Assert.False(insp.Interrupted);
            Assert.DoesNotContain(Phase7B1bTests.Fixture.Secret, insp.Response);
            if (insp.Outcome == "completed")
            {
                Assert.Contains("Fixture OK", insp.Response);
                Assert.Contains("password field: value not read", insp.Response);
            }

            // 3. Ambiguous target: two windows match; the user is asked, nothing is chosen for them.
            var amb = await AskAsync(s, $"Inspect the window titled \"DASK Twin {tag}\"");
            Assert.NotEqual("completed", amb.Outcome);
            if (Steps(amb).Any(x => x.Tool == "desktop.inspect_window")) Assert.Contains("Which one do you mean?", amb.Response);

            // 4. Missing target: a question, no tool call.
            var missing = await AskAsync(s, "Inspect this window");
            Assert.Equal("refused", missing.Outcome);
            Assert.Contains("Which window", missing.Response);
            Assert.Empty(Steps(missing));

            // 5. An actuation request is refused up front: no model call, no tool, nothing done on its behalf.
            var click = await AskAsync(s, $"Click the Fixture OK button in the window titled \"{main.Title}\"");
            Assert.Equal("refused", click.Outcome);
            Assert.Contains("can't click", click.Response);
            Assert.Empty(Steps(click));

            // The fixtures are still there, unchanged: nothing closed, moved or focused them.
            foreach (var f in new[] { main, twinA, twinB }) Assert.False(f.Process.HasExited);

            Log($"\nSUMMARY list={list.Outcome} inspect={insp.Outcome} ambiguous={amb.Outcome} missing={missing.Outcome} click={click.Outcome}");
            Assert.Equal("completed", list.Outcome);
            Assert.Equal("completed", insp.Outcome);
        }
        finally
        {
            // DIAGNOSTICS: client-side envelope trace and the complete daemon log, written to a new folder every run.
            try
            {
                string diag = Environment.GetEnvironmentVariable("DASK_7B1B_DIAG_DIR")
                    ?? Path.Combine(Root, "results", "phase7b3", "blocker-diag", DateTime.Now.ToString("yyyyMMddTHHmmss") + "-" + Guid.NewGuid().ToString("N")[..4]);
                Directory.CreateDirectory(diag);
                lock (_trace) File.WriteAllLines(Path.Combine(diag, "client-envelope-trace.txt"), _trace);
                lock (daemonLog) File.WriteAllLines(Path.Combine(diag, "daemon.log"), daemonLog);
                Log("DIAGNOSTICS " + diag);
            }
            catch (Exception ex) { Log("DIAGNOSTICS not written: " + ex.Message); }
            lock (daemonLog) foreach (var l in daemonLog.Where(l => l.Contains("Desktop call") || l.Contains("Protocol v2") || l.Contains("fail:") || l.Contains("[err]")).Take(40)) Log("[daemon] " + l);
            try { daemon.Kill(entireProcessTree: true); await daemon.WaitForExitAsync(); } catch { }
        }
    }
}
