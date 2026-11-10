using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Observation;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Xunit;
using Xunit.Abstractions;
using static DAsk.Daemon.Tests.Phase7B2LiveTests;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 7B.3 end-to-end over the REAL daemon process with execution enabled (appsettings AgentHost:DesktopActionExecution):
/// natural language → real agent host + local model → protocol v2 → OS-resolved target → policy → owner-only approval →
/// decision (this test plays the HUD's wire role, exactly as in Phase 7B.2) → single-use consumption → identity
/// revalidation → write-ahead audit → final gate → ONE Win32 call on the fixture → independent observation → result.
/// Every outcome is also checked here, independently, by reading the fixture window from the OS.
/// Observation and action are restricted to one disposable fixture window. Run with: --filter "Category=Phase7B3Live".
/// </summary>
[Collection("AgentHost")]
[Trait("Category", "Phase7B3Live")]
public class Phase7B3LiveTests
{
    private static readonly string Root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    private readonly ITestOutputHelper _output;
    public Phase7B3LiveTests(ITestOutputHelper output) => _output = output;
    private void Log(string s) { try { _output.WriteLine(s); } catch { } }

    private async Task<(string TaskId, ActionApprovalRequest Request, long Ms)> AskAsync(HudWire w, string objective)
    {
        var req = IpcEnvelope.Create(nameof(AgentTaskSubmitRequest), new AgentTaskSubmitRequest { Objective = objective });
        var sw = Stopwatch.StartNew();
        await w.SendAsync(req);
        _diag?.Note("submit", new { request = _diag.Redact(objective) });
        var ack = (await w.NextAsync(Tap(e => e.ReplyToId == req.Id), 30_000)).Env.DeserializePayload<AgentTaskSubmitResponse>()!;
        Assert.True(ack.Accepted, $"{ack.RejectionCode}: {ack.ErrorMessage}");
        var a = await w.NextAsync(Tap(e => e.Type == nameof(ActionApprovalRequest) || (e.Type == nameof(AgentTaskResultNotification) &&
            e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == ack.TaskId)), 180_000);
        Assert.True(a.Env.Type == nameof(ActionApprovalRequest), $"no approval: {a.Env.DeserializePayload<AgentTaskResultNotification>()?.Response}");
        Log($"\nREQUEST  {objective}\nMEASURED submit -> approval: {sw.ElapsedMilliseconds} ms");
        return (ack.TaskId!, a.Env.DeserializePayload<ActionApprovalRequest>()!, sw.ElapsedMilliseconds);
    }

    private async Task<AgentTaskResultNotification> ResultAsync(HudWire w, string taskId, int timeoutMs = 120_000)
    {
        var r = (await w.NextAsync(Tap(e => e.Type == nameof(AgentTaskResultNotification) && e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == taskId), timeoutMs))
            .Env.DeserializePayload<AgentTaskResultNotification>()!;
        Log($"OUTCOME  {r.Outcome}\nRESPONSE {r.Response}");
        return r;
    }

    private Task<(IpcEnvelope Env, int Bytes, DateTime At)> StateAsync(HudWire w, string approvalId, string? state = null, int timeoutMs = 40_000) =>
        w.NextAsync(Tap(e => e.Type == nameof(ApprovalStateNotification) && e.DeserializePayload<ApprovalStateNotification>() is { } n &&
            n.ApprovalId == approvalId && (state == null || n.State == state)), timeoutMs);

    // Phase 7B.3 round diagnostics: test-only observation of every envelope the test reads. It never changes what is
    // awaited, matched or asserted (the original predicate decides), and a recorder fault is swallowed.
    private RoundDiag? _diag;
    private Func<IpcEnvelope, bool> Tap(Func<IpcEnvelope, bool> match) => e => { try { _diag?.Observe(e); } catch { } return match(e); };

    private static WindowIdentity Os(Phase7B1bTests.Fixture fx)
    {
        var src = new Win32WindowSource();
        WindowIdentity? w = null;
        for (int i = 0; i < 20; i++) { w = src.Read(fx.Hwnd); if (w != null) break; Thread.Sleep(50); }
        return w!;
    }

