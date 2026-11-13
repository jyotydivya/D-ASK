using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.State;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 4B-2A: approval-token security before native desktop input. An approval is accepted only if the policy engine issued
/// and the owner granted it, for exactly the canonical action and target that were approved, once, before it expires, and only
/// while the approved window is still the very same window in the OS. (Wire-level checks: Phase4B2AApprovalWireTests.cs.)
/// Run alone with:  --filter "FullyQualifiedName~Phase4B2A"
/// </summary>
public class Phase4B2AApprovalSecurityTests
{
    private const string Owner = "session_4b2a_owner";
    private const long Hwnd = 4242;
    private const int Pid = 777;
    private const string Image = "fixture.exe";
    private static readonly Dictionary<string, string> P = new() { ["text"] = "hello world" };
    private static readonly DateTimeOffset Started = new(DateTime.FromFileTimeUtc(Phase7B1bTests.T0), TimeSpan.Zero);

    // ── rig ───────────────────────────────────────────────────────────────────

    /// <summary>A policy engine whose OS view holds the approved window (or no OS view at all).</summary>
    private static (ActionPolicyEngine Policy, Phase7B1bTests.FakeWindows Os) Rig(bool withOs = true)
    {
        var os = new Phase7B1bTests.FakeWindows();
        os.Windows.Add(Phase7B1bTests.W(Hwnd, Pid, Image, "Fixture"));
        return (new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, null, withOs ? os : null), os);
    }

    private static ActionApprovalRequest Req(string id, TimeSpan? ttl = null, long hwnd = Hwnd, int pid = Pid, bool withStart = true, string image = Image) => new()
    {
        ApprovalId = id,
        ActionId = "act_" + id,
        ActionType = "SimulatedType",
        ActionParameters = new(P),
        ParametersSha256 = ActionPolicyEngine.ComputeCanonicalHash(P),
        TargetProcessName = image,
        TargetWindowTitle = "Fixture",
        TargetHwnd = hwnd,
        TargetProcessId = pid,
        TargetProcessCreationTime = withStart ? Started : null,
        SessionId = Owner,
        StopGeneration = 1,
        ExpiresAtUtc = DateTimeOffset.UtcNow + (ttl ?? TimeSpan.FromSeconds(20)),
        RiskLevel = "Elevated",
        Reason = "Phase 4B-2A test",
    };

    /// <summary>What a correct HUD sends back for the request the daemon showed it.</summary>
    private static ActionApprovalResponse Decision(ActionApprovalRequest shown, bool approved) => new()
    {
        ApprovalId = shown.ApprovalId,
        ActionId = shown.ActionId,
        ActionType = shown.ActionType,
        ParametersSha256 = shown.ParametersSha256,
        ActionDigest = shown.ActionDigest,
        Approved = approved,
    };

    /// <summary>Registers, shows and approves; returns the request exactly as the daemon normalised and displayed it.</summary>
    private static async Task<ActionApprovalRequest> GrantAsync(ActionPolicyEngine policy, ActionApprovalRequest request)
    {
        var task = policy.RequestApprovalAsync(request);
        Assert.True(policy.TryGetPendingRequest(request.ApprovalId, out var shown), "the approval should be pending");
        Assert.True(policy.SubmitApprovalDecision(Decision(shown, true), Owner));
        Assert.True((await task).Approved);
        return shown;
    }

    /// <summary>Presents an approval for consumption; every field defaults to exactly what was granted.</summary>
    private static (bool Ok, string? Error) Consume(ActionPolicyEngine policy, ActionApprovalRequest g, string? id = null,
        Dictionary<string, string>? parameters = null, long? hwnd = null, int? pid = null, DateTimeOffset? start = null,
        bool noStart = false, string? image = null, string session = Owner, string? actionId = null) =>
        policy.ValidateConsumedApproval(id ?? g.ApprovalId, actionId ?? g.ActionId, g.ActionType, parameters ?? new(g.ActionParameters),
            image ?? g.TargetProcessName, hwnd ?? g.TargetHwnd, pid ?? g.TargetProcessId,
            noStart ? null : (start ?? g.TargetProcessCreationTime), session, 1, false);

    // ── 1. invented approval ids ─────────────────────────────────────────────

    [Fact]
    public async Task Phase4B2A_InventedApprovalId_IsNeverAccepted_NorIsAPendingOneOrADecisionForAnUnissuedId()
    {
        var (policy, _) = Rig();
        var granted = await GrantAsync(policy, Req("appr_4b2a_real_0001"));

        var (ok, err) = Consume(policy, granted, id: "appr_4b2a_invented_9999");
        Assert.False(ok);
        Assert.Contains("never granted", err);

        // Pending (shown, not decided) is not granted.
        _ = policy.RequestApprovalAsync(Req("appr_4b2a_pending_0002"));
        Assert.False(Consume(policy, granted with { ApprovalId = "appr_4b2a_pending_0002", ActionId = "act_appr_4b2a_pending_0002" }).Ok);

        // A decision for an id the engine never issued creates nothing.
        Assert.False(policy.SubmitApprovalDecision(new ActionApprovalResponse { ApprovalId = "appr_4b2a_never_issued", ActionId = "x", ActionType = "SimulatedType", Approved = true }, Owner));
        Assert.Equal(1, policy.GrantedApprovalCount);
        Assert.True(Consume(policy, granted).Ok, "the real approval is unaffected");
    }

    // ── 2. modified parameters ───────────────────────────────────────────────

    [Fact]
    public async Task Phase4B2A_ModifiedParameters_AreRejected_TheApprovalBindsTheExactCanonicalAction()
    {
        var (policy, _) = Rig();
        var g = await GrantAsync(policy, Req("appr_4b2a_params_01"));

        foreach (var tampered in new[]
        {
            new Dictionary<string, string> { ["text"] = "hello world!" },
            new Dictionary<string, string> { ["text"] = "hello world", ["extra"] = "1" },
            new Dictionary<string, string>(),
            new Dictionary<string, string> { ["TEXT"] = "hello world" },
        })
        {
            var (ok, err) = Consume(policy, g, parameters: tampered);
            Assert.False(ok);
            Assert.Contains("hash mismatch", err);
        }
        Assert.False(Consume(policy, g, actionId: "act_other").Ok);
        Assert.True(Consume(policy, g).Ok, "only the exact approved action is authorized");
    }

    // ── 3. modified canonical hashes / digests ───────────────────────────────

    [Fact]
    public async Task Phase4B2A_ModifiedHashOrDigest_AtRegistrationOrDecision_GrantsNothing()
    {
        var (policy, _) = Rig();

        // Registration with a supplied hash that is not the daemon's canonical hash is refused outright.
        var refused = await policy.RequestApprovalAsync(Req("appr_4b2a_hash_reg") with { ParametersSha256 = new string('0', 64) });
        Assert.False(refused.Approved);
        Assert.Equal("IntegrityMismatch", refused.DecisionSource);
        Assert.Equal(0, policy.PendingApprovalCount);

        // A decision echoing a different parameter hash, or a different action digest, is an integrity failure.
        foreach (var (id, tamper) in new (string, Func<ActionApprovalResponse, ActionApprovalResponse>)[]
        {
            ("appr_4b2a_hash_dec", r => r with { ParametersSha256 = new string('a', 64) }),
            ("appr_4b2a_digest_dec", r => r with { ActionDigest = new string('b', 64) }),
            ("appr_4b2a_nodigest_dec", r => r with { ActionDigest = null }),
        })
        {
            var task = policy.RequestApprovalAsync(Req(id));
            Assert.True(policy.TryGetPendingRequest(id, out var shown));
            policy.SubmitApprovalDecision(tamper(Decision(shown, true)), Owner);
            var result = await task;
            Assert.False(result.Approved);
            Assert.Equal("IntegrityMismatch", result.DecisionSource);
            Assert.False(Consume(policy, shown).Ok);
        }
        Assert.Equal(0, policy.GrantedApprovalCount);
    }

    // ── 4. incorrect HWND / PID (and the former zero/empty wildcard) ─────────

    [Fact]
    public async Task Phase4B2A_WrongTargetIdentity_IsRejected_AndZeroOrEmptyIsNoLongerAWildcard()
    {
        var (policy, _) = Rig();
        var g = await GrantAsync(policy, Req("appr_4b2a_target_1"));

        Assert.Contains("HWND mismatch", Consume(policy, g, hwnd: Hwnd + 1).Error);
        Assert.Contains("Process ID mismatch", Consume(policy, g, pid: Pid + 1).Error);
        Assert.Contains("creation time mismatch", Consume(policy, g, start: Started.AddSeconds(1)).Error);
        Assert.Contains("process name mismatch", Consume(policy, g, image: "other.exe").Error);
        // The audit's bypass: a zero HWND/PID, a missing start time or an empty name used to skip the check.
        Assert.Contains("HWND mismatch", Consume(policy, g, hwnd: 0).Error);
        Assert.Contains("Process ID mismatch", Consume(policy, g, pid: 0).Error);
        Assert.Contains("creation time mismatch", Consume(policy, g, noStart: true).Error);
        Assert.Contains("process name mismatch", Consume(policy, g, image: "").Error);
        Assert.True(Consume(policy, g).Ok, "the exact approved target is still authorized");

        // The reverse: an approval for no window does not authorize acting on a window.
        var none = await GrantAsync(policy, Req("appr_4b2a_target_none", hwnd: 0));
        Assert.Contains("HWND mismatch", Consume(policy, none, hwnd: Hwnd).Error);
        Assert.True(Consume(policy, none).Ok);
    }

    [Fact]
    public async Task Phase4B2A_ApprovedWindowReplacedOrGone_IsRejectedAgainstTheLiveOs_AndTheApprovalIsBurnt()
    {
        var cases = new (string Name, Func<WindowIdentity?> Now)[]
        {
            ("handle reused by another process", () => Phase7B1bTests.W(Hwnd, Pid + 1, Image, "Fixture")),
            ("process replaced (same pid, new instance)", () => Phase7B1bTests.W(Hwnd, Pid, Image, "Fixture", created: Phase7B1bTests.T0 + 1)),
            ("another program", () => Phase7B1bTests.W(Hwnd, Pid, "evil.exe", "Fixture")),
            ("window gone", () => null),
        };
        foreach (var (name, now) in cases)
        {
            var (policy, os) = Rig();
            // The caller presents exactly the approved values: only the daemon's own OS re-read can tell.
            var g = await GrantAsync(policy, Req("appr_4b2a_live_" + Guid.NewGuid().ToString("N")[..8]));
            os.Now[Hwnd] = now();
            var (ok, err) = Consume(policy, g);
            Assert.False(ok, name);
            Assert.Contains("Security validation failed", err);
            Assert.Equal(0, policy.GrantedApprovalCount);
            os.Now.Clear();   // even if the window comes back, the burnt approval stays dead
            Assert.Contains("already been consumed", Consume(policy, g).Error);
        }
    }

    [Fact]
    public async Task Phase4B2A_WindowBoundApproval_IsNeverConsumedUnverified()
    {
        // No OS view: a window-bound approval can be granted (and shown) but never consumed.
        var (blind, _) = Rig(withOs: false);
        var g = await GrantAsync(blind, Req("appr_4b2a_blind_01"));
        Assert.Contains("cannot be re-verified", Consume(blind, g).Error);
        // An approval with no window is unaffected.
        var none = await GrantAsync(blind, Req("appr_4b2a_blind_none", hwnd: 0));
        Assert.True(Consume(blind, none).Ok);

        // With an OS view, an approval that does not name the process instance cannot be verified either.
        var (policy, _) = Rig();
        var noStart = await GrantAsync(policy, Req("appr_4b2a_nostart_1", withStart: false));
        Assert.Contains("process instance was replaced", Consume(policy, noStart).Error);
    }

    // ── 5. expiry and rejection ──────────────────────────────────────────────

    [Fact]
    public async Task Phase4B2A_ExpiredApproval_IsRejected_RetiredForGood_AndADeniedOneNeverExists()
    {
        var (policy, _) = Rig();
        var g = await GrantAsync(policy, Req("appr_4b2a_expiry_1", ttl: TimeSpan.FromMilliseconds(300)));
        await Task.Delay(450);
        Assert.Contains("expired", Consume(policy, g).Error);
        Assert.Equal(0, policy.GrantedApprovalCount);
        Assert.Contains("already been consumed", Consume(policy, g).Error);

        // Decided after it expired: never granted.
        var late = policy.RequestApprovalAsync(Req("appr_4b2a_expiry_2", ttl: TimeSpan.FromMilliseconds(200)));
        Assert.True(policy.TryGetPendingRequest("appr_4b2a_expiry_2", out var shownLate));
        var lateResult = await late;   // expires while pending
        Assert.False(lateResult.Approved);
        policy.SubmitApprovalDecision(Decision(shownLate, true), Owner);
        Assert.False(Consume(policy, shownLate).Ok);

        // Denied by the user: no record, and the id cannot be issued again.
        var task = policy.RequestApprovalAsync(Req("appr_4b2a_denied_1"));
        Assert.True(policy.TryGetPendingRequest("appr_4b2a_denied_1", out var shown));
        policy.SubmitApprovalDecision(Decision(shown, false), Owner);
        Assert.False((await task).Approved);
        Assert.Contains("never granted", Consume(policy, shown).Error);
        Assert.Equal(0, policy.GrantedApprovalCount);
    }

    // ── 6. reused approval ids ───────────────────────────────────────────────

    [Fact]
    public async Task Phase4B2A_ReusedApprovalId_IsReplayRejected_AndCanNeverBeIssuedOrGrantedAgain()
    {
        var (policy, _) = Rig();
        var g = await GrantAsync(policy, Req("appr_4b2a_reuse_01"));

        // An id that is granted and not yet used cannot be registered again (no new decision can replace the record).
        var dup = await policy.RequestApprovalAsync(Req("appr_4b2a_reuse_01"));
        Assert.False(dup.Approved);
        Assert.Contains("already issued", dup.RejectionReason);

        Assert.True(Consume(policy, g).Ok);
        Assert.Contains("already been consumed", Consume(policy, g).Error);

        // After use, the id can never be issued again either.
        var again = await policy.RequestApprovalAsync(Req("appr_4b2a_reuse_01"));
        Assert.False(again.Approved);
        Assert.Contains("already issued", again.RejectionReason);
        Assert.Equal(0, policy.PendingApprovalCount);
        Assert.Equal(0, policy.GrantedApprovalCount);
    }

    // ── 7. duplicate concurrent execution ────────────────────────────────────

    [Fact]
    public async Task Phase4B2A_ConcurrentConsumers_ExactlyOneSucceeds()
    {
        var (policy, _) = Rig();
        var g = await GrantAsync(policy, Req("appr_4b2a_race_0001"));
        using var go = new ManualResetEventSlim(false);
        var tasks = Enumerable.Range(0, 64).Select(_ => Task.Run(() => { go.Wait(); return Consume(policy, g).Ok; })).ToArray();
        go.Set();
        var results = await Task.WhenAll(tasks);
        Assert.Equal(1, results.Count(r => r));
        Assert.Equal(0, policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task Phase4B2A_ConcurrentDuplicateExecutionRequests_ExecuteExactlyOnce()
    {
        var (policy, _) = Rig();
        var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, new StateManager(NullLogger<StateManager>.Instance), policy);
        engine.SetPanicHotkeyStatus(true, "test hotkey", 0);
        try
        {
            var g = await GrantAsync(policy, Req("appr_4b2a_engine_race"));
            var request = new SimulatedActionRequest
            {
                ActionId = g.ActionId, ActionType = g.ActionType, Parameters = new(P), ApprovalId = g.ApprovalId,
                TargetProcessName = Image, TargetHwnd = Hwnd, TargetProcessId = Pid, TargetProcessCreationTime = Started,
                SessionId = Owner, StopGeneration = 1, SimulatedDurationMs = 20,
            };
            var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => engine.ExecuteSimulatedActionAsync(request, Owner))));
            Assert.Equal(1, results.Count(r => r.Success));
            Assert.All(results.Where(r => !r.Success), r => Assert.Equal("Blocked", r.Status));
        }
        finally { engine.Dispose(); }
    }

    // ── 8. who may decide ────────────────────────────────────────────────────

    [Fact]
    public async Task Phase4B2A_OnlyTheOwningSession_CanDecideOrConsume()
    {
        var (policy, _) = Rig();
        var task = policy.RequestApprovalAsync(Req("appr_4b2a_owner_01"));
        Assert.True(policy.TryGetPendingRequest("appr_4b2a_owner_01", out var shown));

        Assert.False(policy.SubmitApprovalDecision(Decision(shown, true), "session_intruder"));
        Assert.False(policy.SubmitApprovalDecision(Decision(shown, true) with { SessionId = Owner }, " "));
        Assert.Equal(1, policy.PendingApprovalCount);
        Assert.Equal(0, policy.GrantedApprovalCount);

        Assert.True(policy.SubmitApprovalDecision(Decision(shown, true), Owner));
        Assert.True((await task).Approved);
        Assert.Contains("Cross-session", Consume(policy, shown, session: "session_intruder").Error);
        Assert.True(Consume(policy, shown).Ok);
    }

    // ── 9. the valid path ────────────────────────────────────────────────────

    [Fact]
    public async Task Phase4B2A_ValidApproval_IsAuthorizedOnce_ThroughThePolicyEngineAndTheExecutionEngine()
    {
        var (policy, _) = Rig();
        var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, new StateManager(NullLogger<StateManager>.Instance), policy);
        engine.SetPanicHotkeyStatus(true, "test hotkey", 0);
        try
        {
            var g = await GrantAsync(policy, Req("appr_4b2a_valid_001"));
            var request = new SimulatedActionRequest
            {
                ActionId = g.ActionId, ActionType = g.ActionType, Parameters = new(P), ApprovalId = g.ApprovalId,
                TargetProcessName = Image, TargetHwnd = Hwnd, TargetProcessId = Pid, TargetProcessCreationTime = Started,
                SessionId = Owner, StopGeneration = 1, SimulatedDurationMs = 10,
            };
            var first = await engine.ExecuteSimulatedActionAsync(request, Owner);
            Assert.True(first.Success, first.ErrorMessage);
            var replay = await engine.ExecuteSimulatedActionAsync(request with { ActionId = g.ActionId }, Owner);
            Assert.False(replay.Success);
            Assert.Contains("already been consumed", replay.ErrorMessage);
        }
        finally { engine.Dispose(); }
    }

    // ── 10. structural guards ────────────────────────────────────────────────

    [Fact]
    public void Phase4B2A_Source_NoTargetWildcard_GrantsAreNeverOverwritten_AndProductionReVerifiesWindows()
    {
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        string policy = File.ReadAllText(Path.Combine(root, "src", "DAsk.Daemon", "Automation", "Policy", "ActionPolicyEngine.cs"));
        string program = File.ReadAllText(Path.Combine(root, "src", "DAsk.Daemon", "Program.cs"));

        Assert.DoesNotContain("targetHwnd != 0 && granted.TargetHwnd", policy);
        Assert.DoesNotContain("granted.TargetHwnd != 0 && targetHwnd != 0", policy);
        Assert.DoesNotContain("granted.TargetProcessId != 0 && targetProcessId != 0", policy);
        Assert.DoesNotContain("TargetProcessCreationTime.HasValue && targetProcessCreationTime.HasValue", policy);
        Assert.DoesNotMatch(new System.Text.RegularExpressions.Regex(@"_grantedApprovals\[[^\]]+\]\s*="), policy);
        Assert.Contains("_grantedApprovals.TryAdd(", policy);
        Assert.Matches(new System.Text.RegularExpressions.Regex(@"new ActionPolicyEngine\(logger, evidence, sp\.GetRequiredService<IWindowSource>\(\)\)"), program);
    }
}
