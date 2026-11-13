using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.IPC;
using DAsk.Daemon.Research;
using DAsk.Daemon.State;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 7B.1a unit tests: canonical approval hashing (F2), approval presentation and lifecycle (F3/F4), HUD liveness
/// (F1, monitor in isolation), and audit serialization and evidence integrity (F5). No desktop input anywhere.
/// Run alone with:  --filter "FullyQualifiedName~Phase7B1aTests"
/// </summary>
public class Phase7B1aTests
{
    // ═══════════════════════ F2: DASK-CJ-1 canonical encoding ═══════════════════════

    private static string C(string json) => CanonicalJson.EncodeToString(JsonDocument.Parse(json).RootElement);
    private static string H(string json) => CanonicalJson.Digest(CanonicalJson.ParametersDomain, C(json));

    /// <summary>The pre-7B.1a algorithm, kept only to prove the reported collision existed.</summary>
    private static string LegacyHash(Dictionary<string, string> p)
    {
        var sb = new StringBuilder();
        foreach (var k in p.Keys.OrderBy(k => k, StringComparer.Ordinal)) sb.Append(k).Append('=').Append(p[k]).Append('\n');
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()))).ToLowerInvariant();
    }

    [Fact]
    public void F2_ReportedCollision_ExistedBefore_AndIsGoneNow()
    {
        var a = new Dictionary<string, string> { ["a"] = "1", ["b"] = "2" };
        var b = new Dictionary<string, string> { ["a"] = "1\nb=2" };
        Assert.Equal(LegacyHash(a), LegacyHash(b));   // the defect, reproduced
        Assert.NotEqual(ActionPolicyEngine.ComputeCanonicalHash(a), ActionPolicyEngine.ComputeCanonicalHash(b));

        // Keys containing the old delimiter cannot collide either.
        var c = new Dictionary<string, string> { ["a=1\nb"] = "2" };
        Assert.Equal(LegacyHash(a), LegacyHash(c));
        Assert.NotEqual(ActionPolicyEngine.ComputeCanonicalHash(a), ActionPolicyEngine.ComputeCanonicalHash(c));
    }

    [Fact]
    public void F2_Canonical_DistinguishesTypes_MissingNullEmpty_AndNesting()
    {
        var distinct = new[]
        {
            "{}", "{\"a\":null}", "{\"a\":\"\"}", "{\"a\":[]}", "{\"a\":{}}", "{\"a\":0}", "{\"a\":\"0\"}",
            "{\"a\":1}", "{\"a\":\"1\"}", "{\"a\":true}", "{\"a\":\"true\"}", "{\"a\":false}", "{\"a\":\"null\"}",
            "{\"a\":[1]}", "{\"a\":[\"1\"]}", "{\"a\":[[1]]}", "{\"a\":{\"b\":1}}", "{\"a\":{\"b\":\"1\"}}",
            "{\"a\":[1,2]}", "{\"a\":[2,1]}", "{\"a\":-1}", "{\"a\":1,\"b\":1}", "{\"ab\":1}", "{\"a\":{\"b\":{\"c\":null}}}",
        };
        var hashes = distinct.Select(H).ToList();
        Assert.Equal(hashes.Count, hashes.Distinct().Count());
    }

    [Fact]
    public void F2_Canonical_KeyOrderDoesNotMatter_ButEverythingElseDoes()
    {
        Assert.Equal(C("{\"b\":1,\"a\":{\"d\":[1,2],\"c\":\"x\"}}"), C("{\"a\":{\"c\":\"x\",\"d\":[1,2]},\"b\":1}"));
        Assert.Equal("{\"a\":{\"c\":\"x\",\"d\":[1,2]},\"b\":1}", C("{ \"b\" : 1 , \"a\":{\"d\":[1, 2],\"c\":\"x\"}}"));
        // Ordinal UTF-16 order: upper case before lower case, shorter prefix first.
        Assert.Equal("{\"A\":1,\"B\":2,\"a\":3,\"aa\":4}", C("{\"aa\":4,\"a\":3,\"B\":2,\"A\":1}"));
    }

    [Fact]
    public void F2_Canonical_Strings_EscapingAndUnicode_AreExact()
    {
        Assert.Equal("{\"s\":\"a\\\"b\\\\c\\n\\t\\u0001\\u001f\"}", C("{\"s\":\"a\\\"b\\\\c\\n\\t\\u0001\\u001f\"}"));
        // An escaped and an unescaped spelling of the same character are the same value.
        Assert.Equal(C("{\"s\":\"é\"}"), C("{\"s\":\"\\u00e9\"}"));
        // Different code points stay different: no Unicode normalisation (NFC "é" vs NFD "e\u0301").
        Assert.NotEqual(H("{\"s\":\"\\u00e9\"}"), H("{\"s\":\"e\\u0301\"}"));
        Assert.NotEqual(H("{\"s\":\"a\\\\nb\"}"), H("{\"s\":\"a\\nb\"}"));   // backslash-n is not a newline
        Assert.Equal("{\"s\":\"😀\"}", C("{\"s\":\"\\ud83d\\ude00\"}"));
    }

    [Fact]
    public void F2_Canonical_RejectsUnsupportedOrAmbiguousInput()
    {
        foreach (var bad in new[]
        {
            "{\"a\":1.5}", "{\"a\":1e2}", "{\"a\":1.0}", "{\"a\":9007199254740992}", "{\"a\":1,\"a\":2}",
            "{\"s\":\"\\ud800\"}", "{\"s\":\"\\udc00x\"}",
        })
            Assert.Throws<CanonicalEncodingException>(() => C(bad));

        string deep = new string('[', CanonicalJson.MaxDepth + 2) + new string(']', CanonicalJson.MaxDepth + 2);
        Assert.Throws<CanonicalEncodingException>(() => C(deep));
        Assert.Throws<CanonicalEncodingException>(() => ActionPolicyEngine.ComputeCanonicalHash(new() { ["k"] = "\uD800" }));
    }

    [Fact]
    public void F2_ParameterHash_AdditionalOrSubstitutedParameters_ChangeTheHash()
    {
        var baseline = new Dictionary<string, string> { ["text"] = "hello", ["field"] = "Search" };
        string h = ActionPolicyEngine.ComputeCanonicalHash(baseline);
        Assert.NotEqual(h, ActionPolicyEngine.ComputeCanonicalHash(new() { ["text"] = "hello", ["field"] = "Search", ["submit"] = "true" }));
        Assert.NotEqual(h, ActionPolicyEngine.ComputeCanonicalHash(new() { ["text"] = "hellO", ["field"] = "Search" }));
        Assert.NotEqual(h, ActionPolicyEngine.ComputeCanonicalHash(new() { ["text"] = "hello" }));
        Assert.NotEqual(h, ActionPolicyEngine.ComputeCanonicalHash(new() { ["Text"] = "hello", ["field"] = "Search" }));
        Assert.Equal(h, ActionPolicyEngine.ComputeCanonicalHash(new() { ["field"] = "Search", ["text"] = "hello" }));
        // Missing map and empty map are the same (no parameters); an empty value is not.
        Assert.Equal(ActionPolicyEngine.ComputeCanonicalHash(null), ActionPolicyEngine.ComputeCanonicalHash(new()));
        Assert.NotEqual(ActionPolicyEngine.ComputeCanonicalHash(new()), ActionPolicyEngine.ComputeCanonicalHash(new() { ["text"] = "" }));
    }

    [Fact]
    public void F2_Domains_SeparateParameterHashFromActionDigest()
    {
        Assert.NotEqual(CanonicalJson.Digest(CanonicalJson.ParametersDomain, "{}"), CanonicalJson.Digest(CanonicalJson.ActionDomain, "{}"));
    }

    [Fact]
    public void F2_ActionDigest_BindsTypeTargetSessionEpochAndExpiry()
    {
        var r = Req("appr_digest", "s1");
        string d = ActionPolicyEngine.BuildCanonicalAction(r).Digest;
        foreach (var variant in new[]
        {
            r with { ActionType = "SimulatedClick" },
            r with { TargetHwnd = r.TargetHwnd + 1 },
            r with { TargetProcessId = r.TargetProcessId + 1 },
            r with { TargetProcessName = "other.exe" },
            r with { TargetWindowTitle = "Other" },
            r with { SessionId = "s2" },
            r with { StopGeneration = 2 },
            r with { ExpiresAtUtc = r.ExpiresAtUtc.AddSeconds(1) },
            r with { ActionId = "act_other" },
            r with { ActionParameters = new() { ["text"] = "hello world!" } },
        })
            Assert.NotEqual(d, ActionPolicyEngine.BuildCanonicalAction(variant).Digest);
        Assert.Equal(d, ActionPolicyEngine.BuildCanonicalAction(r with { ActionDigest = "x", CanonicalAction = "y" }).Digest);
    }

    // ═══════════════════════ F3/F4: presentation, integrity and lifecycle ═══════════════════════

    private static ActionApprovalRequest Req(string id, string owner, TimeSpan? ttl = null) => new()
    {
        ApprovalId = id,
        ActionId = "act_" + id,
        ActionType = "SimulatedType",
        ActionParameters = new() { ["text"] = "hello world" },
        TargetProcessName = "fixture.exe",
        TargetWindowTitle = "Fixture",
        TargetHwnd = 77,
        TargetProcessId = 88,
        SessionId = owner,
        StopGeneration = 1,
        CreatedAtUtc = new DateTimeOffset(2026, 11, 8, 12, 0, 0, TimeSpan.Zero),
        ExpiresAtUtc = DateTimeOffset.UtcNow + (ttl ?? TimeSpan.FromSeconds(20)),
        RiskLevel = "Elevated",
        Reason = "unit test",
    };

    private static (ActionPolicyEngine policy, List<(string Session, ApprovalStateNotification N)> states, List<ActionApprovalRequest> sent) Policy()
    {
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance);
        var states = new List<(string, ApprovalStateNotification)>();
        var sent = new List<ActionApprovalRequest>();
        policy.ApprovalStateChanged += (_, e) => { lock (states) states.Add(e); };
        policy.ApprovalRequested += (_, r) => { lock (sent) sent.Add(r); };
        return (policy, states, sent);
    }

    private static ActionApprovalResponse Decision(ActionApprovalRequest pending, bool approved) => new()
    {
        ApprovalId = pending.ApprovalId,
        ActionId = pending.ActionId,
        ActionType = pending.ActionType,
        ParametersSha256 = pending.ParametersSha256,
        ActionDigest = pending.ActionDigest,
        Approved = approved,
    };

    [Fact]
    public async Task F3_DaemonBuildsTheRequest_IgnoresSuppliedDigest_ClampsTtl()
    {
        var (policy, _, sent) = Policy();
        var task = policy.RequestApprovalAsync(Req("appr_norm", "s1", TimeSpan.FromMinutes(10)) with { ActionDigest = "forged", CanonicalAction = "{\"forged\":1}" });
        var r = Assert.Single(sent);
        Assert.NotEqual("forged", r.ActionDigest);
        Assert.DoesNotContain("forged", r.CanonicalAction);
        Assert.Equal(ActionPolicyEngine.ComputeCanonicalHash(new() { ["text"] = "hello world" }), r.ParametersSha256);
        Assert.True(r.ExpiresAtUtc - r.CreatedAtUtc <= ActionPolicyEngine.MaxApprovalTtl, "a 10-minute request must be clamped to 30 s");
        Assert.True(r.CreatedAtUtc > new DateTimeOffset(2026, 11, 8, 12, 0, 0, TimeSpan.Zero), "creation time is the daemon's, not the caller's");

        using var doc = JsonDocument.Parse(r.CanonicalAction!);
        Assert.Equal("hello world", doc.RootElement.GetProperty("parameters").GetProperty("text").GetString());
        Assert.Equal(r.ActionDigest, CanonicalJson.Digest(CanonicalJson.ActionDomain, r.CanonicalAction!));
        Assert.True(policy.SubmitApprovalDecision(Decision(r, false), "s1"));
        Assert.False((await task).Approved);
    }

    [Theory]
    [InlineData("text", "line1\rline2")]        // carriage return
    [InlineData("text", "a\u0007b")]            // control character
    [InlineData("text", "abc\u202Edcba")]       // right-to-left override
    [InlineData("password", "x")]               // a secret is never shown or approved
    [InlineData("api_key", "x")]
    [InlineData("bad name", "x")]
    public async Task F3_UnrepresentableOperations_AreRefused(string key, string value)
    {
        var (policy, states, sent) = Policy();
        var r = await policy.RequestApprovalAsync(Req("appr_unrep", "s1") with { ActionParameters = new() { [key] = value } });
        Assert.False(r.Approved);
        Assert.Contains("cannot be represented clearly", r.RejectionReason);
        Assert.Empty(sent);
        Assert.Equal(ApprovalStates.Rejected, Assert.Single(states).N.State);
    }

    [Fact]
    public async Task F3_OversizedOrUnencodableParameters_AreRefused()
    {
        var (policy, _, _) = Policy();
        var tooLong = await policy.RequestApprovalAsync(Req("appr_long", "s1") with { ActionParameters = new() { ["text"] = new string('x', ActionPolicyEngine.MaxParameterValueChars + 1) } });
        Assert.False(tooLong.Approved);
        var surrogate = await policy.RequestApprovalAsync(Req("appr_sur", "s1") with { ActionParameters = new() { ["text"] = "\uD800" } });
        Assert.False(surrogate.Approved);
        Assert.Equal(0, policy.PendingApprovalCount);
    }

    [Fact]
    public async Task F2_SuppliedParameterHashMustBeCanonical_AtRegistration()
    {
        var (policy, _, _) = Policy();
        var r = await policy.RequestApprovalAsync(Req("appr_badhash", "s1") with { ParametersSha256 = "0000" });
        Assert.False(r.Approved);
        Assert.Equal("IntegrityMismatch", r.DecisionSource);
        Assert.Equal(0, policy.PendingApprovalCount);
    }

    [Fact]
    public async Task F4_ApprovalWithoutOrWithWrongDigest_IsRejected()
    {
        foreach (string? digest in new[] { null, "", "deadbeef" })
        {
            var (policy, states, sent) = Policy();
            var task = policy.RequestApprovalAsync(Req("appr_dig", "s1"));
            var pending = Assert.Single(sent);
            policy.SubmitApprovalDecision(Decision(pending, true) with { ActionDigest = digest }, "s1");
            var r = await task;
            Assert.False(r.Approved);
            Assert.Equal("IntegrityMismatch", r.DecisionSource);
            Assert.Equal(ApprovalStates.Rejected, states.Last().N.State);
            Assert.Equal(0, policy.GrantedApprovalCount);
        }
    }

    [Fact]
    public async Task F4_EveryTerminalState_IsReportedToTheOwner()
    {
        // Approved
        var (p1, s1, q1) = Policy();
        var t1 = p1.RequestApprovalAsync(Req("ap", "own"));
        p1.SubmitApprovalDecision(Decision(q1[0], true), "own");
        Assert.True((await t1).Approved);
        Assert.Equal(("own", ApprovalStates.Approved), (s1.Last().Session, s1.Last().N.State));

        // Denied
        var (p2, s2, q2) = Policy();
        var t2 = p2.RequestApprovalAsync(Req("de", "own"));
        p2.SubmitApprovalDecision(Decision(q2[0], false), "own");
        Assert.False((await t2).Approved);
        Assert.Equal(ApprovalStates.Denied, s2.Last().N.State);

        // Expired
        var (p3, s3, _) = Policy();
        var t3 = p3.RequestApprovalAsync(Req("ex", "own", TimeSpan.FromMilliseconds(60)));
        Assert.Equal("TimeoutDenied", (await t3).DecisionSource);
        Assert.Equal(ApprovalStates.Expired, s3.Last().N.State);

        // Cancelled
        var (p4, s4, _) = Policy();
        using var cts = new CancellationTokenSource();
        var t4 = p4.RequestApprovalAsync(Req("ca", "own"), cts.Token);
        cts.Cancel();
        Assert.False((await t4).Approved);
        Assert.Equal(ApprovalStates.Cancelled, s4.Last().N.State);

        // Invalidated by Emergency Stop
        var (p5, s5, _) = Policy();
        var t5 = p5.RequestApprovalAsync(Req("st", "own"));
        p5.InvalidateAllPendingAndGrantedApprovals("stop");
        Assert.False((await t5).Approved);
        Assert.Equal(ApprovalStates.InvalidatedByEmergencyStop, s5.Last().N.State);

        // Disconnected
        var (p6, s6, _) = Policy();
        var t6 = p6.RequestApprovalAsync(Req("dc", "own"));
        p6.InvalidateApprovalsForSession("own", "gone");
        Assert.False((await t6).Approved);
        Assert.Equal(ApprovalStates.Disconnected, s6.Last().N.State);

        // Stop arriving with the decision
        var (p7, s7, q7) = Policy();
        var t7 = p7.RequestApprovalAsync(Req("sd", "own"));
        p7.SubmitApprovalDecision(Decision(q7[0], true), "own", isEmergencyStoppedFunc: () => true);
        Assert.Equal("EmergencyStopDenied", (await t7).DecisionSource);
        Assert.Equal(ApprovalStates.InvalidatedByEmergencyStop, s7.Last().N.State);
    }

    [Fact]
    public async Task F4_LateAndDuplicateDecisions_AreRejectedAndAnswered()
    {
        var (policy, states, sent) = Policy();
        var task = policy.RequestApprovalAsync(Req("late", "own", TimeSpan.FromMilliseconds(60)));
        var pending = Assert.Single(sent);
        await task;   // expired

        Assert.False(policy.SubmitApprovalDecision(Decision(pending, true), "own"));
        var answer = states.Last();
        Assert.Equal("own", answer.Session);
        Assert.False(answer.N.DecisionAccepted);
        Assert.Equal(ApprovalStates.Expired, answer.N.State);
        Assert.Equal(0, policy.GrantedApprovalCount);

        var (p2, s2, q2) = Policy();
        var t2 = p2.RequestApprovalAsync(Req("dup", "own"));
        Assert.True(p2.SubmitApprovalDecision(Decision(q2[0], true), "own"));
        Assert.False(p2.SubmitApprovalDecision(Decision(q2[0], true), "own"));
        Assert.False(p2.SubmitApprovalDecision(Decision(q2[0], false), "own"));
        Assert.True((await t2).Approved);
        Assert.Equal(1, p2.GrantedApprovalCount);
        Assert.All(s2.Skip(1), e => Assert.False(e.N.DecisionAccepted));
    }

    [Fact]
    public async Task F1_PolicyGate_NoApprovalForOrFromANonLiveSession()
    {
        var (policy, states, sent) = Policy();
        bool live = false;
        policy.SetSessionLivenessGate(_ => live);
        var refused = await policy.RequestApprovalAsync(Req("nl", "own"));
        Assert.Equal("SessionDisconnectedDenied", refused.DecisionSource);
        Assert.Empty(sent);

        live = true;
        var task = policy.RequestApprovalAsync(Req("nl2", "own"));
        var pending = Assert.Single(sent);
        live = false;   // the lease lapses before the user clicks
        policy.SubmitApprovalDecision(Decision(pending, true), "own");
        var r = await task;
        Assert.False(r.Approved);
        Assert.Equal(ApprovalStates.Disconnected, states.Last().N.State);
        Assert.Equal(0, policy.GrantedApprovalCount);
    }

    // ═══════════════════════ F1: liveness monitor in isolation ═══════════════════════

    private sealed class Clock { public DateTimeOffset Now = DateTimeOffset.UtcNow; }

    private static (HudLivenessMonitor m, ActionExecutionEngine engine, Clock clock) Monitor()
    {
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance);
        var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, new StateManager(NullLogger<StateManager>.Instance), policy);
        var clock = new Clock();
        var m = new HudLivenessMonitor(NullLogger.Instance, engine, policy, null, 12_000, 3_000, () => clock.Now, startSweepTimer: false);
        return (m, engine, clock);
    }

    private static HeartbeatPing Ping(long seq, DateTimeOffset at, long? loopAck = null, long? hotkeyAck = null, bool registered = true) => new()
    { Sequence = seq, Timestamp = at, EventLoopAck = loopAck ?? seq - 1, HotkeyAck = hotkeyAck ?? seq - 1, HotkeyRegistered = registered };

    [Fact]
    public void F1_Monitor_Lifecycle_AndDerivedAvailability()
    {
        var (m, engine, clock) = Monitor();
        m.OnSessionAuthenticated("s");
        Assert.Equal(HudLivenessState.Unknown, m.GetState("s"));
        Assert.False(m.OnHeartbeat("s", Ping(1, clock.Now)).Accepted);   // no hotkey confirmation yet
        m.OnHotkeyStatus("s", true, "ok");
        Assert.False(engine.IsPanicHotkeyAvailable);
        Assert.True(m.OnHeartbeat("s", Ping(2, clock.Now)).Accepted);
        Assert.True(engine.IsPanicHotkeyAvailable);

        clock.Now += TimeSpan.FromSeconds(11);
        Assert.True(m.IsLive("s"));
        clock.Now += TimeSpan.FromSeconds(2);
        Assert.False(m.IsLive("s"));
        m.Sweep();
        Assert.Equal(HudLivenessState.Expired, m.GetState("s"));
        Assert.False(engine.IsPanicHotkeyAvailable);

        m.OnSessionEnded("s");
        Assert.Equal(HudLivenessState.Ended, m.GetState("s"));
        Assert.False(m.OnHeartbeat("s", Ping(3, clock.Now)).Accepted, "an ended session can never be revived");
    }

    [Fact]
    public void F1_Monitor_AvailabilityHoldsWhileAnyLiveHudRemains()
    {
        var (m, engine, clock) = Monitor();
        foreach (var s in new[] { "a", "b" })
        {
            m.OnSessionAuthenticated(s);
            m.OnHotkeyStatus(s, true, "ok");
            Assert.True(m.OnHeartbeat(s, Ping(1, clock.Now)).Accepted);
        }
        m.OnSessionEnded("a");
        Assert.True(engine.IsPanicHotkeyAvailable);
        m.OnSessionEnded("b");
        Assert.False(engine.IsPanicHotkeyAvailable);
    }

    [Fact]
    public void F1_Monitor_ProofRules()
    {
        var (m, _, clock) = Monitor();
        m.OnSessionAuthenticated("s");
        m.OnHotkeyStatus("s", true, "ok");
        Assert.False(m.OnHeartbeat("s", Ping(0, clock.Now)).Accepted);                       // sequence must be positive
        Assert.False(m.OnHeartbeat("s", Ping(5, clock.Now, loopAck: 6)).Accepted);           // ack from the future
        Assert.False(m.OnHeartbeat("s", Ping(6, clock.Now + TimeSpan.FromSeconds(4))).Accepted); // future timestamp
        Assert.True(m.OnHeartbeat("s", Ping(7, clock.Now)).Accepted);
        Assert.False(m.OnHeartbeat("s", Ping(7, clock.Now)).Accepted);                       // replay
        Assert.Equal(HudLivenessState.Live, m.GetState("s"));
        Assert.False(m.OnHeartbeat("s", Ping(8, clock.Now, registered: false)).Accepted);    // hotkey gone: expires at once
        Assert.Equal(HudLivenessState.Expired, m.GetState("s"));
    }

    // ═══════════════════════ F5: audit serialization and evidence integrity ═══════════════════════

    private sealed class CapturingRecorder : IEvidenceRecorder
    {
        public readonly List<SafetyAuditRecord> Records = new();
        public Task InitializeAsync(CancellationToken ct = default) => Task.CompletedTask;
        public Task RecordEvidenceAsync(ExecutionEvidenceRecord r, CancellationToken ct = default) => Task.CompletedTask;
        public Task<ExecutionEvidenceRecord?> GetEvidenceByIdAsync(string id, CancellationToken ct = default) => Task.FromResult<ExecutionEvidenceRecord?>(null);
        public Task<IReadOnlyList<ExecutionEvidenceRecord>> GetEvidenceByTaskIdAsync(string id, CancellationToken ct = default) => Task.FromResult<IReadOnlyList<ExecutionEvidenceRecord>>(Array.Empty<ExecutionEvidenceRecord>());
        public Task RecordSafetyAuditAsync(SafetyAuditRecord r, CancellationToken ct = default)
        {
            var problem = SqliteEvidenceRecorder.ValidateAuditRecord(r);
            if (problem != null) throw new ArgumentException(problem);
            lock (Records) Records.Add(r);
            return Task.CompletedTask;
        }
        public Task<IReadOnlyList<SafetyAuditRecord>> GetSafetyAuditRecordsAsync(int limit = 100, CancellationToken ct = default) => Task.FromResult<IReadOnlyList<SafetyAuditRecord>>(Records);
    }

    private const string Hostile = "x\",\"forged\":\"1\"}, \\\"\n\u0000</script>";

    [Fact]
    public void F5_AuditJson_CallerTextCannotChangeStructure_AndIsBounded()
    {
        string json = AuditJson.Details(new { actionType = AuditJson.Bound(Hostile), n = 3 });
        using var doc = JsonDocument.Parse(json);
        Assert.Equal(2, doc.RootElement.EnumerateObject().Count());
        Assert.False(doc.RootElement.TryGetProperty("forged", out _));
        Assert.Equal(Hostile, doc.RootElement.GetProperty("actionType").GetString());

        string longText = new string('é', 1000);
        string bounded = AuditJson.Bound(longText)!;
        Assert.StartsWith(new string('é', AuditJson.MaxFieldChars), bounded);
        Assert.Contains("[truncated 744 chars]", bounded);
        Assert.Throws<ArgumentException>(() => AuditJson.Details(new { big = new string('x', AuditJson.MaxDetailsChars) }));
    }

    [Fact]
    public async Task F5_EngineLifecycleAudit_WithHostileActionType_IsValidJson()
    {
        var recorder = new CapturingRecorder();
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance);
        using var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, new StateManager(NullLogger<StateManager>.Instance), policy, recorder);
        engine.SetPanicHotkeyStatus(true, "test");
        await engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest { ActionId = "act_hostile", ActionType = Hostile }, "s1");
        await Task.Delay(100);
        var rec = Assert.Single(recorder.Records.Where(r => r.ActionId == "act_hostile"));
        using var doc = JsonDocument.Parse(rec.DetailsJson!);
        Assert.False(doc.RootElement.TryGetProperty("forged", out _));
        Assert.Equal(Hostile, doc.RootElement.GetProperty("actionType").GetString());
    }

    [Fact]
    public async Task F5_PolicyAudit_DetailsAreSerializerBuilt()
    {
        var recorder = new CapturingRecorder();
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, recorder);
        // A window title or process name a hostile application controls must not change the JSON either.
        var task = policy.RequestApprovalAsync(Req("appr_aud", "s1") with { TargetProcessName = "evil\",\"forged\":\"1.exe" });
        policy.InvalidateAllPendingAndGrantedApprovals("done");
        await task;
        var rec = Assert.Single(recorder.Records.Where(r => r.EventType == "ApprovalRequested"));
        using var doc = JsonDocument.Parse(rec.DetailsJson!);
        Assert.False(doc.RootElement.TryGetProperty("forged", out _));
        Assert.Equal("evil\",\"forged\":\"1.exe", doc.RootElement.GetProperty("targetProcess").GetString());
    }

    private static string TempDb() => Path.Combine(Path.GetTempPath(), $"dask_p7b1a_{Guid.NewGuid():N}.db");

    private static SafetyAuditRecord Audit(string type = "ApprovalRequested", string? details = "{\"k\":1}") => new()
    {
        EventType = type, Source = "Test", ActionId = "act_1", SessionId = "s1", StopGeneration = 1, Decision = "Pending",
        Reason = "unit test", DetailsJson = details,
    };

    private static async Task<long> Count(string db, string table)
    {
        using var conn = new SqliteConnection($"Data Source={db}");
        await conn.OpenAsync();
        using var cmd = new SqliteCommand($"SELECT COUNT(*) FROM {table};", conn);
        return (long)(await cmd.ExecuteScalarAsync())!;
    }

    private static async Task<int> Exec(string db, string sql)
    {
        using var conn = new SqliteConnection($"Data Source={db}");
        await conn.OpenAsync();
        using var cmd = new SqliteCommand(sql, conn);
        return await cmd.ExecuteNonQueryAsync();
    }

    [Fact]
    public async Task F5_Recorder_RejectsMalformedRecords()
    {
        string db = TempDb();
        var rec = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, db);
        try
        {
            await rec.InitializeAsync();
            await Assert.ThrowsAsync<ArgumentException>(() => rec.RecordSafetyAuditAsync(Audit(type: "bad type with spaces")));
            await Assert.ThrowsAsync<ArgumentException>(() => rec.RecordSafetyAuditAsync(Audit(details: "{\"a\":")));
            await Assert.ThrowsAsync<ArgumentException>(() => rec.RecordSafetyAuditAsync(Audit(details: "[1,2]")));
            await Assert.ThrowsAsync<ArgumentException>(() => rec.RecordSafetyAuditAsync(Audit(details: "{\"a\":\"" + new string('x', AuditJson.MaxDetailsChars) + "\"}")));
            await Assert.ThrowsAsync<ArgumentException>(() => rec.RecordSafetyAuditAsync(Audit() with { Reason = new string('r', 3000) }));
            Assert.Equal(0, await Count(db, "safety_audit_trail"));
        }
        finally { SqliteConnection.ClearAllPools(); File.Delete(db); }
    }

    [Fact]
    public async Task F5_Recorder_IsAppendOnly_DuplicateIdNeverOverwrites()
    {
        string db = TempDb();
        var rec = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, db);
        try
        {
            var first = Audit() with { EventId = "evt_fixed", Reason = "original" };
            await rec.RecordSafetyAuditAsync(first);
            await Assert.ThrowsAsync<SqliteException>(() => rec.RecordSafetyAuditAsync(first with { Reason = "overwrite attempt" }));
            var stored = (await rec.GetSafetyAuditRecordsAsync()).Single(r => r.EventId == "evt_fixed");
            Assert.Equal("original", stored.Reason);

            await Assert.ThrowsAsync<SqliteException>(() => Exec(db, "UPDATE safety_audit_trail SET reason='x';"));
            await Assert.ThrowsAsync<SqliteException>(() => Exec(db, "DELETE FROM safety_audit_trail;"));
            await Assert.ThrowsAsync<SqliteException>(() => Exec(db, "UPDATE safety_audit_chain SET hash='x';"));
            await Assert.ThrowsAsync<SqliteException>(() => Exec(db, "DELETE FROM safety_audit_chain;"));
            Assert.Equal(1, await Count(db, "safety_audit_trail"));
            Assert.True((await rec.VerifyAuditChainAsync()).Ok);
        }
        finally { SqliteConnection.ClearAllPools(); File.Delete(db); }
    }

    [Fact]
    public async Task F5_Chain_VerifiesInOrder_FromGenesis()
    {
        string db = TempDb();
        var rec = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, db);
        try
        {
            for (int i = 0; i < 25; i++) await rec.RecordSafetyAuditAsync(Audit() with { Reason = $"event {i} {Hostile}" });
            var v = await rec.VerifyAuditChainAsync();
            Assert.True(v.Ok, v.Problem);
            Assert.Equal(25, v.VerifiedEvents);
            Assert.Equal(0, v.UnchainedRows);

            using var conn = new SqliteConnection($"Data Source={db}");
            await conn.OpenAsync();
            using var cmd = new SqliteCommand("SELECT prev_hash FROM safety_audit_chain WHERE seq = 1;", conn);
            Assert.Equal(SqliteEvidenceRecorder.ChainGenesis, (string)(await cmd.ExecuteScalarAsync())!);
        }
        finally { SqliteConnection.ClearAllPools(); File.Delete(db); }
    }

    [Fact]
    public async Task F5_Chain_DetectsTampering_MissingRecords_AndCountsHistoricalRows()
    {
        // Tampering is simulated the way an offline attacker would do it: drop the triggers, then edit the file.
        async Task<SqliteEvidenceRecorder> Fresh(string path)
        {
            var r = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, path);
            for (int i = 0; i < 5; i++) await r.RecordSafetyAuditAsync(Audit() with { EventId = $"e{i}", Reason = $"event {i}" });
            await Exec(path, "DROP TRIGGER trg_safety_audit_no_update; DROP TRIGGER trg_safety_audit_no_delete; DROP TRIGGER trg_safety_chain_no_update; DROP TRIGGER trg_safety_chain_no_delete;");
            return r;
        }

        string db1 = TempDb(), db2 = TempDb(), db3 = TempDb(), db4 = TempDb();
        try
        {
            var r1 = await Fresh(db1);
            await Exec(db1, "UPDATE safety_audit_trail SET reason='rewritten' WHERE event_id='e2';");
            var v1 = await r1.VerifyAuditChainAsync();
            Assert.False(v1.Ok);
            Assert.Equal(3, v1.FirstBadSeq);
            Assert.Contains("differs", v1.Problem);

            var r2 = await Fresh(db2);
            await Exec(db2, "DELETE FROM safety_audit_chain WHERE seq = 3;");
            var v2 = await r2.VerifyAuditChainAsync();
            Assert.False(v2.Ok);
            Assert.Contains("missing record", v2.Problem);

            var r3 = await Fresh(db3);
            await Exec(db3, "UPDATE safety_audit_chain SET hash = 'ff' WHERE seq = 4;");
            Assert.False((await r3.VerifyAuditChainAsync()).Ok);

            var r4 = await Fresh(db4);
            await Exec(db4, "DELETE FROM safety_audit_trail WHERE event_id='e1';");
            var v4 = await r4.VerifyAuditChainAsync();
            Assert.False(v4.Ok);
            Assert.Contains("missing", v4.Problem);
        }
        finally { SqliteConnection.ClearAllPools(); foreach (var d in new[] { db1, db2, db3, db4 }) File.Delete(d); }
    }

    [Theory]
    // The schema written by the previous recorder version (all columns, no triggers, no chain).
    [InlineData(@"CREATE TABLE safety_audit_trail (event_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, event_type TEXT NOT NULL,
        source TEXT NOT NULL, action_id TEXT, approval_id TEXT, session_id TEXT, risk_level TEXT, parameters_sha256 TEXT,
        stop_generation INTEGER NOT NULL DEFAULT 0, decision TEXT, reason TEXT, details_json TEXT);")]
    // An older schema without approval_id/session_id/stop_generation (exercises the column migration).
    [InlineData(@"CREATE TABLE safety_audit_trail (event_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, event_type TEXT NOT NULL,
        source TEXT NOT NULL, action_id TEXT, risk_level TEXT, parameters_sha256 TEXT, decision TEXT, reason TEXT, details_json TEXT);")]
    public async Task F5_Chain_HistoricalRows_StayUntouched_AndAreReportedUnchained(string oldSchema)
    {
        string db = TempDb();
        try
        {
            await Exec(db, oldSchema + @"
                INSERT INTO safety_audit_trail (event_id, timestamp, event_type, source, reason) VALUES ('old1', '2026-01-01T00:00:00Z', 'EmergencyStop', 'Old', 'historical');");

            var rec = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, db);
            await rec.RecordSafetyAuditAsync(Audit());
            var v = await rec.VerifyAuditChainAsync();
            Assert.True(v.Ok, v.Problem);
            Assert.Equal(1, v.VerifiedEvents);
            Assert.Equal(1, v.UnchainedRows);
            var old = (await rec.GetSafetyAuditRecordsAsync()).Single(r => r.EventId == "old1");
            Assert.Equal("historical", old.Reason);
        }
        finally { SqliteConnection.ClearAllPools(); File.Delete(db); }
    }

    [Fact]
    public async Task F5_ExecutionEvidence_DuplicateRecordId_IsRefused()
    {
        string db = TempDb();
        var rec = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, db);
        try
        {
            var r = new ExecutionEvidenceRecord
            {
                RecordId = "rec_fixed", TaskId = "t", ActionId = "a",
                ActionMetadata = new ActionMetadata { AgentName = "A", ToolName = "T", Parameters = JsonSerializer.SerializeToElement(new { }) },
                RiskAssessment = new RiskAssessment(), PreActionObservation = new PreActionObservation(),
                ExecutionOutcome = new ExecutionOutcome(), PostActionObservation = new PostActionObservation(),
                VerificationDecision = new VerificationDecision(),
            };
            await rec.RecordEvidenceAsync(r);
            await Assert.ThrowsAsync<SqliteException>(() => rec.RecordEvidenceAsync(r));
        }
        finally { SqliteConnection.ClearAllPools(); File.Delete(db); }
    }

    // ═══════════════════════ guard rails on the source ═══════════════════════

    [Fact]
    public void Source_NoDesktopInputOrInterpolatedAuditJson_InTheDaemon()
    {
        string root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "src", "DAsk.Daemon"))) root = Path.GetDirectoryName(root)!;
        var files = Directory.EnumerateFiles(Path.Combine(root, "src", "DAsk.Daemon"), "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"));
        foreach (var f in files)
        {
            string text = File.ReadAllText(f);
            Assert.DoesNotMatch(@"DllImport[^\n]*\n[^\n]*\b(SendInput|keybd_event|mouse_event|SetCursorPos)\b", text);
            Assert.DoesNotMatch(@"DetailsJson\s*=\s*\$""", text);
            Assert.DoesNotContain("INSERT OR REPLACE", text);
        }
        string server = File.ReadAllText(Path.Combine(root, "src", "DAsk.Daemon", "IPC", "NamedPipeServer.cs"));
        Assert.Contains("SetSessionLivenessGate(_liveness.IsLive)", server);
    }
}
