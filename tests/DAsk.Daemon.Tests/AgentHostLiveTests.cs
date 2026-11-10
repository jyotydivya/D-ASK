using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 5 end-to-end demonstration. No mock anywhere on the path:
///   this test (pipe client) → real DAsk.Daemon.exe → real stdio agent host → AgentRuntime →
///   real llama-server + Qwen2.5 GGUF → real tool → independent verification → back over the pipe.
/// Requires: dotnet build of the daemon, npm run build:agent-host, the pinned llama-server, and enough free
/// memory for the guard to admit the model. Run with: --filter "Category=Phase5Live".
/// </summary>
[Collection("AgentHost")]
[Trait("Category", "Phase5Live")]
public class AgentHostLiveTests
{
    private static readonly string Root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    private readonly ITestOutputHelper _output;
    public AgentHostLiveTests(ITestOutputHelper output) => _output = output;

    private sealed class LiveDaemon : IAsyncDisposable
    {
        public required Process Process { get; init; }
        public required NamedPipeClientStream Pipe { get; init; }
        public string PipeName = "";
        public async ValueTask DisposeAsync()
        {
            try { Pipe.Dispose(); } catch { }
            try { Process.Kill(entireProcessTree: true); await Process.WaitForExitAsync(); } catch { }
            Process.Dispose();
        }
    }

