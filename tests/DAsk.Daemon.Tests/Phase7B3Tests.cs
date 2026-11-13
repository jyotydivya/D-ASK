using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DAsk.Daemon.Tests.Phase7B1bTests;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 7B.3 P0 — controlled execution of approved window operations. The pathway is the real one (policy engine,
/// single-use consumption, OS-identity revalidation, write-ahead audit, final gate, executor, independent verification);
/// windows and the executor are fakes except in the Real_* tests, which act only on a disposable fixture window.
/// </summary>
[Collection("AgentHost")]
public class Phase7B3Tests
{
    private const string Owner = "hud-session-owner";
    private const long Hwnd = 100;

    /// <summary>Records every call; optionally changes the fake OS state the way Windows would.</summary>
    private sealed class FakeExecutor : IWindowOperationExecutor
    {
        public readonly List<(long Hwnd, string Type, string? State)> Calls = new();
        public Action<long, string, string?>? Effect;
        public bool Throw;
        public WindowOperationAttempt Apply(long hwnd, string actionType, string? state)
        {
            lock (Calls) Calls.Add((hwnd, actionType, state));
            if (Throw) throw new InvalidOperationException("boom");
            Effect?.Invoke(hwnd, actionType, state);
            return new WindowOperationAttempt("fake", true, true, 0);
        }
    }

    private sealed class FailingRecorder : IEvidenceRecorder
    {
        public Task InitializeAsync(CancellationToken c = default) => Task.CompletedTask;
        public Task RecordEvidenceAsync(ExecutionEvidenceRecord r, CancellationToken c = default) => Task.CompletedTask;
        public Task<ExecutionEvidenceRecord?> GetEvidenceByIdAsync(string id, CancellationToken c = default) => Task.FromResult<ExecutionEvidenceRecord?>(null);
        public Task<IReadOnlyList<ExecutionEvidenceRecord>> GetEvidenceByTaskIdAsync(string t, CancellationToken c = default) => Task.FromResult<IReadOnlyList<ExecutionEvidenceRecord>>(Array.Empty<ExecutionEvidenceRecord>());
        public Task RecordSafetyAuditAsync(SafetyAuditRecord r, CancellationToken c = default) =>
            r.EventType == "DesktopActionExecutionAdmitted" ? Task.FromException(new IOException("disk full")) : Task.CompletedTask;
        public Task<IReadOnlyList<SafetyAuditRecord>> GetSafetyAuditRecordsAsync(int limit = 100, CancellationToken c = default) => Task.FromResult<IReadOnlyList<SafetyAuditRecord>>(Array.Empty<SafetyAuditRecord>());
    }

    private sealed class Rig : IDisposable
    {
        public readonly FakeWindows Windows = new();
        public readonly ActionPolicyEngine Policy;
        public readonly DesktopActionRequestService Service;
        public readonly FakeExecutor Executor = new();
        public readonly HashSet<string> Live = new() { Owner };
        public bool Stopped;
        public ulong Generation = 1;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly SqliteEvidenceRecorder? Recorder;
        public readonly string Db = Path.Combine(Path.GetTempPath(), $"dask-7b3-{Guid.NewGuid():N}.db");
        public Func<Task>? Hook;

        public Rig(bool enabled = true, bool journal = true, IEvidenceRecorder? recorder = null, int verifyMs = 300, bool withLiveness = true)
        {
            Recorder = journal && recorder == null ? new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, Db) : null;
            IEvidenceRecorder? ev = recorder ?? Recorder;
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, ev, Windows);   // Phase 4B-2A: the OS view used to re-verify a window-bound approval
            Policy.SetSessionLivenessGate(s => Live.Contains(s));
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Windows.Windows.Add(W(Hwnd, 4000, "notepad.exe", "Untitled - Notepad"));
            // The fake executor changes what the fake OS reports, as Windows would.
            Executor.Effect = (h, type, state) =>
            {
                var cur = Windows.Read(h)!;
                Windows.Now[h] = type == DesktopActionTypes.FocusWindow ? cur with { Foreground = true }
                    : state switch { "minimize" => cur with { Minimized = true, Maximized = false }, "maximize" => cur with { Maximized = true, Minimized = false }, _ => cur with { Minimized = false, Maximized = false } };
            };
            Service = new DesktopActionRequestService(new DesktopReadService(Windows, new FakeUia()), Policy, () => Stopped, () => Generation, ev,
                new DesktopActionOptions { ExecutionEnabled = enabled, VerifyTimeoutMs = verifyMs, TestHookBeforeFinalGate = () => Hook?.Invoke() ?? Task.CompletedTask },
                null, Executor, withLiveness ? s => Live.Contains(s) : null);
        }

        public Task<DesktopCallResult> Ask(object args, CancellationToken ct = default, string tool = DesktopActionRequestService.SetWindowStateTool) =>
            Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), ct);

        public async Task<ActionApprovalRequest> DeliveredAsync(int n = 1)
        {
            var until = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < until) { lock (Delivered) if (Delivered.Count >= n) return Delivered[n - 1]; await Task.Delay(5); }
            throw new TimeoutException("no approval reached the HUD");
        }

        public bool Decide(ActionApprovalRequest r, bool approved) =>
            Policy.SubmitApprovalDecision(new ActionApprovalResponse
            {
                ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                ActionDigest = r.ActionDigest, Approved = approved, DecisionSource = "UserExplicitConfirmation",
            }, Owner, () => Stopped, () => Generation);

        public async Task<DesktopCallResult> ApproveAsync(object args, CancellationToken ct = default, string tool = DesktopActionRequestService.SetWindowStateTool)
        {
            int n; lock (Delivered) n = Delivered.Count + 1; // counted BEFORE asking: delivery can be synchronous
            var call = Ask(args, ct, tool);
            var r = await DeliveredAsync(n);
            Assert.True(Decide(r, true));
            return await call;
        }

        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(Db); } catch { } }
    }

    private static readonly object Minimize = new { process = "notepad.exe", state = "minimize" };
    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);

    // ── approval-to-executor integration ──

    [Fact]
    public async Task Approved_IsExecutedOnce_AndVerifiedIndependently()
    {
        using var rig = new Rig();
        await rig.Recorder!.InitializeAsync();
        var res = await rig.ApproveAsync(Minimize);
        Assert.Equal("ok", res.Status);
        var j = J(res);
        Assert.True(j.GetProperty("executed").GetBoolean());
        Assert.True(j.GetProperty("verified").GetBoolean());
        Assert.Contains("minimized=True", j.GetProperty("observed").GetString());
        var call = Assert.Single(rig.Executor.Calls);
        Assert.Equal((Hwnd, DesktopActionTypes.SetWindowState, "minimize"), call); // exactly the approved action, on the approved window
        Assert.Equal(0, rig.Policy.GrantedApprovalCount);

        var events = (await rig.Recorder.GetSafetyAuditRecordsAsync()).Select(e => e.EventType).ToList();
        int admitted = events.IndexOf("DesktopActionExecutionAdmitted"), executed = events.IndexOf("DesktopActionExecuted"), verified = events.IndexOf("DesktopActionVerified");
        Assert.True(admitted >= 0 && executed >= 0 && verified >= 0, string.Join(",", events));
        Assert.True((await rig.Recorder.VerifyAuditChainAsync()).Ok);
    }

    [Theory]
    [InlineData("maximize")]
    [InlineData("restore")]
    public async Task OtherStates_AreExecutedAndVerified(string state)
    {
        using var rig = new Rig();
        if (state == "restore") rig.Windows.Windows[0] = rig.Windows.Windows[0] with { Minimized = true };
        var res = await rig.ApproveAsync(new { process = "notepad.exe", state });
        Assert.Equal("ok", res.Status);
        Assert.Equal((Hwnd, DesktopActionTypes.SetWindowState, state), Assert.Single(rig.Executor.Calls));
    }

    [Fact]
    public async Task Focus_IsExecutedAndVerified()
    {
        using var rig = new Rig();
        var res = await rig.ApproveAsync(new { process = "notepad.exe" }, tool: DesktopActionRequestService.FocusWindowTool);
        Assert.Equal("ok", res.Status);
        Assert.Equal((Hwnd, DesktopActionTypes.FocusWindow, (string?)null), Assert.Single(rig.Executor.Calls));
    }

    [Fact]
    public async Task ApprovalText_SaysExactlyWhatWillHappen()
    {
        using (var on = new Rig())
        {
            var call = on.Ask(Minimize);
            var r = await on.DeliveredAsync();
            Assert.Equal(DesktopActionRequestService.Performed, r.ActionParameters["execution"]);
            on.Decide(r, false);
            await call;
        }
        using (var off = new Rig(enabled: false))
        {
            var call = off.Ask(Minimize);
            var r = await off.DeliveredAsync();
            Assert.Equal(DesktopActionRequestService.NotPerformed, r.ActionParameters["execution"]);
            off.Decide(r, true);
            var res = await call;
            Assert.False(J(res).GetProperty("executed").GetBoolean()); // switch off: approval only, as in 7B.2
            Assert.Empty(off.Executor.Calls);
        }
    }

    [Fact]
    public async Task Denied_IsNeverExecuted()
    {
        using var rig = new Rig();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        rig.Decide(r, false);
        Assert.Equal("approval_denied", (await call).Error!.Code);
        Assert.Empty(rig.Executor.Calls);
    }

    // ── the final gate (tripped exactly between the write-ahead record and the event) ──

    [Fact]
    public async Task TargetReplacedOrReused_AtTheFinalGate_IsRefused()
    {
        using var rig = new Rig();
        rig.Hook = () => { rig.Windows.Now[Hwnd] = W(Hwnd, 4000, "notepad.exe", "Untitled - Notepad", created: T0 + 1); return Task.CompletedTask; };
        Assert.Equal("target_changed", (await rig.ApproveAsync(Minimize)).Error!.Code);
        rig.Windows.Now.Clear();
        rig.Hook = () => { rig.Windows.Now[Hwnd] = W(Hwnd, 5000, "notepad.exe", "Untitled - Notepad"); return Task.CompletedTask; };
        // A new task (one approval per call) on the same rig.
        Assert.Equal("target_changed", (await rig.ApproveAsync(Minimize)).Error!.Code);
        rig.Windows.Now.Clear();
        rig.Hook = () => { rig.Windows.Now[Hwnd] = null; return Task.CompletedTask; };
        Assert.Equal("target_disappeared", (await rig.ApproveAsync(Minimize)).Error!.Code);
        Assert.Empty(rig.Executor.Calls);
    }

    [Fact]
    public async Task EmergencyStop_EpochChange_LeaseLoss_AndCancellation_AtTheFinalGate_AreRefused()
    {
        using var rig = new Rig();
        rig.Hook = () => { rig.Stopped = true; return Task.CompletedTask; };
        Assert.Equal("emergency_stopped", (await rig.ApproveAsync(Minimize)).Error!.Code);
        rig.Stopped = false;

        rig.Hook = () => { rig.Generation = 2; return Task.CompletedTask; };
        Assert.Equal("emergency_stopped", (await rig.ApproveAsync(Minimize)).Error!.Code);

        using var rig2 = new Rig();
        rig2.Hook = () => { rig2.Live.Remove(Owner); return Task.CompletedTask; };
        Assert.Equal("hud_unavailable", (await rig2.ApproveAsync(Minimize)).Error!.Code);

        using var rig3 = new Rig();
        using var cts = new CancellationTokenSource();
        rig3.Hook = () => { cts.Cancel(); return Task.CompletedTask; };
        var r3 = await rig3.ApproveAsync(Minimize, cts.Token);
        Assert.NotEqual("ok", r3.Status);

        Assert.Empty(rig.Executor.Calls);
        Assert.Empty(rig2.Executor.Calls);
        Assert.Empty(rig3.Executor.Calls);
    }

    [Fact]
    public async Task EmergencyStop_BeforeApproval_PreventsEverything()
    {
        using var rig = new Rig();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        rig.Stopped = true;
        rig.Policy.InvalidateAllPendingAndGrantedApprovals("Emergency stop");
        Assert.Equal("emergency_stopped", (await call).Error!.Code);
        Assert.False(rig.Decide(r, true));
        Assert.Empty(rig.Executor.Calls);
    }

    [Fact]
    public async Task NoJournal_MeansNoExecution()
    {
        using (var rig = new Rig(journal: false))
        {
            var res = await rig.ApproveAsync(Minimize);
            Assert.False(J(res).GetProperty("executed").GetBoolean()); // not ready: approval only, and the approval said so
            Assert.Empty(rig.Executor.Calls);
        }
        using (var rig = new Rig(recorder: new FailingRecorder()))
        {
            Assert.Equal("journal_unavailable", (await rig.ApproveAsync(Minimize)).Error!.Code);
            Assert.Empty(rig.Executor.Calls);
        }
    }

    [Fact]
    public async Task NoLivenessSource_MeansNoExecution()
    {
        using var rig = new Rig(withLiveness: false);
        var res = await rig.ApproveAsync(Minimize);
        Assert.False(J(res).GetProperty("executed").GetBoolean());
        Assert.Empty(rig.Executor.Calls);
    }

    // ── verification and failure ──

    [Fact]
    public async Task VerificationFailure_IsReportedUnverified_NeverSuccess_AndNotRetried()
    {
        using var rig = new Rig();
        await rig.Recorder!.InitializeAsync();
        rig.Executor.Effect = null; // Windows "accepted" the call but nothing changed
        var res = await rig.ApproveAsync(Minimize);
        Assert.Equal("execution_unverified", res.Error!.Code);
        Assert.Single(rig.Executor.Calls);
        Assert.Contains("DesktopActionUnverified", (await rig.Recorder.GetSafetyAuditRecordsAsync()).Select(e => e.EventType));
    }

    [Fact]
    public async Task ExecutorFailure_IsReported_NotRetried()
    {
        using var rig = new Rig();
        rig.Executor.Throw = true;
        Assert.Equal("execution_failed", (await rig.ApproveAsync(Minimize)).Error!.Code);
        Assert.Single(rig.Executor.Calls);
    }

    [Fact]
    public async Task CancellationDuringVerification_IsNeverSuccess()
    {
        using var rig = new Rig(verifyMs: 5000);
        rig.Executor.Effect = null;
        using var cts = new CancellationTokenSource();
        rig.Executor.Effect = (_, _, _) => cts.CancelAfter(100);
        var res = await rig.ApproveAsync(Minimize, cts.Token);
        Assert.NotEqual("ok", res.Status);
        Assert.Single(rig.Executor.Calls);
    }

    [Fact]
    public async Task WindowReplacedDuringVerification_IsNotVerified()
    {
        using var rig = new Rig();
        rig.Executor.Effect = (h, _, _) => rig.Windows.Now[h] = W(h, 4000, "notepad.exe", "x", created: T0 + 1) with { Minimized = true };
        Assert.Equal("execution_unverified", (await rig.ApproveAsync(Minimize)).Error!.Code);
    }

    [Fact]
    public async Task ApprovalIsSingleUse_ReplayAndDuplicateDecisionsCannotExecuteAgain()
    {
        using var rig = new Rig();
        var call = rig.Ask(Minimize);
        var r = await rig.DeliveredAsync();
        Assert.True(rig.Decide(r, true));
        Assert.Equal("ok", (await call).Status);
        Assert.False(rig.Decide(r, true)); // duplicate decision
        var (valid, error) = rig.Policy.ValidateConsumedApproval(r.ApprovalId, r.ActionId, r.ActionType, r.ActionParameters, r.TargetProcessName,
            r.TargetHwnd, r.TargetProcessId, r.TargetProcessCreationTime, Owner, rig.Generation, false);
        Assert.False(valid);
        Assert.Contains("Replay", error);
        Assert.Single(rig.Executor.Calls);
    }

    [Fact]
    public async Task ExpiredApproval_IsNeverExecuted()
    {
        using var rig = new Rig();
        var svc = new DesktopActionRequestService(new DesktopReadService(rig.Windows, new FakeUia()), rig.Policy, () => false, () => 1, rig.Recorder,
            new DesktopActionOptions { ExecutionEnabled = true, ApprovalTtl = TimeSpan.FromMilliseconds(200) }, null, rig.Executor, s => true);
        var res = await svc.ExecuteAsync(DesktopActionRequestService.SetWindowStateTool, JsonSerializer.SerializeToElement(Minimize), new DesktopActionContext("t", "c", Owner), default);
        Assert.Equal("approval_expired", res.Error!.Code);
        Assert.Empty(rig.Executor.Calls);
    }

    [Fact]
    public void Verifier_RequiresTheApprovedWindowAndState()
    {
        var t = W(Hwnd, 4000, "notepad.exe", "x");
        Assert.True(WindowOperationVerifier.Check(DesktopActionTypes.SetWindowState, "minimize", t, t with { Minimized = true }).Verified);
        Assert.False(WindowOperationVerifier.Check(DesktopActionTypes.SetWindowState, "minimize", t, t).Verified);
        Assert.False(WindowOperationVerifier.Check(DesktopActionTypes.SetWindowState, "minimize", t, null).Verified);
        Assert.False(WindowOperationVerifier.Check(DesktopActionTypes.SetWindowState, "minimize", t, t with { Minimized = true, ProcessId = 5 }).Verified);
        Assert.True(WindowOperationVerifier.Check(DesktopActionTypes.SetWindowState, "restore", t, t).Verified);
        Assert.False(WindowOperationVerifier.Check(DesktopActionTypes.SetWindowState, "restore", t, t with { Maximized = true }).Verified);
        Assert.True(WindowOperationVerifier.Check(DesktopActionTypes.SetWindowState, "maximize", t, t with { Maximized = true }).Verified);
        Assert.False(WindowOperationVerifier.Check(DesktopActionTypes.FocusWindow, null, t, t).Verified);
        Assert.False(WindowOperationVerifier.Check("Desktop.Other", null, t, t with { Foreground = true }).Verified);
    }

    // ── the real executor, on a disposable fixture window only ──

    [Fact]
    public void Real_Executor_ChangesOnlyTheFixtureWindow_AndTheOsConfirmsIt()
    {
        using var fx = new Fixture($"DASK Exec Fixture {Guid.NewGuid():N}"[..28], 120, 120);
        var src = new Win32WindowSource();
        var exec = new Win32WindowOperationExecutor();
        var before = src.Read(fx.Hwnd)!;

        bool WaitFor(Func<WindowIdentity, bool> p) { for (int i = 0; i < 40; i++) { var w = src.Read(fx.Hwnd); if (w != null && p(w)) return true; Thread.Sleep(50); } return false; }

        Assert.True(exec.Apply(fx.Hwnd, DesktopActionTypes.SetWindowState, "minimize").Called);
        Assert.True(WaitFor(w => w.Minimized), "minimized");
        Assert.True(exec.Apply(fx.Hwnd, DesktopActionTypes.SetWindowState, "restore").Called);
        Assert.True(WaitFor(w => !w.Minimized && !w.Maximized), "restored");
        Assert.True(exec.Apply(fx.Hwnd, DesktopActionTypes.SetWindowState, "maximize").Called);
        Assert.True(WaitFor(w => w.Maximized), "maximized");
        Assert.True(exec.Apply(fx.Hwnd, DesktopActionTypes.SetWindowState, "restore").Called);
        Assert.True(WaitFor(w => !w.Minimized && !w.Maximized), "restored again");
        var after = src.Read(fx.Hwnd)!;
        Assert.Null(WindowIdentityRules.Mismatch(before, after)); // same window throughout
        Assert.Equal("none", exec.Apply(fx.Hwnd, DesktopActionTypes.SetWindowState, "close").Api); // nothing outside the allowed set
    }
}
