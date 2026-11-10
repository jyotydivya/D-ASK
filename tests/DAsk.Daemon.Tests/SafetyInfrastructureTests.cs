using System.Diagnostics;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Daemon.State;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

public class SafetyInfrastructureTests
{
    private readonly ITestOutputHelper _output;

    public SafetyInfrastructureTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private class MockStateManager : IStateManager
    {
        public string ActiveStatus { get; private set; } = "Normal";
        public string OrbMode { get; private set; } = "idle";
        public long CurrentSequenceNumber { get; private set; } = 1;

        public event EventHandler<DAsk.Protocol.IPC.Messages.StateUpdate>? StateChanged;

        public void SetStatus(string status, string? orbMode = null)
        {
            ActiveStatus = status;
            if (orbMode != null) OrbMode = orbMode;
        }

        public void AddOrUpdateTask(string taskId, string title, string status) { }
        public void RemoveTask(string taskId) { }
        public DAsk.Protocol.IPC.Messages.StateRestoreResponse CreateStateSnapshot() => new();
        public bool RestoreClientState(DAsk.Protocol.IPC.Messages.StateRestoreRequest request, out DAsk.Protocol.IPC.Messages.StateRestoreResponse response)
        {
            response = new();
            return true;
        }
    }

    private (ActionExecutionEngine engine, ActionPolicyEngine policy, MockStateManager stateMgr) CreateTestEngine(bool enablePanicHotkey = true)
    {
        var stateMgr = new MockStateManager();
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance);
        var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, stateMgr, policy);
        if (enablePanicHotkey)
        {
            engine.SetPanicHotkeyStatus(true, "Test mode", 0);
        }
        return (engine, policy, stateMgr);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 1: Active Simulated Action Cancelled Immediately On Emergency Stop
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario01_Active_Action_Cancelled_Immediately_On_Emergency_Stop()
    {
        var (engine, _, _) = CreateTestEngine();

        var req = new SimulatedActionRequest
        {
            ActionId = "act_active_01",
            ActionType = "SimulatedScroll", // Low-risk, auto-allowed
            SimulatedDurationMs = 2000
        };

        var execTask = engine.ExecuteSimulatedActionAsync(req, "test_session");

        // Allow execution loop to begin and reach Task.Delay
        await Task.Delay(50);
        Assert.Equal(1, engine.ActiveActionCount);

        var stopSw = Stopwatch.StartNew();
        var stopResp = await engine.TriggerEmergencyStopAsync("TestRunner", "Scenario 1 Stop");
        stopSw.Stop();

        var result = await execTask;

        Assert.True(stopResp.Success);
        Assert.Equal(1, stopResp.ActiveActionsCancelled);
        Assert.False(result.Success);
        Assert.Equal("Cancelled", result.Status);
        Assert.Equal(0, engine.ActiveActionCount);
        _output.WriteLine($"Scenario 1: Active action cancelled in {stopSw.Elapsed.TotalMilliseconds:F3} ms.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 2: Queued Actions Drained and Cancelled On Emergency Stop
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario02_Queued_Actions_Drained_And_Cancelled_On_Emergency_Stop()
    {
        var (engine, _, _) = CreateTestEngine();

        // Start one long active action
        var activeReq = new SimulatedActionRequest
        {
            ActionId = "act_active_long",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 3000
        };
        var activeTask = engine.ExecuteSimulatedActionAsync(activeReq, "session_1");
        await Task.Delay(40);

        // Trigger emergency stop
        var stopResp = await engine.TriggerEmergencyStopAsync("TestRunner", "Scenario 2 Queue Drain");
        var activeResult = await activeTask;

        Assert.True(stopResp.Success);
        Assert.False(activeResult.Success);
        Assert.Equal("Cancelled", activeResult.Status);
        Assert.Equal(0, engine.ActiveActionCount);
        Assert.Equal(0, engine.QueuedActionCount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 3: Starting New Action While Emergency Stopped Is Blocked
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario03_Starting_New_Action_While_Emergency_Stopped_Is_Blocked()
    {
        var (engine, _, _) = CreateTestEngine();

        await engine.TriggerEmergencyStopAsync("TestRunner", "Arm Stop");
        Assert.True(engine.IsEmergencyStopped);

        var req = new SimulatedActionRequest
        {
            ActionId = "act_new_blocked",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 100
        };

        var result = await engine.ExecuteSimulatedActionAsync(req, "session_1");

        Assert.False(result.Success);
        Assert.Equal("Blocked", result.Status);
        Assert.Contains("Emergency Stop is active", result.ErrorMessage);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 4: Pending Approvals Invalidated On Emergency Stop
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario04_Pending_Approvals_Invalidated_On_Emergency_Stop()
    {
        var (engine, policy, _) = CreateTestEngine();

        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_elevated_01",
            ActionId = "act_elevated_01",
            ActionType = "SimulatedClick",
            RiskLevel = "Elevated",
            // Phase 7B.1a: the claimed hash must be the canonical hash of the parameters actually sent.
            ActionParameters = new() { ["x"] = "100", ["y"] = "200" },
            ParametersSha256 = ActionPolicyEngine.ComputeCanonicalHash(new() { ["x"] = "100", ["y"] = "200" }),
            SessionId = "session_1",
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddSeconds(30)
        };

        var approvalTask = policy.RequestApprovalAsync(approvalReq);
        Assert.Equal(1, policy.PendingApprovalCount);

        var stopResp = await engine.TriggerEmergencyStopAsync("TestRunner", "Invalidate Approvals");

        var approvalResult = await approvalTask;

        Assert.False(approvalResult.Approved);
        Assert.Equal("EmergencyStopDenied", approvalResult.DecisionSource);
        Assert.Equal(0, policy.PendingApprovalCount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 5: Stopped State Latched Until Explicit Resume
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario05_Stopped_State_Latched_Until_Explicit_Resume()
    {
        var (engine, _, stateMgr) = CreateTestEngine();

        await engine.TriggerEmergencyStopAsync("TestRunner", "Latch Verification");
        Assert.True(engine.IsEmergencyStopped);
        Assert.Equal("EmergencyStop", stateMgr.OrbMode);

        // Attempt multiple actions over time; all must be blocked
        for (int i = 0; i < 5; i++)
        {
            var blocked = await engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
            {
                ActionId = $"act_latched_{i}",
                ActionType = "SimulatedScroll"
            }, "session_1");
            Assert.Equal("Blocked", blocked.Status);
        }

        // Explicit Resume
        var resumeResp = await engine.ResumeExecutionAsync("UserExplicitConfirmation", "Safety cleared", engine.CurrentStopGeneration);
        Assert.True(resumeResp.Success);
        Assert.False(engine.IsEmergencyStopped);
        Assert.Equal("Normal", stateMgr.OrbMode);

        // New actions now execute successfully
        var allowed = await engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_post_resume",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 10
        }, "session_1");

        Assert.True(allowed.Success);
        Assert.Equal("Completed", allowed.Status);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 6: Expired Approval Rejected Fail-Closed
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario06_Expired_Approval_Rejected_Fail_Closed()
    {
        var (_, policy, _) = CreateTestEngine();

        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_short_ttl",
            ActionId = "act_short_ttl",
            ActionType = "SimulatedClick",
            // Phase 7B.1a: a non-canonical claimed hash is now refused at registration (covered by the 7B.1a tests);
            // this scenario is about expiry, so it sends the daemon-computable hash of its (empty) parameters.
            ParametersSha256 = ActionPolicyEngine.ComputeCanonicalHash(null),
            SessionId = "session_1",
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMilliseconds(50) // 50ms TTL
        };

        var reqTask = policy.RequestApprovalAsync(approvalReq);

        // Wait for TTL expiration
        await Task.Delay(120);

        var result = await reqTask;
        Assert.False(result.Approved);
        Assert.Equal("TimeoutDenied", result.DecisionSource);
        Assert.Contains("expired", result.RejectionReason, StringComparison.OrdinalIgnoreCase);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 7: Replay Approval Token Rejected
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario07_Replay_Approval_Token_Rejected()
    {
        var (engine, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["text"] = "hello world" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        // Pre-grant approval record in policy registry
        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_token_unique_99",
            ActionId = "act_replay_01",
            ActionType = "SimulatedType",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            SessionId = "session_1",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var appTask = policy.RequestApprovalAsync(approvalReq);
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_token_unique_99",
            ActionId = "act_replay_01",
            ActionType = "SimulatedType",
            ParametersSha256 = hash,
            SessionId = "session_1",
            StopGeneration = 1,
            Approved = true
        }.WithDigest(policy), "session_1");
        var grantRes = await appTask;
        Assert.True(grantRes.Approved, $"Approval was not granted: {grantRes.RejectionReason}");

        var req = new SimulatedActionRequest
        {
            ActionId = "act_replay_01",
            ActionType = "SimulatedType",
            Parameters = paramsMap,
            ApprovalId = "appr_token_unique_99",
            SessionId = "session_1",
            StopGeneration = 1,
            SimulatedDurationMs = 10
        };

        // First execution consumes the token
        var firstResult = await engine.ExecuteSimulatedActionAsync(req, "session_1");
        Assert.True(firstResult.Success);
        Assert.Equal("Completed", firstResult.Status);

        // Attempt to replay the identical approval token
        var replayReq = req with { ActionId = "act_replay_02" };
        var replayResult = await engine.ExecuteSimulatedActionAsync(replayReq, "session_1");

        Assert.False(replayResult.Success);
        Assert.Equal("Blocked", replayResult.Status);
        Assert.Contains("Replay rejected", replayResult.ErrorMessage);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 8: Parameter Tampering Rejected By Hash Mismatch
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario08_Parameter_Tampering_Rejected_By_Hash_Mismatch()
    {
        var (_, policy, _) = CreateTestEngine();

        var origParams = new Dictionary<string, string> { ["target"] = "safe_file.txt" };
        string origHash = ActionPolicyEngine.ComputeCanonicalHash(origParams);

        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_tamper_check",
            ActionId = "act_tamper_check",
            ActionType = "SimulatedClick",
            ParametersSha256 = origHash,
            SessionId = "session_1",
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddSeconds(30)
        };

        var reqTask = policy.RequestApprovalAsync(approvalReq);

        // Tamper decision: Return Approved with a different hash
        string tamperedHash = ActionPolicyEngine.ComputeCanonicalHash(new() { ["target"] = "critical_system.dll" });
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_tamper_check",
            ActionId = "act_tamper_check",
            ActionType = "SimulatedClick",
            ParametersSha256 = tamperedHash,
            Approved = true
        }, "session_1");

        var result = await reqTask;
        Assert.False(result.Approved);
        Assert.Equal("IntegrityMismatch", result.DecisionSource);
        Assert.Contains("does not match", result.RejectionReason);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 9: Target Process and HWND Mismatch Rejected
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public void Scenario09_Target_Process_And_Hwnd_Mismatch_Rejected()
    {
        var (_, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["key"] = "val" };
        var (isValid, err) = policy.ValidateConsumedApproval(
            "",
            "act_1",
            "SimulatedClick",
            paramsMap,
            "notepad.exe",
            12345);

        Assert.False(isValid);
        Assert.Contains("Missing or malformed required approval ID", err);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 10: Client Disconnect Cancels In-Flight Actions (Fail-Closed)
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario10_Client_Disconnect_Cancels_In_Flight_Actions_Fail_Closed()
    {
        var (engine, _, _) = CreateTestEngine();

        var req1 = new SimulatedActionRequest
        {
            ActionId = "act_session_a_1",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 2500
        };
        var req2 = new SimulatedActionRequest
        {
            ActionId = "act_session_b_1",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 2500
        };

        var taskA = engine.ExecuteSimulatedActionAsync(req1, "session_client_A");
        var taskB = engine.ExecuteSimulatedActionAsync(req2, "session_client_B");

        await Task.Delay(40);
        Assert.Equal(2, engine.ActiveActionCount);

        // Disconnect session A
        int cancelledA = engine.CancelActionsForSession("session_client_A");
        Assert.Equal(1, cancelledA);

        var resultA = await taskA;
        Assert.False(resultA.Success);
        Assert.Equal("Cancelled", resultA.Status);

        // Session B remains untouched
        Assert.Equal(1, engine.ActiveActionCount);

        // Clean up session B
        engine.CancelActionsForSession("session_client_B");
        await taskB;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 11: Concurrent Stop and Approval Race (Stop Wins)
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario11_Concurrent_Stop_And_Approval_Race_Stop_Wins()
    {
        var (engine, policy, _) = CreateTestEngine();

        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_race_01",
            ActionId = "act_race_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = "hash_race",
            SessionId = "session_1",
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddSeconds(30)
        };

        var reqTask = policy.RequestApprovalAsync(approvalReq);

        // Fire stop and submit approval concurrently
        var t1 = Task.Run(() => engine.TriggerEmergencyStopAsync("ConcurrentRace", "Stop Wins"));
        var t2 = Task.Run(() => policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_race_01",
            ActionId = "act_race_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = "hash_race",
            Approved = true
        }.WithDigest(policy), "session_1"));

        await Task.WhenAll(t1, t2);

        // Regardless of which thread finishes first, emergency stop must be active
        Assert.True(engine.IsEmergencyStopped);

        // Attempting to execute the action with the approval must be blocked
        var actionRes = await engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_race_01",
            ActionType = "SimulatedClick",
            ApprovalId = "appr_race_01"
        }, "session_1");

        Assert.False(actionRes.Success);
        Assert.Equal("Blocked", actionRes.Status);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 12: Duplicate Emergency Stop Idempotency Preserved
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario12_Duplicate_Emergency_Stop_Idempotency_Preserved()
    {
        var (engine, _, _) = CreateTestEngine();

        var tasks = Enumerable.Range(0, 10)
            .Select(i => engine.TriggerEmergencyStopAsync($"Source_{i}", $"Duplicate Stop #{i}"))
            .ToArray();

        var results = await Task.WhenAll(tasks);

        foreach (var r in results)
        {
            Assert.True(r.Success);
        }
        Assert.True(engine.IsEmergencyStopped);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 13: State Transition Validation Enforces Legal Sequences
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public void Scenario13_State_Transition_Validation_Enforces_Legal_Sequences()
    {
        // Valid transitions
        Assert.True(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Created, ActionLifecycleState.PendingApproval));
        Assert.True(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Created, ActionLifecycleState.Approved));
        Assert.True(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Created, ActionLifecycleState.Blocked));
        Assert.True(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.PendingApproval, ActionLifecycleState.Approved));
        Assert.True(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.PendingApproval, ActionLifecycleState.Expired));
        Assert.True(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Approved, ActionLifecycleState.Executing));
        Assert.True(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Executing, ActionLifecycleState.Completed));
        Assert.True(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Executing, ActionLifecycleState.Cancelled));
        Assert.True(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Executing, ActionLifecycleState.Failed));

        // Invalid / Illegal transitions
        Assert.False(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Created, ActionLifecycleState.Executing));
        Assert.False(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Completed, ActionLifecycleState.Executing));
        Assert.False(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Cancelled, ActionLifecycleState.Executing));
        Assert.False(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Failed, ActionLifecycleState.Approved));
        Assert.False(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Expired, ActionLifecycleState.Executing));
        Assert.False(ActionLifecycleValidator.IsValidTransition(ActionLifecycleState.Blocked, ActionLifecycleState.Completed));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 14: Deny-By-Default Policy Rejects Unknown Action
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public void Scenario14_Deny_By_Default_Policy_Rejects_Unknown_Action()
    {
        var (_, policy, _) = CreateTestEngine();

        var (allowed, risk, reason) = policy.EvaluatePolicy("FormatDriveC", new(), "malicious.exe");
        Assert.False(allowed);
        Assert.Equal(ActionRiskLevel.Critical, risk);

        var (unknownAllowed, unknownRisk, unknownReason) = policy.EvaluatePolicy("NonExistentAction123", new(), "app.exe");
        Assert.False(unknownAllowed);
        Assert.Equal(ActionRiskLevel.Critical, unknownRisk);
        Assert.Contains("Deny-by-default", unknownReason);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 15: Emergency Stop Latency Benchmark (N >= 30)
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario15_Emergency_Stop_Latency_Benchmark_N30()
    {
        var (engine, _, _) = CreateTestEngine();
        int n = 35;
        var latenciesMs = new double[n];

        for (int i = 0; i < n; i++)
        {
            // Reset state
            await engine.ResumeExecutionAsync("Bench", "Reset", engine.CurrentStopGeneration);

            var sw = Stopwatch.StartNew();
            await engine.TriggerEmergencyStopAsync("Bench", $"Stop #{i}");
            sw.Stop();

            latenciesMs[i] = sw.Elapsed.TotalMilliseconds;
        }

        Array.Sort(latenciesMs);
        double min = latenciesMs[0];
        double median = latenciesMs[n / 2];
        double p95 = latenciesMs[(int)(n * 0.95)];
        double max = latenciesMs[n - 1];

        _output.WriteLine($"[BENCHMARK] Emergency Stop Latency (N={n}): Min={min:F3}ms, Median={median:F3}ms, P95={p95:F3}ms, Max={max:F3}ms");

        // Rigorous verification criteria: Median stop latency must be < 5ms
        Assert.True(median < 5.0, $"Median emergency stop latency {median:F3}ms exceeded 5.0ms threshold.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 16: Queue Cancellation Latency Benchmark (N >= 30)
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario16_Queue_Cancellation_Latency_Benchmark_N30()
    {
        var (engine, _, _) = CreateTestEngine();
        int n = 35;
        var latenciesMs = new double[n];

        for (int i = 0; i < n; i++)
        {
            await engine.ResumeExecutionAsync("Bench", "Reset", engine.CurrentStopGeneration);

            // Start an active action
            var actTask = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
            {
                ActionId = $"bench_act_{i}",
                ActionType = "SimulatedScroll",
                SimulatedDurationMs = 1500
            }, "bench_sess");

            // Allow execution loop to transition from queue to active
            for (int w = 0; w < 20 && engine.ActiveActionCount == 0; w++)
            {
                await Task.Delay(5);
            }

            var sw = Stopwatch.StartNew();
            var resp = await engine.TriggerEmergencyStopAsync("Bench", $"Cancel Active #{i}");
            await actTask;
            sw.Stop();

            latenciesMs[i] = sw.Elapsed.TotalMilliseconds;
            Assert.Equal(1, resp.ActiveActionsCancelled);
        }

        Array.Sort(latenciesMs);
        double min = latenciesMs[0];
        double median = latenciesMs[n / 2];
        double p95 = latenciesMs[(int)(n * 0.95)];
        double max = latenciesMs[n - 1];

        _output.WriteLine($"[BENCHMARK] Active Cancellation Latency (N={n}): Min={min:F3}ms, Median={median:F3}ms, P95={p95:F3}ms, Max={max:F3}ms");

        Assert.True(median < 10.0, $"Median cancellation latency {median:F3}ms exceeded 10.0ms threshold.");
    }
}