    private async Task<LiveDaemon> StartDaemonAsync(Action<ProcessStartInfo>? configure = null)
    {
        string exe = Path.Combine(Root, "src", "DAsk.Daemon", "bin", "Debug", "net8.0", "DAsk.Daemon.exe");
        Assert.True(File.Exists(exe), $"Build the daemon first: {exe}");
        Assert.True(File.Exists(Path.Combine(Root, "dist", "agent-host", "agent", "host", "stdioHost.js")), "Build the host first: npm run build:agent-host");

        string pipe = "dask-p5-live-" + Guid.NewGuid().ToString("N");
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = Root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // Allowlist exactly this test host, through the daemon's normal configuration (not a bypass).
        for (int i = 0; i < 2; i++) psi.Environment[$"DASK_Daemon__AllowedClientImagePaths__{i}"] = Environment.ProcessPath!;
        psi.Environment["DASK_Daemon__PipeName"] = pipe;
        configure?.Invoke(psi);

        var p = new Process { StartInfo = psi };
        p.OutputDataReceived += (_, e) => { if (e.Data != null && (e.Data.Contains("AgentHost") || e.Data.Contains("fail:") || e.Data.Contains("EMERGENCY"))) Try(() => _output.WriteLine("[daemon] " + e.Data)); };
        p.ErrorDataReceived += (_, e) => { if (e.Data != null) Try(() => _output.WriteLine("[daemon err] " + e.Data)); };
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();

        var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous);
        await client.ConnectAsync(30_000);
        await SendAsync(client, IpcEnvelope.Create(nameof(HandshakeRequest), new HandshakeRequest
        {
            ClientName = "Phase5Live",
            ProtocolVersion = IpcConstants.CurrentProtocolVersion,
            ClientProcessId = Environment.ProcessId,
            Capabilities = ["agent"],
        }));
        var hs = await ReadUntilAsync(client, e => e.Type == nameof(HandshakeResponse), 10_000);
        Assert.Equal("Accepted", hs.DeserializePayload<HandshakeResponse>()!.Status);
        return new LiveDaemon { Process = p, Pipe = client, PipeName = pipe };
    }

    private static void Try(Action a) { try { a(); } catch { /* the test has ended */ } }

    private static async Task SendAsync(Stream s, IpcEnvelope e)
    {
        await s.WriteAsync(e.ToLengthPrefixedBytes());
        await s.FlushAsync();
    }

    private static async Task<IpcEnvelope> ReadUntilAsync(Stream s, Func<IpcEnvelope, bool> match, int timeoutMs, List<IpcEnvelope>? seen = null)
    {
        using var cts = new CancellationTokenSource(timeoutMs);
        var header = new byte[4];
        while (true)
        {
            await s.ReadExactlyAsync(header, cts.Token);
            var body = new byte[BitConverter.ToUInt32(header)];
            await s.ReadExactlyAsync(body, cts.Token);
            var env = IpcEnvelope.FromJsonBytes(body)!;
            seen?.Add(env);
            if (match(env)) return env;
        }
    }

    private static async Task<AgentTaskSubmitResponse> SubmitAsync(Stream s, string objective, int timeoutMs = 30_000)
    {
        var req = IpcEnvelope.Create(nameof(AgentTaskSubmitRequest), new AgentTaskSubmitRequest { Objective = objective });
        await SendAsync(s, req);
        var r = await ReadUntilAsync(s, e => e.ReplyToId == req.Id, timeoutMs);
        return r.DeserializePayload<AgentTaskSubmitResponse>()!;
    }

    private static async Task<AgentHostHealthResponse> HealthAsync(Stream s)
    {
        var req = IpcEnvelope.Create(nameof(AgentHostHealthRequest), new AgentHostHealthRequest());
        await SendAsync(s, req);
        return (await ReadUntilAsync(s, e => e.ReplyToId == req.Id, 10_000)).DeserializePayload<AgentHostHealthResponse>()!;
    }

    private static Process[] LlamaServers() => Process.GetProcessesByName("llama-server");

    [Fact]
    public async Task Live_RealRequest_ThroughDaemon_Host_Runtime_LocalModel_Tool_Verification()
    {
        foreach (var existing in LlamaServers()) Assert.Fail($"llama-server pid {existing.Id} is already running; this test needs a clean start");

        await using var d = await StartDaemonAsync();
        var s = d.Pipe;

        var before = await HealthAsync(s);
        Assert.True(before.Enabled);
        Assert.Equal("stopped", before.State);

        // 1. A real question with a real tool. "(17+25)*2" is the Phase 4 defect.
        var total = Stopwatch.StartNew();
        var ack = await SubmitAsync(s, "What is (17+25)*2?");
        Assert.True(ack.Accepted, $"{ack.RejectionCode}: {ack.ErrorMessage}");
        _output.WriteLine($"MEASURED first submit acknowledged (host start included): {total.ElapsedMilliseconds} ms");
        var ready = await HealthAsync(s);
        Assert.Equal("ready", ready.State);
        Assert.NotNull(ready.Pid);
        Assert.Equal(1, Process.GetProcessesByName("node").Count(p => p.Id == ready.Pid));

        var seen = new List<IpcEnvelope>();
        var result = (await ReadUntilAsync(s, e => e.Type == nameof(AgentTaskResultNotification), 180_000, seen)).DeserializePayload<AgentTaskResultNotification>()!;
        _output.WriteLine($"MEASURED first task end to end, model load included: {total.ElapsedMilliseconds} ms");
        _output.WriteLine($"RESULT: {result.Outcome}: {result.Response}");
        _output.WriteLine($"STEPS: {result.Steps}");
        _output.WriteLine($"VERIFICATION: {result.Verification}");

        Assert.Equal(ack.TaskId, result.TaskId);
        Assert.Contains(seen, e => e.Type == nameof(AgentTaskProgressNotification));
        Assert.False(result.Interrupted);
        var steps = result.Steps!.Value.EnumerateArray().ToList();
        Assert.Contains(steps, st => st.GetProperty("tool").GetString() == "math.evaluate" && st.GetProperty("status").GetString() == "succeeded" && st.GetProperty("evidence").GetString() == "(17+25)*2 = 84");
        Assert.True(result.Verification!.Value.GetProperty("independentlyVerified").GetBoolean());
        Assert.Equal("completed", result.Outcome);
        Assert.Single(LlamaServers()); // loaded lazily by now; exactly one
        var mid = await HealthAsync(s);
        Assert.Equal("qwen2.5-0.5b-instruct-q4_k_m", mid.ModelId ?? "qwen2.5-0.5b-instruct-q4_k_m");

        // 2. Second request: model already loaded.
        var t2 = Stopwatch.StartNew();
        var ack2 = await SubmitAsync(s, "What time is it?");
        Assert.True(ack2.Accepted);
        var r2 = (await ReadUntilAsync(s, e => e.Type == nameof(AgentTaskResultNotification) && e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == ack2.TaskId, 120_000)).DeserializePayload<AgentTaskResultNotification>()!;
        _output.WriteLine($"MEASURED second task end to end: {t2.ElapsedMilliseconds} ms; outcome {r2.Outcome}");
        Assert.Equal("completed", r2.Outcome);

        // 3. An impossible request is never claimed completed.
        var ack3 = await SubmitAsync(s, "Send an email to my boss saying I'm late");
        Assert.True(ack3.Accepted);
        var r3 = (await ReadUntilAsync(s, e => e.Type == nameof(AgentTaskResultNotification) && e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == ack3.TaskId, 120_000)).DeserializePayload<AgentTaskResultNotification>()!;
        _output.WriteLine($"Impossible request outcome: {r3.Outcome}: {r3.Response}");
        Assert.NotEqual("completed", r3.Outcome);

        // 4. Cancellation during real inference.
        var ack4 = await SubmitAsync(s, "What is the total of 1+2+3+4+5+6+7+8+9+10 and also what time is it and how much memory do I have and what is in the docs folder?");
        Assert.True(ack4.Accepted);
        await Task.Delay(300);
        var cancelReq = IpcEnvelope.Create(nameof(AgentTaskCancelRequest), new AgentTaskCancelRequest { TaskId = ack4.TaskId! });
        var c = Stopwatch.StartNew();
        await SendAsync(s, cancelReq);
        var r4 = (await ReadUntilAsync(s, e => e.Type == nameof(AgentTaskResultNotification) && e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == ack4.TaskId, 30_000)).DeserializePayload<AgentTaskResultNotification>()!;
        _output.WriteLine($"MEASURED cancel during real inference to task ended: {c.ElapsedMilliseconds} ms; outcome {r4.Outcome}");
        Assert.Equal("cancelled", r4.Outcome);
        Assert.True(c.ElapsedMilliseconds < 2000, $"{c.ElapsedMilliseconds} ms");

        // 5. Emergency Stop through the daemon's real engine, during real inference.
        var ack5 = await SubmitAsync(s, "What is 1234*5678 and what time is it and how much RAM do I have?");
        Assert.True(ack5.Accepted);
        await Task.Delay(300);
        var stop = IpcEnvelope.Create(nameof(EmergencyStopRequest), new EmergencyStopRequest { Source = "phase5-live", Reason = "demonstration", StopId = "live-" + Guid.NewGuid().ToString("N") });
        var st5 = Stopwatch.StartNew();
        await SendAsync(s, stop);
        var stopSeen = new List<IpcEnvelope>();
        var stopResp = (await ReadUntilAsync(s, e => e.ReplyToId == stop.Id, 5_000, stopSeen)).DeserializePayload<EmergencyStopResponse>()!;
        var r5Env = stopSeen.FirstOrDefault(e => e.Type == nameof(AgentTaskResultNotification)) ?? await ReadUntilAsync(s, e => e.Type == nameof(AgentTaskResultNotification), 5_000);
        var r5 = r5Env.DeserializePayload<AgentTaskResultNotification>()!;
        _output.WriteLine($"MEASURED Emergency Stop during real inference to task ended: {st5.ElapsedMilliseconds} ms; outcome {r5.Outcome}");
        Assert.Equal("cancelled", r5.Outcome);
        Assert.True(st5.ElapsedMilliseconds < 1000, $"{st5.ElapsedMilliseconds} ms");
        var refused = await SubmitAsync(s, "What time is it?");
        Assert.Equal("emergency_stopped", refused.RejectionCode);

        var resume = IpcEnvelope.Create(nameof(ResumeExecutionRequest), new ResumeExecutionRequest { Source = "phase5-live", Reason = "demo over", ResumeId = "r1", StopGeneration = stopResp.StopGeneration });
        await SendAsync(s, resume);
        Assert.True((await ReadUntilAsync(s, e => e.ReplyToId == resume.Id, 5_000)).DeserializePayload<ResumeExecutionResponse>()!.Success);

        // 6. Host crash during a real task: detected, not replayed, recovered.
        var hostPid = (await HealthAsync(s)).Pid!.Value;
        var llamaPid = LlamaServers().Single().Id;
        var ack6 = await SubmitAsync(s, "What time is it and how much RAM do I have?");
        Assert.True(ack6.Accepted, $"{ack6.RejectionCode}: {ack6.ErrorMessage}");
        var killAt = Stopwatch.StartNew();
        Process.GetProcessById(hostPid).Kill(); // the host only, as a crash would be
        var r6 = (await ReadUntilAsync(s, e => e.Type == nameof(AgentTaskResultNotification) && e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == ack6.TaskId, 15_000)).DeserializePayload<AgentTaskResultNotification>()!;
        _output.WriteLine($"MEASURED crash detected, task reported interrupted: {killAt.ElapsedMilliseconds} ms; {r6.ErrorCode}");
        Assert.True(r6.Interrupted);
        Assert.Equal("failed", r6.Outcome);
        // Its model server does not linger: the host's job closed with the host.
        var gone = Stopwatch.StartNew();
        bool Dead(int pid) { try { using var p = Process.GetProcessById(pid); return p.HasExited; } catch (ArgumentException) { return true; } }
        while (!Dead(llamaPid) && gone.ElapsedMilliseconds < 3000) await Task.Delay(20);
        _output.WriteLine($"MEASURED crash: old llama-server gone {killAt.ElapsedMilliseconds} ms after the host was killed");
        Assert.True(Dead(llamaPid), "the crashed host's llama-server must not linger");

        AgentHostHealthResponse h6 = new();
        var deadline = DateTime.UtcNow.AddSeconds(30);
        do { await Task.Delay(100); h6 = await HealthAsync(s); } while ((h6.State != "ready" || h6.Pid == hostPid) && DateTime.UtcNow < deadline);
        _output.WriteLine($"MEASURED crash to ready again: {killAt.ElapsedMilliseconds} ms; new pid {h6.Pid}");
        Assert.Equal("ready", h6.State);
        Assert.NotEqual(hostPid, h6.Pid);
        Assert.Null(h6.ActiveTaskId); // nothing was replayed

        var t7 = Stopwatch.StartNew();
        var ack7 = await SubmitAsync(s, "What is 6*7?");
        Assert.True(ack7.Accepted, $"{ack7.RejectionCode}: {ack7.ErrorMessage}");
        var r7 = (await ReadUntilAsync(s, e => e.Type == nameof(AgentTaskResultNotification) && e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == ack7.TaskId, 120_000)).DeserializePayload<AgentTaskResultNotification>()!;
        _output.WriteLine($"MEASURED task after recovery, model reload included: {t7.ElapsedMilliseconds} ms; outcome {r7.Outcome}");
        Assert.Equal("completed", r7.Outcome);
        Assert.Single(LlamaServers()); // the old server is gone; no duplicate
        await Task.Delay(200);
    }

    [Fact]
    public async Task Live_DaemonDeath_LeavesNoHostOrModelServer()
    {
        foreach (var existing in LlamaServers()) Assert.Fail($"llama-server pid {existing.Id} is already running; this test needs a clean start");
        var d = await StartDaemonAsync();
        var ack = await SubmitAsync(d.Pipe, "What time is it?");
        Assert.True(ack.Accepted, $"{ack.RejectionCode}: {ack.ErrorMessage}");
        await ReadUntilAsync(d.Pipe, e => e.Type == nameof(AgentTaskResultNotification), 180_000);
        int hostPid = (await HealthAsync(d.Pipe)).Pid!.Value;
        int llamaPid = LlamaServers().Single().Id;

        // Hard kill of the daemon ONLY: no shutdown code runs. The job object must take the rest down.
        var sw = Stopwatch.StartNew();
        d.Process.Kill(entireProcessTree: false);
        await d.Process.WaitForExitAsync();
        bool Gone(int pid) { try { using var p = Process.GetProcessById(pid); return p.HasExited; } catch (ArgumentException) { return true; } }
        while ((!Gone(hostPid) || !Gone(llamaPid)) && sw.ElapsedMilliseconds < 5000) await Task.Delay(20);
        _output.WriteLine($"MEASURED daemon hard kill to host and llama-server gone: {sw.ElapsedMilliseconds} ms");
        Assert.True(Gone(hostPid), "agent host orphaned");
        Assert.True(Gone(llamaPid), "llama-server orphaned");
        await d.DisposeAsync();

        // A new daemon starts cleanly and has no memory of old tasks.
        await using var d2 = await StartDaemonAsync();
        var h = await HealthAsync(d2.Pipe);
        Assert.Equal("stopped", h.State);
        Assert.Null(h.ActiveTaskId);
    }
}
