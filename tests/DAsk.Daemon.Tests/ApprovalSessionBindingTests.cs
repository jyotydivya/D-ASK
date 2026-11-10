using System.Collections.Concurrent;
using System.Reflection;
using DAsk.Daemon.Automation.Policy;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 4B-1R.9b (H3-9), policy-engine level: an approval decision is accepted only from the authenticated
/// session that owns the approval request. These tests drive the real ActionPolicyEngine, i.e. the
/// authoritative decision point, not an IPC handler. Independent of H3-8.
/// Run alone with:  --filter "FullyQualifiedName~H39_"
/// </summary>
public class ApprovalSessionBindingTests
{
    private const string OwnerA = "sess_owner_A";
    private const string OwnerB = "sess_foreign_B";

    private static ActionPolicyEngine NewPolicy() => new(NullLogger<ActionPolicyEngine>.Instance, null);

    private static readonly Dictionary<string, string> Params = new() { ["text"] = "hello" };
    private static readonly string ParamsHash = ActionPolicyEngine.ComputeCanonicalHash(Params);

    private static ActionApprovalRequest Req(string approvalId, string owner, TimeSpan? ttl = null, string actionId = "act_h39") => new()
    {
        ApprovalId = approvalId,
        ActionId = actionId,
        ActionType = "SimulatedType",
        ActionParameters = Params,
        ParametersSha256 = ParamsHash,
        SessionId = owner,
        StopGeneration = 1,
        ExpiresAtUtc = DateTimeOffset.UtcNow + (ttl ?? TimeSpan.FromMinutes(1)),
    };

    /// <summary>
    /// A decision as it would arrive over the wire. The payload's own SessionId is attacker-controlled and
    /// must never matter, so tests deliberately put the OWNER's id there for foreign submissions.
    /// </summary>
    private static ActionApprovalResponse Resp(string approvalId, bool approved, string? claimedSession = OwnerA, string actionId = "act_h39") => new()
    {
        ApprovalId = approvalId,
        ActionId = actionId,
        ActionType = "SimulatedType",
        ParametersSha256 = ParamsHash,
        Approved = approved,
        SessionId = claimedSession,
        StopGeneration = 1,
    };

    private static bool Decide(ActionPolicyEngine policy, ActionApprovalResponse response, string? callerSessionId)
        => Submit(policy, response, callerSessionId, null, null);

    // `caller!` passes null/whitespace through on purpose: the engine must refuse it.
    private static bool Submit(ActionPolicyEngine policy, ActionApprovalResponse response, string? caller, Func<bool>? stop, Func<ulong>? gen)
        => policy.SubmitApprovalDecision(response.WithDigest(policy), caller!, stop, gen);

    private static async Task<ActionApprovalResponse> Completed(Task<ActionApprovalResponse> t, string because = "")
    {
        var finished = await Task.WhenAny(t, Task.Delay(TimeSpan.FromSeconds(3)));
        Assert.True(ReferenceEquals(finished, t), "the approval request should have completed. " + because);
        return await t;
    }

    private static async Task AssertStillPending(Task<ActionApprovalResponse> t, ActionPolicyEngine policy, string because)
    {
        await Task.Delay(100);
        Assert.False(t.IsCompleted, because);
        Assert.Equal(1, policy.PendingApprovalCount);
    }

    private static void InjectGranted(ActionPolicyEngine policy, GrantedApprovalRecord record)
    {
        var field = typeof(ActionPolicyEngine).GetField("_grantedApprovals", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var dict = (ConcurrentDictionary<string, GrantedApprovalRecord>)field.GetValue(policy)!;
        dict[record.ApprovalId] = record;
    }

    private static GrantedApprovalRecord Granted(string approvalId, string owner) => new()
    {
        ApprovalId = approvalId,
        ActionId = "act_h39",
        ActionType = "SimulatedType",
        CanonicalParameters = Params,
        ParametersSha256 = ParamsHash,
        TargetHwnd = 0,
        TargetProcessId = 0,
        TargetProcessName = string.Empty,
        TargetProcessCreationTime = null,
        RiskLevel = ActionRiskLevel.Elevated,
        SessionId = owner,
        StopGeneration = 1,
        CreatedAtUtc = DateTimeOffset.UtcNow,
        ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1),
    };