    [Fact]
    public async Task Live_ApprovedWindowOperations_AreExecutedOnce_AndVerified()
    {
        for (int i = 0; i < 75 && Process.GetProcessesByName("llama-server").Length > 0; i++) await Task.Delay(200);
        foreach (var existing in Process.GetProcessesByName("llama-server")) Assert.Fail($"llama-server pid {existing.Id} is already running; this test needs a clean start");
        string exe = Path.Combine(Root, "src", "DAsk.Daemon", "bin", "Debug", "net8.0", "DAsk.Daemon.exe");
        Assert.True(File.Exists(exe), $"Build the daemon first: {exe}");

        string tag = Guid.NewGuid().ToString("N")[..6];
        using var fx = new Phase7B1bTests.Fixture($"DASK Exec Fixture {tag}", 90, 90);
        var baseline = Os(fx);
        Assert.False(baseline.Minimized || baseline.Maximized, "the fixture starts in the normal state");

        string pipe = "dask-7b3-live-" + Guid.NewGuid().ToString("N");
        var psi = new ProcessStartInfo { FileName = exe, WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        for (int i = 0; i < 2; i++) psi.Environment[$"DASK_Daemon__AllowedClientImagePaths__{i}"] = Environment.ProcessPath!;
        psi.Environment["DASK_Daemon__PipeName"] = pipe;
        psi.Environment["DASK_AgentHost__DesktopReadAllowedProcessIds__0"] = fx.Process.Id.ToString();
        psi.Environment["DASK_AgentHost__DesktopActionExecution"] = "true"; // explicit, independent of appsettings
        psi.Environment["DASK_AgentHost__ExtraEnvironment__DASK_AGENT_DIAGNOSTICS"] = "1"; // diagnostics: ids, fingerprints, flags on progress
        _diag = new RoundDiag(fx.Title);
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

            // ── 1. Minimize: approve → executed once → verified by the daemon AND by this test ──
            var (t1, r1, ms1) = await AskAsync(hud, $"Minimize the window titled \"{fx.Title}\"");
            measured["submitToApprovalMs_cold"] = ms1;
            Assert.Equal(DesktopActionRequestService.Performed, r1.ActionParameters["execution"]); // the user is told it will be done
            Assert.Equal(fx.Hwnd, r1.TargetHwnd);
            await Task.Delay(1_100);
            var sw = Stopwatch.StartNew();
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r1, true)));
            var res1 = await ResultAsync(hud, t1);
            measured["approveToVerifiedResultMs_minimize"] = sw.ElapsedMilliseconds;
            Assert.Equal("completed", res1.Outcome);
            Assert.Contains("Minimized", res1.Response);
            Assert.Contains("Verified", res1.Response);
            var os1 = Os(fx);
            Assert.True(os1.Minimized, "the OS confirms the fixture is minimized");
            Assert.Null(WindowIdentityRules.Mismatch(baseline, os1));
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r1, true))); // replayed decision
            Assert.False((await StateAsync(hud, r1.ApprovalId, timeoutMs: 5_000)).Env.DeserializePayload<ApprovalStateNotification>()!.DecisionAccepted ?? true);

            // ── 2. Restore: approve → normal state ──
            var (t2, r2, ms2) = await AskAsync(hud, $"Restore the window titled \"{fx.Title}\"");
            measured["submitToApprovalMs_warm"] = ms2;
            await Task.Delay(1_100);
            sw.Restart();
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r2, true)));
            var res2 = await ResultAsync(hud, t2);
            measured["approveToVerifiedResultMs_restore"] = sw.ElapsedMilliseconds;
            Assert.Equal("completed", res2.Outcome);
            var os2 = Os(fx);
            Assert.False(os2.Minimized || os2.Maximized, "the OS confirms the fixture is restored");

            // ── 3. Maximize, denied: nothing happens ──
            var (t3, r3, _) = await AskAsync(hud, $"Maximize the window titled \"{fx.Title}\"");
            await Task.Delay(1_100);
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r3, false)));
            var res3 = await ResultAsync(hud, t3);
            Assert.NotEqual("completed", res3.Outcome);
            Assert.Contains("You declined", res3.Response);
            Assert.False(Os(fx).Maximized, "denied: the fixture was not maximized");

            // ── 4. Focus: completed only if the OS shows the fixture in front (Windows may refuse; never claimed) ──
            var (t4, r4, _) = await AskAsync(hud, $"Bring the window titled \"{fx.Title}\" to the front");
            await Task.Delay(1_100);
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r4, true)));
            var res4 = await ResultAsync(hud, t4);
            var os4 = Os(fx);
            measured["focusOutcome"] = res4.Outcome;
            measured["focusOsForeground"] = os4.Foreground;
            if (res4.Outcome == "completed") Assert.True(os4.Foreground, "a completed focus must be visible in the OS");
            else Assert.Contains("could not confirm", res4.Response);

            // ── 5. Emergency Stop while the approval is pending: never executed ──
            var (t5, r5, _) = await AskAsync(hud, $"Maximize the window titled \"{fx.Title}\"");
            sw.Restart();
            await hud.SendAsync(IpcEnvelope.Create(nameof(EmergencyStopRequest), new EmergencyStopRequest { Source = "phase7b3-live", Reason = "pending approval", StopId = "7b3-" + Guid.NewGuid().ToString("N") }));
            await StateAsync(hud, r5.ApprovalId, ApprovalStates.InvalidatedByEmergencyStop, 10_000);
            measured["stopToApprovalInvalidatedMs"] = sw.ElapsedMilliseconds;
            var res5 = await ResultAsync(hud, t5, 30_000);
            Assert.NotEqual("completed", res5.Outcome);
            await hud.SendAsync(IpcEnvelope.Create(nameof(ActionApprovalResponse), Decision(r5, true)));
            Assert.False((await StateAsync(hud, r5.ApprovalId, timeoutMs: 5_000)).Env.DeserializePayload<ApprovalStateNotification>()!.DecisionAccepted ?? true);
            await Task.Delay(500);
            Assert.False(Os(fx).Maximized, "stopped: the fixture was never maximized");

            // Exactly the approved, executed operations happened: count the daemon's own records.
            string all; lock (daemonLog) all = string.Join("\n", daemonLog);
            var execLines = Regex.Matches(all, @"\[DesktopAction\] Desktop\.\w+ (\S*) for task \S+: (\S+) -> (\w+); verified=(\w+) \(([^)]*)\) in (\d+) ms");
            Log("\nEXECUTIONS\n" + string.Join("\n", execLines.Select(m => m.Value)));
            Assert.Equal(3, execLines.Count); // minimize, restore, focus: the denied and the stopped requests never reached the executor
            measured["verifyMs"] = execLines.Select(m => int.Parse(m.Groups[6].Value)).ToArray();
            Assert.Equal(Process.GetProcessesByName("powershell").Any(p => p.Id == fx.Process.Id), true);
            Log("\nMEASUREMENTS " + JsonSerializer.Serialize(measured));
        }
        finally
        {
            lock (daemonLog) foreach (var l in daemonLog.Where(l => l.Contains("DesktopAction") || l.Contains("AUTHORIZED") || l.Contains("consumed") || l.Contains("EMERGENCY") || l.Contains("fail:")).Take(80)) Log("[daemon] " + l);
            try { string[] snapshot; lock (daemonLog) snapshot = daemonLog.ToArray(); Log("\nROUND DIAG " + _diag!.Write(Root, tag, snapshot, Log)); }
            catch (Exception ex) { Log("ROUND DIAG write failed: " + ex.GetType().Name); }
            try { daemon.Kill(entireProcessTree: true); await daemon.WaitForExitAsync(); } catch { }
        }
    }
}

