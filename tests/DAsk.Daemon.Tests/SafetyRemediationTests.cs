using System.Diagnostics;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Daemon.State;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

public class SafetyRemediationTests
{
    private readonly ITestOutputHelper _output;

    public SafetyRemediationTests(ITestOutputHelper output)
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

    private (ActionExecutionEngine engine, ActionPolicyEngine policy, MockStateManager stateMgr) CreateTestEngine(
        bool enablePanicHotkey = true,
        IEvidenceRecorder? evidenceRecorder = null)
    {
        var stateMgr = new MockStateManager();
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, evidenceRecorder);
        var engine = new ActionExecutionEngine(NullLogger<ActionExecutionEngine>.Instance, stateMgr, policy, evidenceRecorder);
        if (enablePanicHotkey)
        {
            engine.SetPanicHotkeyStatus(true, "Test mode hotkey active", 0);
        }
        return (engine, policy, stateMgr);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 17: Forged / Invented Approval Token Rejected Fail-Closed
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario17_Forged_Invented_Approval_Token_Rejected()
    {
        var (engine, _, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["target"] = "calc.exe" };
        var forgedReq = new SimulatedActionRequest
        {
            ActionId = "act_forged_01",
            ActionType = "SimulatedClick",
            Parameters = paramsMap,
            ApprovalId = "appr_forged_non_existent_token_12345",
            SessionId = "session_1",
            StopGeneration = 1,
            SimulatedDurationMs = 10
        };

        var result = await engine.ExecuteSimulatedActionAsync(forgedReq, "session_1");

        Assert.False(result.Success);
        Assert.Equal("Blocked", result.Status);
        Assert.Contains("never granted or does not exist", result.ErrorMessage);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 18: Target HWND Mismatch Rejected
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario18_Target_HWND_Mismatch_Rejected()
    {
        var (engine, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["cmd"] = "open" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        // Pre-grant approval specifically for HWND 0x1000
        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_hwnd_check_99",
            ActionId = "act_hwnd_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            TargetHwnd = 0x1000,
            TargetProcessId = 1234,
            SessionId = "session_1",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var appTask = policy.RequestApprovalAsync(approvalReq);
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_hwnd_check_99",
            ActionId = "act_hwnd_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            SessionId = "session_1",
            StopGeneration = 1,
            Approved = true
        });
        await appTask;

        // Attempt execution targeting a DIFFERENT HWND 0x2000
        var req = new SimulatedActionRequest
        {
            ActionId = "act_hwnd_01",
            ActionType = "SimulatedClick",
            Parameters = paramsMap,
            ApprovalId = "appr_hwnd_check_99",
            TargetHwnd = 0x2000, // Different HWND!
            TargetProcessId = 1234,
            SessionId = "session_1",
            StopGeneration = 1,
            SimulatedDurationMs = 10
        };

        var result = await engine.ExecuteSimulatedActionAsync(req, "session_1");

        Assert.False(result.Success);
        Assert.Equal("Blocked", result.Status);
        Assert.Contains("Target HWND mismatch", result.ErrorMessage);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 19: Target PID Mismatch Rejected
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario19_Target_PID_Mismatch_Rejected()
    {
        var (engine, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["cmd"] = "open" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        // Pre-grant approval for PID 4444
        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_pid_check_99",
            ActionId = "act_pid_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            TargetHwnd = 0x1000,
            TargetProcessId = 4444,
            SessionId = "session_1",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var appTask = policy.RequestApprovalAsync(approvalReq);
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_pid_check_99",
            ActionId = "act_pid_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            SessionId = "session_1",
            StopGeneration = 1,
            Approved = true
        });
        await appTask;

        // Attempt execution targeting a DIFFERENT PID 8888
        var req = new SimulatedActionRequest
        {
            ActionId = "act_pid_01",
            ActionType = "SimulatedClick",
            Parameters = paramsMap,
            ApprovalId = "appr_pid_check_99",
            TargetHwnd = 0x1000,
            TargetProcessId = 8888, // Different PID!
            SessionId = "session_1",
            StopGeneration = 1,
            SimulatedDurationMs = 10
        };

        var result = await engine.ExecuteSimulatedActionAsync(req, "session_1");

        Assert.False(result.Success);
        Assert.Equal("Blocked", result.Status);
        Assert.Contains("Target Process ID mismatch", result.ErrorMessage);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 20: Reused HWND with Different Process Creation Time Rejected
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario20_Reused_HWND_Process_Creation_Time_Mismatch_Rejected()
    {
        var (engine, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["cmd"] = "open" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        var originalCreationTime = DateTimeOffset.UtcNow.AddHours(-1);
        var recycledCreationTime = DateTimeOffset.UtcNow.AddSeconds(-5);

        // Pre-grant approval for process created at originalCreationTime
        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_recycle_check_99",
            ActionId = "act_recycle_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            TargetHwnd = 0x1000,
            TargetProcessId = 1234,
            TargetProcessCreationTime = originalCreationTime,
            SessionId = "session_1",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var appTask = policy.RequestApprovalAsync(approvalReq);
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_recycle_check_99",
            ActionId = "act_recycle_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            SessionId = "session_1",
            StopGeneration = 1,
            Approved = true
        });
        await appTask;

        // Present identical HWND & PID, but DIFFERENT creation time (recycled HWND attack)
        var req = new SimulatedActionRequest
        {
            ActionId = "act_recycle_01",
            ActionType = "SimulatedClick",
            Parameters = paramsMap,
            ApprovalId = "appr_recycle_check_99",
            TargetHwnd = 0x1000,
            TargetProcessId = 1234,
            TargetProcessCreationTime = recycledCreationTime,
            SessionId = "session_1",
            StopGeneration = 1,
            SimulatedDurationMs = 10
        };

        var result = await engine.ExecuteSimulatedActionAsync(req, "session_1");

        Assert.False(result.Success);
        Assert.Equal("Blocked", result.Status);
        Assert.Contains("process instance creation time mismatch", result.ErrorMessage);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 21: Cross-Session Approval Token Rejected
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario21_Cross_Session_Approval_Token_Rejected()
    {
        var (engine, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["cmd"] = "open" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        // Pre-grant approval for session A
        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_session_a_99",
            ActionId = "act_cross_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            SessionId = "session_A",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var appTask = policy.RequestApprovalAsync(approvalReq);
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_session_a_99",
            ActionId = "act_cross_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            SessionId = "session_A",
            StopGeneration = 1,
            Approved = true
        });
        await appTask;

        // Session B attempts to consume the token granted to session A
        var req = new SimulatedActionRequest
        {
            ActionId = "act_cross_01",
            ActionType = "SimulatedClick",
            Parameters = paramsMap,
            ApprovalId = "appr_session_a_99",
            SessionId = "session_B",
            StopGeneration = 1,
            SimulatedDurationMs = 10
        };

        var result = await engine.ExecuteSimulatedActionAsync(req, "session_B");

        Assert.False(result.Success);
        Assert.Equal("Blocked", result.Status);
        Assert.Contains("Cross-session approval token use rejected", result.ErrorMessage);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 22: Stale Stop Generation Approval Rejected
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario22_Stale_Stop_Generation_Approval_Rejected()
    {
        var (engine, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["cmd"] = "open" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        // Pre-grant approval during Generation 1
        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_epoch_01",
            ActionId = "act_epoch_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            SessionId = "session_1",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var appTask = policy.RequestApprovalAsync(approvalReq);
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_epoch_01",
            ActionId = "act_epoch_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            SessionId = "session_1",
            StopGeneration = 1,
            Approved = true
        });
        await appTask;

        // Emergency Stop occurs! This increments StopGeneration to 2
        var stopResp = await engine.TriggerEmergencyStopAsync("Test", "Epoch increment");
        Assert.Equal(2UL, engine.CurrentStopGeneration);

        // Resume execution (still at Generation 2)
        await engine.ResumeExecutionAsync("Test", "Resume into Gen 2");
        Assert.Equal(2UL, engine.CurrentStopGeneration);

        // Attempt to consume the old Generation 1 approval token in Generation 2
        var req = new SimulatedActionRequest
        {
            ActionId = "act_epoch_01",
            ActionType = "SimulatedClick",
            Parameters = paramsMap,
            ApprovalId = "appr_epoch_01",
            SessionId = "session_1",
            StopGeneration = 2,
            SimulatedDurationMs = 10
        };

        var result = await engine.ExecuteSimulatedActionAsync(req, "session_1");

        Assert.False(result.Success);
        Assert.Equal("Blocked", result.Status);
        // Either invalidated during emergency stop or rejected for stale epoch
        Assert.True(result.ErrorMessage.Contains("never granted or does not exist") ||
                    result.ErrorMessage.Contains("does not match current execution epoch"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 23: Concurrent Approval Consumption Permits Exactly One Winner
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario23_Concurrent_Approval_Consumption_Single_Winner()
    {
        var (engine, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["cmd"] = "run" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        // Pre-grant single approval
        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_concurrent_race_99",
            ActionId = "act_race_common",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            SessionId = "session_1",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var appTask = policy.RequestApprovalAsync(approvalReq);
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_concurrent_race_99",
            ActionId = "act_race_common",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            SessionId = "session_1",
            StopGeneration = 1,
            Approved = true
        });
        await appTask;

        int concurrentAttempts = 20;
        var tasks = new Task<SimulatedActionResponse>[concurrentAttempts];

        for (int i = 0; i < concurrentAttempts; i++)
        {
            var req = new SimulatedActionRequest
            {
                ActionId = "act_race_common",
                ActionType = "SimulatedClick",
                Parameters = paramsMap,
                ApprovalId = "appr_concurrent_race_99",
                SessionId = "session_1",
                StopGeneration = 1,
                SimulatedDurationMs = 10
            };
            tasks[i] = Task.Run(() => engine.ExecuteSimulatedActionAsync(req, "session_1"));
        }

        var results = await Task.WhenAll(tasks);

        int successes = results.Count(r => r.Success && r.Status == "Completed");
        int failures = results.Count(r => !r.Success && r.Status == "Blocked");

        _output.WriteLine($"[CONCURRENCY] Concurrent consumption of single token: Successes={successes}, Failures={failures}");

        // Invariant: Exactly one consumer wins, all other 19 fail
        Assert.Equal(1, successes);
        Assert.Equal(concurrentAttempts - 1, failures);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 24: Panic Hotkey Unavailable Blocks Action Execution Fail-Closed
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario24_Panic_Hotkey_Unavailable_Blocks_Execution()
    {
        // Engine created with hotkey DISABLED (fail-closed startup latch)
        var (engine, _, _) = CreateTestEngine(enablePanicHotkey: false);
        Assert.False(engine.IsPanicHotkeyAvailable);

        var req = new SimulatedActionRequest
        {
            ActionId = "act_nohotkey_01",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 10
        };

        var result = await engine.ExecuteSimulatedActionAsync(req, "session_1");

        Assert.False(result.Success);
        Assert.Equal("Blocked", result.Status);
        Assert.Contains("panic hotkey is unavailable", result.ErrorMessage, StringComparison.OrdinalIgnoreCase);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 25: Session Disconnect Invalidates Pending and Granted Approvals
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario25_Session_Disconnect_Invalidates_Pending_And_Granted_Approvals()
    {
        var (engine, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["text"] = "test" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        // 1. Pending approval for session A
        var pendingReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_pending_sess_a",
            ActionId = "act_pending_sess_a",
            ActionType = "SimulatedType",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            SessionId = "sess_A",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var pendingTask = policy.RequestApprovalAsync(pendingReq);

        // 2. Granted approval for session A
        var grantedReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_granted_sess_a",
            ActionId = "act_granted_sess_a",
            ActionType = "SimulatedType",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            SessionId = "sess_A",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var grantedTask = policy.RequestApprovalAsync(grantedReq);
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_granted_sess_a",
            ActionId = "act_granted_sess_a",
            ActionType = "SimulatedType",
            ParametersSha256 = hash,
            SessionId = "sess_A",
            StopGeneration = 1,
            Approved = true
        });
        await grantedTask;

        // Session A disconnects!
        int invalidated = policy.InvalidateApprovalsForSession("sess_A", "Client disconnected");
        Assert.True(invalidated >= 2);

        var pendingResult = await pendingTask;
        Assert.False(pendingResult.Approved);
        Assert.Equal("SessionDisconnectedDenied", pendingResult.DecisionSource);

        // Attempting to consume the granted approval after disconnect must fail
        var execReq = new SimulatedActionRequest
        {
            ActionId = "act_granted_sess_a",
            ActionType = "SimulatedType",
            Parameters = paramsMap,
            ApprovalId = "appr_granted_sess_a",
            SessionId = "sess_A",
            StopGeneration = 1,
            SimulatedDurationMs = 10
        };

        var execRes = await engine.ExecuteSimulatedActionAsync(execReq, "sess_A");
        Assert.False(execRes.Success);
        Assert.Equal("Blocked", execRes.Status);
        Assert.Contains("never granted or does not exist", execRes.ErrorMessage);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 26: Resume Execution Drains Active Tasks Before Re-Enabling
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario26_Resume_Execution_Drains_Active_Tasks_Before_Clearing_Latch()
    {
        var (engine, _, _) = CreateTestEngine();

        // Start active action with simulated duration
        var activeReq = new SimulatedActionRequest
        {
            ActionId = "act_drain_check",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 500
        };
        var activeTask = engine.ExecuteSimulatedActionAsync(activeReq, "session_1");

        await Task.Delay(30);
        Assert.Equal(1, engine.ActiveActionCount);

        // Trigger stop
        var stopResp = await engine.TriggerEmergencyStopAsync("Test", "Drain stop");
        Assert.True(stopResp.Success);

        // Resume execution must wait for activeTask to completely drain
        var sw = Stopwatch.StartNew();
        var resumeResp = await engine.ResumeExecutionAsync("Test", "Resume after drain");
        sw.Stop();

        Assert.True(resumeResp.Success);
        Assert.Equal(0, engine.ActiveActionCount);

        var activeResult = await activeTask;
        Assert.Equal("Cancelled", activeResult.Status);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 27: SQLite Evidence Recorder Logs All State Transitions
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario27_Sqlite_Evidence_Recorder_Logs_All_State_Transitions()
    {
        string dbPath = Path.Combine(Path.GetTempPath(), $"dask_safety_audit_test_{Guid.NewGuid():N}.db");
        try
        {
            var recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, dbPath);
            var (engine, policy, _) = CreateTestEngine(enablePanicHotkey: true, evidenceRecorder: recorder);

            // Execute a simulated action
            var req = new SimulatedActionRequest
            {
                ActionId = "act_sqlite_01",
                ActionType = "SimulatedScroll",
                SimulatedDurationMs = 20
            };
            var execRes = await engine.ExecuteSimulatedActionAsync(req, "test_session_sqlite");
            Assert.True(execRes.Success);

            // Trigger emergency stop and resume
            await engine.TriggerEmergencyStopAsync("TestRunner", "Audit verification stop");
            await engine.ResumeExecutionAsync("TestRunner", "Audit verification resume");

            // Query audit trail records from SQLite
            var auditRecords = await recorder.GetSafetyAuditRecordsAsync(100);
            var actionRecords = auditRecords.Where(r => r.ActionId == "act_sqlite_01").ToList();

            _output.WriteLine($"[SQLITE] Recorded {actionRecords.Count} safety audit records for act_sqlite_01.");
            Assert.NotEmpty(actionRecords);

            var executingRecord = actionRecords.FirstOrDefault(r => r.EventType == "Action_Executing");
            var completedRecord = actionRecords.FirstOrDefault(r => r.EventType == "Action_Completed");

            Assert.NotNull(executingRecord);
            Assert.NotNull(completedRecord);
            Assert.Equal("test_session_sqlite", executingRecord.SessionId);
            Assert.Equal(1UL, executingRecord.StopGeneration);

            // Verify EmergencyStop and ExecutionResumed events were also logged
            var stopEvent = auditRecords.FirstOrDefault(r => r.EventType == "EmergencyStop");
            var resumeEvent = auditRecords.FirstOrDefault(r => r.EventType == "ExecutionResumed");
            Assert.NotNull(stopEvent);
            Assert.NotNull(resumeEvent);
        }
        finally
        {
            if (File.Exists(dbPath))
            {
                try { File.Delete(dbPath); } catch { }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 28: Shared Memory Transport Security (Unnamed Sections)
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public void Scenario28_SharedMemory_UnnamedSection_Transport_Security()
    {
        var bufferMgr = new ObservationBufferManager(NullLogger<ObservationBufferManager>.Instance);

        // When clientProcessId is provided (IPC session), BufferManager creates an unnamed section
        uint clientPid = (uint)Process.GetCurrentProcess().Id;
        byte[] sampleData = new byte[1024];
        var (sharedMemoryName, targetHandle) = bufferMgr.CreateSharedBuffer("obs_test_01", sampleData, clientPid, "session_shm_test");

        _output.WriteLine($"Created buffer: Name='{sharedMemoryName ?? "(unnamed)"}', Handle={targetHandle}");

        // Invariant: Named shared memory is NULL to eliminate local namespace attacks, and handle is duplicated into client
        Assert.Null(sharedMemoryName);
        Assert.NotNull(targetHandle);
        Assert.True(targetHandle.Value > 0);

        bufferMgr.TryReleaseBuffer("obs_test_01");
        bufferMgr.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 29: ValidateConsumedApproval Latency Benchmark (N >= 35)
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Scenario29_ValidateConsumedApproval_Latency_Benchmark_N35()
    {
        var (_, policy, _) = CreateTestEngine();
        int n = 35;
        var latenciesMs = new double[n];
        var paramsMap = new Dictionary<string, string> { ["target"] = "process.exe", ["arg"] = "value" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        for (int i = 0; i < n; i++)
        {
            string approvalId = $"bench_appr_{i}_{Guid.NewGuid():N}";
            string actionId = $"bench_act_{i}";

            var approvalReq = new ActionApprovalRequest
            {
                ApprovalId = approvalId,
                ActionId = actionId,
                ActionType = "SimulatedClick",
                ParametersSha256 = hash,
                ActionParameters = paramsMap,
                TargetProcessName = "process.exe",
                TargetHwnd = 1000,
                TargetProcessId = 5000,
                SessionId = "session_bench",
                StopGeneration = 1,
                ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
            };
            var task = policy.RequestApprovalAsync(approvalReq);
            policy.SubmitApprovalDecision(new ActionApprovalResponse
            {
                ApprovalId = approvalId,
                ActionId = actionId,
                ActionType = "SimulatedClick",
                ParametersSha256 = hash,
                SessionId = "session_bench",
                StopGeneration = 1,
                Approved = true
            });
            await task;

            var sw = Stopwatch.StartNew();
            var (isValid, err) = policy.ValidateConsumedApproval(
                approvalId,
                actionId,
                "SimulatedClick",
                paramsMap,
                "process.exe",
                1000,
                5000,
                null,
                "session_bench",
                1,
                false);
            sw.Stop();

            Assert.True(isValid, err);
            latenciesMs[i] = sw.Elapsed.TotalMilliseconds;
        }

        Array.Sort(latenciesMs);
        double min = latenciesMs[0];
        double median = latenciesMs[n / 2];
        double p95 = latenciesMs[(int)(n * 0.95)];
        double max = latenciesMs[n - 1];

        _output.WriteLine($"[BENCHMARK] ValidateConsumedApproval Latency (N={n}): Min={min:F4}ms, Median={median:F4}ms, P95={p95:F4}ms, Max={max:F4}ms");
        Assert.True(median < 1.0, $"Median validation latency {median:F4}ms exceeded 1.0ms threshold.");
    }
}