    private static (bool ok, string? err) Consume(ActionPolicyEngine policy, string approvalId, string? session)
        => policy.ValidateConsumedApproval(approvalId, "act_h39", "SimulatedType", Params, "", 0, 0, null, session!, 1, false);

    // ───────── owner decisions ─────────

    [Fact]
    public async Task H39_Owner_CanApproveOwnPendingRequest()
    {
        var policy = NewPolicy();
        var task = policy.RequestApprovalAsync(Req("appr_h39_own_ok", OwnerA));

        Assert.True(Decide(policy, Resp("appr_h39_own_ok", true), OwnerA));

        var result = await Completed(task);
        Assert.True(result.Approved);
        Assert.Equal(0, policy.PendingApprovalCount);
        Assert.Equal(1, policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task H39_Owner_CanRejectOwnPendingRequest()
    {
        var policy = NewPolicy();
        var task = policy.RequestApprovalAsync(Req("appr_h39_own_no", OwnerA));

        Assert.True(Decide(policy, Resp("appr_h39_own_no", false), OwnerA));

        var result = await Completed(task);
        Assert.False(result.Approved);
        Assert.Equal(0, policy.PendingApprovalCount);
        Assert.Equal(0, policy.GrantedApprovalCount);
    }

    // ───────── foreign decisions ─────────

    [Fact]
    public async Task H39_ForeignSession_CannotApprove_OwnersRequestStaysPending_OwnerStillDecides()
    {
        var policy = NewPolicy();
        var task = policy.RequestApprovalAsync(Req("appr_h39_foreign_ok", OwnerA));

        // The attacker even claims the owner's session id inside the payload; only the transport identity counts.
        Assert.False(Decide(policy, Resp("appr_h39_foreign_ok", true, claimedSession: OwnerA), OwnerB));

        await AssertStillPending(task, policy, "a foreign approve must not complete or consume the owner's request");
        Assert.Equal(0, policy.GrantedApprovalCount);

        Assert.True(Decide(policy, Resp("appr_h39_foreign_ok", true), OwnerA));
        Assert.True((await Completed(task)).Approved);
        Assert.Equal(1, policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task H39_ForeignSession_CannotReject_OwnersRequestStaysPending_OwnerStillApproves()
    {
        var policy = NewPolicy();
        var task = policy.RequestApprovalAsync(Req("appr_h39_foreign_no", OwnerA));

        Assert.False(Decide(policy, Resp("appr_h39_foreign_no", false, claimedSession: OwnerA), OwnerB));

        await AssertStillPending(task, policy, "a foreign reject must not cancel the owner's request (no denial of service)");

        Assert.True(Decide(policy, Resp("appr_h39_foreign_no", true), OwnerA));
        Assert.True((await Completed(task)).Approved);
    }

    [Fact]
    public async Task H39_KnowingTheApprovalId_IsNotACredential_EvenWithSpoofedPayloadSession()
    {
        var policy = NewPolicy();
        var request = Req("appr_h39_known_id", OwnerA);
        var task = policy.RequestApprovalAsync(request);

        // B has the exact id, action id, hash and parameters, and puts A's session id in the payload.
        var forged = Resp(request.ApprovalId, true, claimedSession: request.SessionId, actionId: request.ActionId);
        Assert.False(Decide(policy, forged, OwnerB));
        Assert.False(Decide(policy, forged with { SessionId = null }, OwnerB));
        Assert.False(Decide(policy, forged with { SessionId = OwnerB }, OwnerB));

        await AssertStillPending(task, policy, "no foreign attempt may consume the request");
        Assert.Equal(0, policy.GrantedApprovalCount);

        policy.InvalidateApprovalsForSession(OwnerA, "test cleanup");
        await Completed(task);
    }

    [Fact]
    public async Task H39_Concurrent_OwnerAndForeignDecisions_ForeignNeverWins()
    {
        for (int i = 0; i < 100; i++)
        {
            var policy = NewPolicy();
            string id = $"appr_h39_race_{i:D3}";
            var task = policy.RequestApprovalAsync(Req(id, OwnerA));

            using var barrier = new Barrier(2);
            // The foreign session tries to APPROVE; the owner REJECTS. If the foreign decision ever won, the
            // request would come back approved.
            var foreign = Task.Run(() => { barrier.SignalAndWait(); return Decide(policy, Resp(id, true), OwnerB); });
            var owner = Task.Run(() => { barrier.SignalAndWait(); return Decide(policy, Resp(id, false), OwnerA); });
            await Task.WhenAll(foreign, owner);

            Assert.False(foreign.Result, $"iteration {i}: the foreign decision must be refused");
            Assert.True(owner.Result, $"iteration {i}: the owner's decision must be accepted");
            var result = await Completed(task);
            Assert.False(result.Approved, $"iteration {i}: the foreign approval won the race");
            Assert.Equal(0, policy.GrantedApprovalCount);
            Assert.Equal(0, policy.PendingApprovalCount);
        }
    }

    // ───────── missing identities ─────────

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task H39_EmptyOwner_IsRejectedAtRegistration(string owner)
    {
        var policy = NewPolicy();
        var task = policy.RequestApprovalAsync(Req("appr_h39_no_owner", owner));

        var result = await Completed(task, "an approval request without an owning session must be rejected immediately");
        Assert.False(result.Approved);
        Assert.Equal(0, policy.PendingApprovalCount);
        Assert.Equal(0, policy.GrantedApprovalCount);
        Assert.Contains("owning session", result.RejectionReason, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task H39_EmptyCaller_IsRejectedAtDecision_PendingStaysIntact(string? caller)
    {
        var policy = NewPolicy();
        var task = policy.RequestApprovalAsync(Req("appr_h39_no_caller", OwnerA));

        Assert.False(Decide(policy, Resp("appr_h39_no_caller", true), caller));

        await AssertStillPending(task, policy, "an anonymous decision must not consume the request");
        Assert.Equal(0, policy.GrantedApprovalCount);

        Assert.True(Decide(policy, Resp("appr_h39_no_caller", false), OwnerA));
        await Completed(task);
    }

    // ───────── consumption ─────────

    [Fact]
    public async Task H39_SameSession_GrantedApproval_ConsumesOnce_ReplayRejected()
    {
        var policy = NewPolicy();
        var task = policy.RequestApprovalAsync(Req("appr_h39_consume", OwnerA));
        Assert.True(Decide(policy, Resp("appr_h39_consume", true), OwnerA));
        Assert.True((await Completed(task)).Approved);

        var (ok, err) = Consume(policy, "appr_h39_consume", OwnerA);
        Assert.True(ok, err);

        var (replayOk, replayErr) = Consume(policy, "appr_h39_consume", OwnerA);
        Assert.False(replayOk);
        Assert.Contains("Replay rejected", replayErr);
    }

    [Fact]
    public async Task H39_CrossSession_Consumption_IsRejected_AndLeavesGrantUsableByOwner()
    {
        var policy = NewPolicy();
        var task = policy.RequestApprovalAsync(Req("appr_h39_xconsume", OwnerA));
        Assert.True(Decide(policy, Resp("appr_h39_xconsume", true), OwnerA));
        await Completed(task);

        var (foreignOk, foreignErr) = Consume(policy, "appr_h39_xconsume", OwnerB);
        Assert.False(foreignOk);
        Assert.Contains("Cross-session", foreignErr);
        Assert.Equal(1, policy.GrantedApprovalCount);

        Assert.True(Consume(policy, "appr_h39_xconsume", OwnerA).ok);
    }

    [Theory]
    [InlineData(OwnerA, "")]
    [InlineData(OwnerA, "   ")]
    [InlineData("", OwnerA)]
    [InlineData("   ", OwnerA)]
    [InlineData("", "")]
    public void H39_Consumption_FailsClosed_WhenGrantedOwnerOrCallerIsEmpty(string grantedOwner, string caller)
    {
        var policy = NewPolicy();
        InjectGranted(policy, Granted("appr_h39_inject", grantedOwner));

        var (ok, err) = Consume(policy, "appr_h39_inject", caller);

        Assert.False(ok, "an empty granted-owner or caller identity must not skip the session check");
        Assert.NotNull(err);
        Assert.Equal(1, policy.GrantedApprovalCount);   // refused, not consumed
    }

    [Fact]
    public void H39_Consumption_FailsClosed_WhenCallerIsNull()
    {
        var policy = NewPolicy();
        InjectGranted(policy, Granted("appr_h39_inject_null", OwnerA));

        Assert.False(Consume(policy, "appr_h39_inject_null", null).ok);
    }

    // ───────── lifecycle: expiry, cancellation, disconnect, Stop, reconnect ─────────

    [Fact]
    public async Task H39_Expired_Approval_CannotBeDecided_ByOwnerOrForeign()
    {
        var policy = NewPolicy();
        var task = policy.RequestApprovalAsync(Req("appr_h39_expiry", OwnerA, ttl: TimeSpan.FromMilliseconds(60)));

        var result = await Completed(task);
        Assert.Equal("TimeoutDenied", result.DecisionSource);

        Assert.False(Decide(policy, Resp("appr_h39_expiry", true), OwnerA));
        Assert.False(Decide(policy, Resp("appr_h39_expiry", true), OwnerB));
        Assert.Equal(0, policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task H39_Cancelled_Approval_CannotBeDecided()
    {
        var policy = NewPolicy();
        using var cts = new CancellationTokenSource();
        var task = policy.RequestApprovalAsync(Req("appr_h39_cancel", OwnerA), cts.Token);
        cts.Cancel();

        var result = await Completed(task);
        Assert.False(result.Approved);

        Assert.False(Decide(policy, Resp("appr_h39_cancel", true), OwnerA));
        Assert.Equal(0, policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task H39_Disconnect_InvalidatesOnlyThatSessionsApprovals()
    {
        var policy = NewPolicy();
        var pendA = policy.RequestApprovalAsync(Req("appr_h39_disc_a_pend", OwnerA, actionId: "act_a"));
        var pendB = policy.RequestApprovalAsync(Req("appr_h39_disc_b_pend", OwnerB, actionId: "act_b"));
        var grantA = policy.RequestApprovalAsync(Req("appr_h39_disc_a_gran", OwnerA));
        Assert.True(Decide(policy, Resp("appr_h39_disc_a_gran", true), OwnerA));
        await Completed(grantA);

        int removed = policy.InvalidateApprovalsForSession(OwnerA, "Client disconnected");

        Assert.Equal(2, removed);
        Assert.Equal("SessionDisconnectedDenied", (await Completed(pendA)).DecisionSource);
        Assert.False(Decide(policy, Resp("appr_h39_disc_a_pend", true), OwnerA));
        Assert.False(Consume(policy, "appr_h39_disc_a_gran", OwnerA).ok);

        // B is untouched and can still decide its own request.
        Assert.False(pendB.IsCompleted);
        Assert.True(Decide(policy, Resp("appr_h39_disc_b_pend", false, claimedSession: OwnerB, actionId: "act_b"), OwnerB));
        await Completed(pendB);
    }

    [Fact]
    public async Task H39_Stop_InvalidatesPendingAndGranted_ForEverySession()
    {
        var policy = NewPolicy();
        var pend = policy.RequestApprovalAsync(Req("appr_h39_stop_pend", OwnerA, actionId: "act_p"));
        var gran = policy.RequestApprovalAsync(Req("appr_h39_stop_gran", OwnerB));
        Assert.True(Decide(policy, Resp("appr_h39_stop_gran", true, claimedSession: OwnerB), OwnerB));
        await Completed(gran);

        policy.InvalidateAllPendingAndGrantedApprovals("Emergency stop");

        Assert.Equal("EmergencyStopDenied", (await Completed(pend)).DecisionSource);
        Assert.False(Decide(policy, Resp("appr_h39_stop_pend", true, actionId: "act_p"), OwnerA));
        Assert.False(Consume(policy, "appr_h39_stop_gran", OwnerB).ok);
        Assert.Equal(0, policy.GrantedApprovalCount);
    }

    [Fact]
    public async Task H39_Stop_Active_DeniesOwnersDecision_ButOwnershipStillChecked()
    {
        var policy = NewPolicy();
        var task = policy.RequestApprovalAsync(Req("appr_h39_stop_latch", OwnerA));

        // A foreign decision during a Stop is refused before it can influence the request at all.
        Assert.False(Submit(policy, Resp("appr_h39_stop_latch", true), OwnerB, () => true, () => 1UL));
        Assert.False(task.IsCompleted);

        // The owner's decision during a Stop is converted to a denial (existing behaviour preserved).
        Submit(policy, Resp("appr_h39_stop_latch", true), OwnerA, () => true, () => 1UL);
        var result = await Completed(task);
        Assert.False(result.Approved);
        Assert.Equal("EmergencyStopDenied", result.DecisionSource);
    }

    [Fact]
    public async Task H39_Reconnect_NewSessionIdentity_InheritsNothing()
    {
        var policy = NewPolicy();
        var pend = policy.RequestApprovalAsync(Req("appr_h39_recon_pend", OwnerA, actionId: "act_r"));
        var gran = policy.RequestApprovalAsync(Req("appr_h39_recon_gran", OwnerA));
        Assert.True(Decide(policy, Resp("appr_h39_recon_gran", true), OwnerA));
        await Completed(gran);

        // While the old connection is still registered, a fresh identity is simply a foreign session.
        const string reconnected = "sess_owner_A_reconnected";
        Assert.False(Decide(policy, Resp("appr_h39_recon_pend", true, actionId: "act_r"), reconnected));
        Assert.False(Consume(policy, "appr_h39_recon_gran", reconnected).ok);

        // The old connection drops: its approvals are invalidated, and the reconnected identity still has none.
        policy.InvalidateApprovalsForSession(OwnerA, "Client disconnected");
        await Completed(pend);
        Assert.False(Decide(policy, Resp("appr_h39_recon_pend", true, actionId: "act_r"), reconnected));
        Assert.False(Consume(policy, "appr_h39_recon_gran", reconnected).ok);
        Assert.False(Consume(policy, "appr_h39_recon_gran", OwnerA).ok);
    }

    // ───────── atomic compare-and-remove: API and equality pins ─────────

    [Fact]
    public void H39_CachedApproval_UsesReferenceEquality_NoValueEqualityOverride()
    {
        // ConcurrentDictionary.TryRemove(KeyValuePair) compares values with EqualityComparer<TValue>.Default.
        // That is only an identity check if CachedApproval does not override Equals.
        var declared = typeof(CachedApproval).GetMethod("Equals", new[] { typeof(object) });
        Assert.NotNull(declared);
        Assert.Equal(typeof(object), declared!.DeclaringType);
        Assert.False(typeof(IEquatable<CachedApproval>).IsAssignableFrom(typeof(CachedApproval)));
        Assert.False(typeof(CachedApproval).IsValueType);

        var request = Req("appr_h39_equality", OwnerA);
        var a = new CachedApproval { Request = request };
        var b = new CachedApproval { Request = request };   // equivalent contents, different instance
        Assert.False(a.Equals(b));
    }

    [Fact]
    public void H39_ConcurrentDictionary_TryRemoveKeyValuePair_RemovesOnlyTheExactInstance()
    {
        var dict = new ConcurrentDictionary<string, CachedApproval>();
        var request = Req("appr_h39_cas", OwnerA);
        var original = new CachedApproval { Request = request };
        var equivalentReplacement = new CachedApproval { Request = request };

        Assert.True(dict.TryAdd("k", original));
        // The entry was swapped for an equivalent one after it had been checked.
        dict["k"] = equivalentReplacement;

        Assert.False(dict.TryRemove(new KeyValuePair<string, CachedApproval>("k", original)),
            "removing the checked instance must not remove an equivalent replacement");
        Assert.True(dict.TryGetValue("k", out var present));
        Assert.Same(equivalentReplacement, present);

        Assert.True(dict.TryRemove(new KeyValuePair<string, CachedApproval>("k", equivalentReplacement)));
        Assert.True(dict.IsEmpty);
    }

    // ───────── audit ─────────

    public enum AuditMode { Record, ThrowSynchronously, ReturnFaultedTask }

    /// <summary>Fails only for ApprovalOwnershipViolation events, so owner decisions elsewhere are unaffected.</summary>
    private sealed class FakeRecorder : DAsk.Daemon.Research.IEvidenceRecorder
    {
        private readonly AuditMode _mode;
        public FakeRecorder(AuditMode mode) => _mode = mode;
        public ConcurrentQueue<DAsk.Daemon.Research.SafetyAuditRecord> Records { get; } = new();
        public Task InitializeAsync(CancellationToken ct = default) => Task.CompletedTask;
        public Task RecordEvidenceAsync(DAsk.Daemon.Research.ExecutionEvidenceRecord r, CancellationToken ct = default) => Task.CompletedTask;
        public Task<DAsk.Daemon.Research.ExecutionEvidenceRecord?> GetEvidenceByIdAsync(string id, CancellationToken ct = default) => Task.FromResult<DAsk.Daemon.Research.ExecutionEvidenceRecord?>(null);
        public Task<IReadOnlyList<DAsk.Daemon.Research.ExecutionEvidenceRecord>> GetEvidenceByTaskIdAsync(string id, CancellationToken ct = default) => Task.FromResult<IReadOnlyList<DAsk.Daemon.Research.ExecutionEvidenceRecord>>(Array.Empty<DAsk.Daemon.Research.ExecutionEvidenceRecord>());
        public Task<IReadOnlyList<DAsk.Daemon.Research.SafetyAuditRecord>> GetSafetyAuditRecordsAsync(int limit = 100, CancellationToken ct = default) => Task.FromResult<IReadOnlyList<DAsk.Daemon.Research.SafetyAuditRecord>>(Records.ToArray());
        public Task RecordSafetyAuditAsync(DAsk.Daemon.Research.SafetyAuditRecord record, CancellationToken ct = default)
        {
            Records.Enqueue(record);
            if (record.EventType == "ApprovalOwnershipViolation")
            {
                if (_mode == AuditMode.ThrowSynchronously) throw new InvalidOperationException("audit store unavailable");
                if (_mode == AuditMode.ReturnFaultedTask) return Task.FromException(new InvalidOperationException("audit store unavailable"));
            }
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task H39_Audit_OwnershipViolation_IsRecorded_WithIdentifiersOnly_AndOwnerStillDecides()
    {
        var recorder = new FakeRecorder(AuditMode.Record);
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, recorder);
        var task = policy.RequestApprovalAsync(Req("appr_h39_audit", OwnerA));

        Assert.False(Decide(policy, Resp("appr_h39_audit", true), OwnerB));

        var violation = Assert.Single(recorder.Records, r => r.EventType == "ApprovalOwnershipViolation");
        Assert.Equal("appr_h39_audit", violation.ApprovalId);
        Assert.Equal(OwnerB, violation.SessionId);          // the offender
        Assert.Contains(OwnerA, violation.DetailsJson);     // the owner
        Assert.Contains("\"attemptedApproved\":true", violation.DetailsJson);
        Assert.DoesNotContain("hello", violation.ToJson());  // no action parameters leak into the audit trail

        Assert.True(Decide(policy, Resp("appr_h39_audit", true), OwnerA));
        Assert.True((await Completed(task)).Approved);
    }

    [Theory]
    [InlineData(AuditMode.ThrowSynchronously)]
    [InlineData(AuditMode.ReturnFaultedTask)]
    public async Task H39_Audit_Failure_CannotTurnARefusalIntoAcceptance(AuditMode mode)
    {
        var recorder = new FakeRecorder(mode);
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, recorder);
        var task = policy.RequestApprovalAsync(Req("appr_h39_audit_fail", OwnerA));

        bool accepted = Decide(policy, Resp("appr_h39_audit_fail", true), OwnerB);   // must not throw either

        Assert.False(accepted);
        await Task.Delay(100);
        Assert.False(task.IsCompleted);
        Assert.Equal(1, policy.PendingApprovalCount);
        Assert.Equal(0, policy.GrantedApprovalCount);
        Assert.Contains(recorder.Records, r => r.EventType == "ApprovalOwnershipViolation");

        Assert.True(Decide(policy, Resp("appr_h39_audit_fail", false), OwnerA));
        await Completed(task);
    }

    // ───────── structural guard ─────────

    [Fact]
    public void H39_Source_CallerSessionIsRequired_NoOptionalOrDefaultBypass()
    {
        var m = typeof(ActionPolicyEngine).GetMethod(nameof(ActionPolicyEngine.SubmitApprovalDecision))!;
        var p = m.GetParameters().SingleOrDefault(x => x.Name == "callerSessionId");
        Assert.NotNull(p);
        Assert.Equal(typeof(string), p!.ParameterType);
        Assert.False(p.IsOptional, "callerSessionId must not be optional");
        Assert.False(p.HasDefaultValue);
        Assert.Equal(1, p.Position);
    }
}