/// <summary>
/// Test-only correlated trace of each task's planning rounds, plan steps, approvals, verification and result.
/// Records ids, tool names, enums, counts, booleans and salted fingerprints. Never objectives, tool inputs,
/// model text, window titles or session tokens: free text is either classified into a fixed label or hashed.
/// </summary>
internal sealed class RoundDiag
{
    private readonly string _fixtureTitle;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly List<string> _events = new();
    private readonly object _gate = new();
    private string? _task; // the task currently awaited (one at a time in this test)
    private int _seq;

    public RoundDiag(string fixtureTitle) => _fixtureTitle = fixtureTitle;

    /// <summary>The fixture title replaced by a placeholder. Used only for this test's own fixed request templates.</summary>
    public string Redact(string s) => s.Replace(_fixtureTitle, "<fixture>");

    public static string H(string? s) => string.IsNullOrEmpty(s) ? "" :
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(s)))[..12].ToLowerInvariant();

    /// <summary>A fixed label for known agent / daemon messages; anything else is only hashed.</summary>
    public static string Classify(string? text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        if (text.Contains("Already asked for approval once")) return "agent-guard:asked-once";
        if (text.Contains("action_limit")) return "daemon:action_limit";
        if (text.Contains("Verified by a fresh observation")) return "verified-observation";
        if (text.Contains("could not confirm")) return "could-not-confirm";
        if (text.Contains("You declined")) return "declined";
        return "other#" + H(text);
    }

    public void Note(string kind, object data)
    {
        // Redacted as a whole line: the protocol's own result `facets` ids embed the requested window title.
        lock (_gate) _events.Add(Redact(JsonSerializer.Serialize(new { n = ++_seq, ms = _clock.ElapsedMilliseconds, kind, task = _task, data })));
    }

    public void Observe(IpcEnvelope e)
    {
        switch (e.Type)
        {
            case nameof(AgentTaskSubmitResponse):
                var ack = e.DeserializePayload<AgentTaskSubmitResponse>()!;
                if (ack.Accepted) _task = ack.TaskId;
                break;
            case nameof(AgentTaskProgressNotification):
                var p = e.DeserializePayload<AgentTaskProgressNotification>()!;
                Note("progress", new { task = p.TaskId, seq = p.Seq, data = SafeProgress(p.Data) });
                break;
            case nameof(ActionApprovalRequest):
                var a = e.DeserializePayload<ActionApprovalRequest>()!;
                a.ActionParameters.TryGetValue("state", out var st);
                a.ActionParameters.TryGetValue("execution", out var ex);
                Note("approval.request", new { approvalId = a.ApprovalId, actionType = a.ActionType, state = st,
                    execution = ex == null ? null : ex.StartsWith("Not performed") ? "approval-only" : "will-execute",
                    digest = a.ActionDigest is { Length: > 0 } d ? d[..Math.Min(16, d.Length)] : null, session = H(a.SessionId) });
                break;
            case nameof(ApprovalStateNotification):
                var s = e.DeserializePayload<ApprovalStateNotification>()!;
                Note("approval.state", new { approvalId = s.ApprovalId, state = s.State, decisionAccepted = s.DecisionAccepted, reason = Classify(s.Reason) });
                break;
            case nameof(AgentTaskResultNotification):
                var r = e.DeserializePayload<AgentTaskResultNotification>()!;
                Note("result", new { task = r.TaskId, outcome = r.Outcome, iterations = r.Iterations, toolCalls = r.ToolCalls, errorCode = r.ErrorCode,
                    response = Classify(r.Response), steps = SafeSteps(r.Steps), verification = SafeVerification(r.Verification) });
                break;
        }
    }

    // Progress data from the host: drop the model-written goal; keep ids, tools, enums, counts and booleans.
    private static object SafeProgress(JsonElement d)
    {
        var o = new Dictionary<string, object?>();
        foreach (var prop in d.EnumerateObject())
        {
            if (prop.NameEquals("goal")) continue;
            if (prop.NameEquals("error")) { o["error"] = Classify(prop.Value.ToString()); continue; }
            o[prop.Name] = prop.Value.Clone();
        }
        return o;
    }

    private static string? Str(JsonElement x, string name) => x.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static object? SafeSteps(JsonElement? steps) => steps is not { ValueKind: JsonValueKind.Array } a ? null :
        a.EnumerateArray().Select(x => new
        {
            id = Str(x, "id"), tool = Str(x, "tool"), status = Str(x, "status"),
            evidence = Classify(Str(x, "evidence")), error = Classify(Str(x, "error")),
        }).ToArray();

    private static object? SafeVerification(JsonElement? v) => v is not { ValueKind: JsonValueKind.Object } o ? null : new
    {
        independentlyVerified = o.GetProperty("independentlyVerified").GetBoolean(),
        criteriaSatisfied = o.GetProperty("criteriaSatisfied").ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => (bool?)null },
        method = Str(o, "method"),
        unexplainedCount = o.GetProperty("unexplained").GetArrayLength(),
        facets = o.GetProperty("facets").Clone(),
        grounding = o.GetProperty("grounding").Clone(),
    };

    /// <summary>Writes events.jsonl, a per-task analysis and the redacted daemon lines that correlate with them.</summary>
    public string Write(string root, string tag, string[] daemonLog, Action<string> log)
    {
        string dir = Path.Combine(root, "results", "phase7b3", "round-diag", DateTime.Now.ToString("yyyyMMdd'T'HHmmss") + "-" + tag);
        Directory.CreateDirectory(dir);
        string[] events; lock (_gate) events = _events.ToArray();
        File.WriteAllLines(Path.Combine(dir, "events.jsonl"), events);

        // Daemon lines that carry task / call / action correlation. Fixture title redacted; session ids hashed.
        var keep = new Regex(@"Desktop call|\[DesktopAction\]|action_limit|Approval|AUTHORIZED|consumed|EMERGENCY|task t[0-9a-f]{32} (accepted|finished)", RegexOptions.IgnoreCase);
        var session = new Regex(@"session ([0-9a-f]{16,})");
        var lines = daemonLog.Where(l => keep.IsMatch(l)).Select(l => session.Replace(Redact(l), m => $"session#{H(m.Groups[1].Value)}")).ToArray();
        File.WriteAllLines(Path.Combine(dir, "daemon-correlated.log"), lines);

        // Per-task analysis: rounds, steps with round and fingerprint, repeats, decision after each verification.
        var parsed = events.Select(x => JsonDocument.Parse(x).RootElement).ToArray();
        var tasks = new List<object>();
        foreach (var g in parsed.Where(x => x.GetProperty("task").ValueKind == JsonValueKind.String).GroupBy(x => x.GetProperty("task").GetString()!))
        {
            var ev = g.ToArray();
            var progress = ev.Where(x => x.GetProperty("kind").GetString() == "progress").Select(x => x.GetProperty("data").GetProperty("data")).ToArray();
            var plans = progress.Where(x => x.GetProperty("type").GetString() == "plan").ToArray();
            var steps = new List<(string Id, int Round, string Tool, string? Fp)>();
            foreach (var pl in plans)
            {
                int round = pl.GetProperty("iteration").GetInt32();
                var fps = pl.TryGetProperty("diag", out var dg)
                    ? dg.GetProperty("inputFingerprints").EnumerateArray().ToDictionary(f => f.GetProperty("stepId").GetString()!, f => f.GetProperty("fp").GetString())
                    : new Dictionary<string, string?>();
                var ids = pl.GetProperty("stepIds").EnumerateArray().Select(i => i.GetString()!).ToArray();
                var tools = pl.GetProperty("tools").EnumerateArray().Select(i => i.GetString()!).ToArray();
                for (int i = 0; i < ids.Length; i++) steps.Add((ids[i], round, tools[i], fps.GetValueOrDefault(ids[i])));
            }
            var finished = new Dictionary<string, string?>();
            foreach (var x in progress.Where(x => x.GetProperty("type").GetString() == "step.finished")) finished[x.GetProperty("stepId").GetString()!] = Str(x, "status");
            var decisions = new List<object>();
            for (int i = 0; i < progress.Length; i++)
            {
                if (progress[i].GetProperty("type").GetString() != "verification") continue;
                var next = progress.Skip(i + 1).FirstOrDefault(x => x.GetProperty("type").GetString() == "phase");
                decisions.Add(new
                {
                    afterRound = decisions.Count + 1,
                    independentlyVerified = progress[i].GetProperty("independentlyVerified").GetBoolean(),
                    diag = progress[i].TryGetProperty("diag", out var vd) ? vd.Clone() : (JsonElement?)null,
                    decision = next.ValueKind == JsonValueKind.Object && Str(next, "phase") == "replanning" ? "another-round" : "finish",
                });
            }
            var windowSteps = steps.Where(s => s.Tool is "desktop.focus_window" or "desktop.set_window_state").ToArray();
            var identical = windowSteps.Where(s => s.Fp != null).GroupBy(s => s.Fp).Where(x => x.Count() > 1)
                .Select(x => new { fp = x.Key, steps = x.Select(s => new { s.Id, s.Round }).ToArray(), sameRound = x.Select(s => s.Round).Distinct().Count() == 1 }).ToArray();
            var result = ev.LastOrDefault(x => x.GetProperty("kind").GetString() == "result");
            var submit = parsed.LastOrDefault(x => x.GetProperty("kind").GetString() == "submit" && x.GetProperty("n").GetInt32() < ev[0].GetProperty("n").GetInt32());
            tasks.Add(new
            {
                task = g.Key,
                request = submit.ValueKind == JsonValueKind.Object ? submit.GetProperty("data").GetProperty("request").GetString() : null,
                rounds = plans.Select(pl => pl.GetProperty("iteration").GetInt32()).Distinct().ToArray(),
                removedDuplicates = plans.Where(pl => pl.TryGetProperty("diag", out _))
                    .SelectMany(pl => pl.GetProperty("diag").GetProperty("removedDuplicateSteps").EnumerateArray().Select(r => r.Clone())).ToArray(),
                steps = steps.Select(s => new { s.Id, s.Round, s.Tool, s.Fp, status = finished.GetValueOrDefault(s.Id) }).ToArray(),
                windowActionSteps = windowSteps.Length,
                identicalWindowActions = identical,
                approvalRequests = ev.Count(x => x.GetProperty("kind").GetString() == "approval.request"),
                decisions,
                result = result.ValueKind == JsonValueKind.Object ? result.GetProperty("data").Clone() : (JsonElement?)null,
            });
        }
        var analysis = JsonSerializer.Serialize(tasks, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Path.Combine(dir, "analysis.json"), analysis);
        log(analysis);
        return dir;
    }
}
