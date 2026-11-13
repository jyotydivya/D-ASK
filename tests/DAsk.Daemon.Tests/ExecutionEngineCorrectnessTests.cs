using System.Diagnostics;
using System.IO.Pipes;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.IPC;
using DAsk.Daemon.Research;
using DAsk.Daemon.State;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

public class ExecutionEngineCorrectnessTests
{
    private readonly ITestOutputHelper _output;

    public ExecutionEngineCorrectnessTests(ITestOutputHelper output)
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
        IEvidenceRecorder? evidenceRecorder = null,
        int maxQueueCapacity = ActionExecutionEngine.MaxQueueCapacityDefault,
        int maxConcurrency = 1)
    {
        var stateMgr = new MockStateManager();
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, evidenceRecorder);
        var engine = new ActionExecutionEngine(
            NullLogger<ActionExecutionEngine>.Instance,
            stateMgr,
            policy,
            evidenceRecorder,
            maxQueueCapacity,
            maxConcurrency);

        if (enablePanicHotkey)
        {
            engine.SetPanicHotkeyStatus(true, "Test mode hotkey active", 0);
        }
        return (engine, policy, stateMgr);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: Drain succeeds when all tasks finish
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test01_DrainActiveTasks_AllTasksFinish_ReturnsTrue()
    {
        var (engine, _, _) = CreateTestEngine();

        // 0 active tasks must return true immediately
        bool emptyDrain = await engine.DrainActiveTasksAsync(TimeSpan.FromMilliseconds(50));
        Assert.True(emptyDrain, "Empty active task list must return true.");

        // Start 2 short tasks
        var t1 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_drain_fast_1",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 20
        }, "sess_1");

        var t2 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_drain_fast_2",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 20
        }, "sess_1");

        // Drain with generous timeout
        bool drained = await engine.DrainActiveTasksAsync(TimeSpan.FromSeconds(2));
        Assert.True(drained, "Tasks finishing before timeout must return true.");

        var res1 = await t1;
        var res2 = await t2;
        Assert.True(res1.Success);
        Assert.True(res2.Success);
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: Drain returns false when a task exceeds timeout
    // (Regression test for Task.Delay object reference comparison bug)
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test02_DrainActiveTasks_TaskExceedsTimeout_ReturnsFalse()
    {
        var (engine, _, _) = CreateTestEngine();

        // Start a long active task (3000 ms)
        var longTask = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_drain_long",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 3000
        }, "sess_1");

        // Wait briefly so task is active
        await Task.Delay(30);
        Assert.Equal(1, engine.ActiveActionCount);

        // Attempt drain with short timeout (50 ms)
        var sw = Stopwatch.StartNew();
        bool drained = await engine.DrainActiveTasksAsync(TimeSpan.FromMilliseconds(50));
        sw.Stop();

        _output.WriteLine($"Drain timeout test: result={drained}, elapsed={sw.Elapsed.TotalMilliseconds:F2}ms");

        // In the previous buggy implementation, completedTask != Task.Delay(timeout) ALWAYS returned true!
        // In the fixed implementation, this MUST return false.
        Assert.False(drained, "DrainActiveTasksAsync must return false when active tasks exceed timeout.");

        // Clean up
        await engine.TriggerEmergencyStopAsync("Test", "Cleanup");
        await longTask;
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: Resume remains blocked when drain times out
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test03_ResumeExecution_DrainTimesOut_RemainsStopped()
    {
        var (engine, _, _) = CreateTestEngine();

        // Controllable synchronization primitive to hold cancellation/cleanup open
        var cleanupHoldGate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var cleanupReachedTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        engine.ActionLifecycleChanged += (sender, notification) =>
        {
            if (notification.ActionId == "act_resume_stall" &&
                notification.Reason == "Simulation cancelled")
            {
                // Signal that the action worker has entered cancellation unwinding
                cleanupReachedTcs.TrySetResult(true);
                // Deliberately hold cleanup open until released by the test
                cleanupHoldGate.Task.GetAwaiter().GetResult();
            }
        };

        // Start long active task
        var longTask = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_resume_stall",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 5000
        }, "sess_1");

        // Wait until task is active
        await Task.Delay(30);
        Assert.Equal(1, engine.ActiveActionCount);

        // Trigger emergency stop while action is active
        var stopTask = engine.TriggerEmergencyStopAsync("Test", "Stop before stall test");

        // Wait until the action reaches cancellation unwinding and is held at our gate
        await cleanupReachedTcs.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await stopTask;

        Assert.True(engine.IsEmergencyStopped);
        Assert.Equal(1, engine.ActiveActionCount); // Old action remains registered!

        // Attempt resume with drain timeout shorter than the held cleanup (50 ms)
        var resumeResult = await engine.ResumeExecutionAsync("Test", "Attempt resume", engine.CurrentStopGeneration, drainTimeout: TimeSpan.FromMilliseconds(50));

        // Unconditional assertions: Must fail and system must remain stopped
        Assert.False(resumeResult.Success);
        Assert.Contains("actions are still completing cancellation", resumeResult.ErrorMessage);
        Assert.True(engine.IsEmergencyStopped, "System must remain stopped when drain times out.");
        Assert.Equal(1, engine.ActiveActionCount); // Demonstrably still registered / cleaning up!

        // Release the test gate to allow worker to finish unwinding
        cleanupHoldGate.TrySetResult(true);

        // Await the task completion
        var actionResult = await longTask;
        Assert.Equal("Cancelled", actionResult.Status);
        Assert.Equal(0, engine.ActiveActionCount); // Fully unregistered now!

        // Subsequent resume succeeds only after cleanup finishes
        var secondResumeResult = await engine.ResumeExecutionAsync("Test", "Resume after cleanup complete", engine.CurrentStopGeneration, drainTimeout: TimeSpan.FromSeconds(2));
        Assert.True(secondResumeResult.Success);
        Assert.False(engine.IsEmergencyStopped);
        Assert.Equal(0, engine.ActiveActionCount);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: Queue accepts work up to capacity
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test04_Queue_AcceptsWork_UpToCapacity()
    {
        // Engine with maxQueueCapacity = 3
        var (engine, _, _) = CreateTestEngine(maxQueueCapacity: 3);

        // 1 active task running for 500ms
        var activeTask = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_blocker",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 500
        }, "sess_1");

        await Task.Delay(30);
        Assert.Equal(1, engine.ActiveActionCount);

        // Enqueue 3 additional actions up to capacity
        var q1 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_q1",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 10
        }, "sess_1");

        var q2 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_q2",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 10
        }, "sess_1");

        var q3 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_q3",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 10
        }, "sess_1");

        // Verify queued count is exactly 3
        Assert.Equal(3, engine.QueuedActionCount);

        // Clean up
        await engine.TriggerEmergencyStopAsync("Test", "Cleanup");
        await Task.WhenAll(activeTask, q1, q2, q3);
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5: Queue rejects work beyond capacity
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test05_Queue_RejectsWork_BeyondCapacity()
    {
        // Engine with maxQueueCapacity = 2
        var (engine, _, _) = CreateTestEngine(maxQueueCapacity: 2);

        // Blocker active task
        var activeTask = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_blocker",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 1000
        }, "sess_1");

        await Task.Delay(30);

        // Enqueue 2 actions (fills capacity 2)
        var q1 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_q1",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 10
        }, "sess_1");

        var q2 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_q2",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 10
        }, "sess_1");

        Assert.Equal(2, engine.QueuedActionCount);

        // Attempt 3rd queued action (exceeds capacity 2)
        var overflowRes = await engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_overflow",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 10
        }, "sess_1");

        Assert.False(overflowRes.Success);
        Assert.Equal("Blocked", overflowRes.Status);
        Assert.Contains("queue saturated", overflowRes.ErrorMessage, StringComparison.OrdinalIgnoreCase);

        // Clean up
        await engine.TriggerEmergencyStopAsync("Test", "Cleanup");
        await Task.WhenAll(activeTask, q1, q2);
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6: Stop cancels queued work
    // ─────────────────────────────────────────────────────────────────────────
    /// <summary>
    /// Regression for the stop-count race: the shared token used to fire before the count, so an action could
    /// finish cancelling and unregister first, and the stop reported 0 for an action it had just cancelled.
    /// </summary>
    [Fact]
    public async Task EmergencyStop_ReportedActiveCount_IsExact_WhenActionsUnwindImmediately()
    {
        for (int i = 0; i < 100; i++)
        {
            var (engine, _, _) = CreateTestEngine();
            var action = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
            {
                ActionId = $"act_race_{i}",
                ActionType = "SimulatedScroll",
                SimulatedDurationMs = 30_000
            }, "sess_1");

            var deadline = Stopwatch.StartNew();
            while (engine.ActiveActionCount == 0 && deadline.ElapsedMilliseconds < 5000) await Task.Delay(1);
            Assert.Equal(1, engine.ActiveActionCount);

            var stop = await engine.TriggerEmergencyStopAsync("TestRunner", "race regression");
            var result = await action;

            Assert.Equal(1, stop.ActiveActionsCancelled);
            Assert.Equal("Cancelled", result.Status);
            engine.Dispose();
        }
    }

    /// <summary>A stop with nothing running must report zero, not a stale or inflated number.</summary>
    [Fact]
    public async Task EmergencyStop_WithNoActiveActions_ReportsZero()
    {
        var (engine, _, _) = CreateTestEngine();
        var done = await engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_finished_before_stop",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 1
        }, "sess_1");
        Assert.Equal("Completed", done.Status);

        var stop = await engine.TriggerEmergencyStopAsync("TestRunner", "nothing running");
        Assert.Equal(0, stop.ActiveActionsCancelled);
        engine.Dispose();
    }

    [Fact]
    public async Task Test06_EmergencyStop_CancelsQueuedWork()
    {
        var (engine, _, _) = CreateTestEngine();

        var blocker = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_blocker_long",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 3000
        }, "sess_1");

        await Task.Delay(30);

        var q1 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_queued_1",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 50
        }, "sess_1");

        var q2 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_queued_2",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 50
        }, "sess_1");

        Assert.Equal(2, engine.QueuedActionCount);

        var stopResp = await engine.TriggerEmergencyStopAsync("TestRunner", "Test Stop Queued Work");

        Assert.True(stopResp.Success);
        Assert.Equal(2, stopResp.QueuedActionsCancelled);
        Assert.Equal(1, stopResp.ActiveActionsCancelled);
        Assert.Equal(0, engine.QueuedActionCount);

        var r1 = await q1;
        var r2 = await q2;
        var rb = await blocker;

        Assert.Equal("Cancelled", r1.Status);
        Assert.Equal("Cancelled", r2.Status);
        Assert.Equal("Cancelled", rb.Status);
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 7: Stop cancels active work
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test07_EmergencyStop_CancelsActiveWork()
    {
        var (engine, _, _) = CreateTestEngine();

        var activeTask = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_cancel_active",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 3000
        }, "sess_1");

        await Task.Delay(30);
        Assert.Equal(1, engine.ActiveActionCount);

        var stopResp = await engine.TriggerEmergencyStopAsync("TestRunner", "Cancel active");
        var activeRes = await activeTask;

        Assert.True(stopResp.Success);
        Assert.Equal(1, stopResp.ActiveActionsCancelled);
        Assert.Equal("Cancelled", activeRes.Status);
        Assert.Equal(0, engine.ActiveActionCount);
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 8: Queue does not dispatch while stopped
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test08_Queue_DoesNotDispatch_WhileStopped()
    {
        var (engine, _, _) = CreateTestEngine();

        await engine.TriggerEmergencyStopAsync("TestRunner", "Arm Stop");
        Assert.True(engine.IsEmergencyStopped);

        var res = await engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_blocked_while_stopped",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 100
        }, "sess_1");

        Assert.False(res.Success);
        Assert.Equal("Blocked", res.Status);
        Assert.Contains("Emergency Stop is active", res.ErrorMessage);
        Assert.Equal(0, engine.QueuedActionCount);
        Assert.Equal(0, engine.ActiveActionCount);
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 9: Stop between approval validation and dispatch prevents execution
    // (Atomic authorization guarantee)
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test09_Stop_BetweenApprovalValidationAndDispatch_PreventsExecution()
    {
        var (engine, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["target"] = "app.exe" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        // Pre-grant approval for Gen 1
        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_atomic_01",
            ActionId = "act_atomic_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            SessionId = "sess_1",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var appTask = policy.RequestApprovalAsync(approvalReq);
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_atomic_01",
            ActionId = "act_atomic_01",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            SessionId = "sess_1",
            StopGeneration = 1,
            Approved = true
        }.WithDigest(policy), "sess_1");
        await appTask;

        // Block queue with a 200ms active task
        var blocker = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_blocker_sync",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 200
        }, "sess_1");

        await Task.Delay(30);

        // Enqueue elevated action requiring appr_atomic_01
        var elevatedTask = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_atomic_01",
            ActionType = "SimulatedClick",
            Parameters = paramsMap,
            ApprovalId = "appr_atomic_01",
            SessionId = "sess_1",
            StopGeneration = 1,
            SimulatedDurationMs = 100
        }, "sess_1");

        Assert.Equal(1, engine.QueuedActionCount);

        // Emergency Stop occurs while act_atomic_01 is waiting in queue!
        await engine.TriggerEmergencyStopAsync("TestRunner", "Intervening stop");

        var elevatedRes = await elevatedTask;
        var blockerRes = await blocker;

        Assert.False(elevatedRes.Success);
        Assert.True(elevatedRes.Status == "Cancelled" || elevatedRes.Status == "Blocked",
            $"Expected Cancelled or Blocked, got {elevatedRes.Status}");
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 10: Old-generation approval cannot execute after Resume
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test10_OldGenerationApproval_CannotExecuteInNewEpoch()
    {
        var (engine, policy, _) = CreateTestEngine();

        var paramsMap = new Dictionary<string, string> { ["target"] = "window" };
        string hash = ActionPolicyEngine.ComputeCanonicalHash(paramsMap);

        // Grant approval in Epoch 1
        var approvalReq = new ActionApprovalRequest
        {
            ApprovalId = "appr_epoch_old",
            ActionId = "act_epoch_old",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            ActionParameters = paramsMap,
            SessionId = "sess_1",
            StopGeneration = 1,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        var appTask = policy.RequestApprovalAsync(approvalReq);
        policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = "appr_epoch_old",
            ActionId = "act_epoch_old",
            ActionType = "SimulatedClick",
            ParametersSha256 = hash,
            SessionId = "sess_1",
            StopGeneration = 1,
            Approved = true
        }.WithDigest(policy), "sess_1");
        await appTask;

        // Emergency stop increments epoch to 2
        await engine.TriggerEmergencyStopAsync("TestRunner", "Advance epoch to 2");
        Assert.Equal(2UL, engine.CurrentStopGeneration);

        // Resume execution into epoch 2
        await engine.ResumeExecutionAsync("TestRunner", "Resume in epoch 2", engine.CurrentStopGeneration);
        Assert.Equal(2UL, engine.CurrentStopGeneration);

        // Attempt execution in epoch 2 with the approval from epoch 1
        var staleExec = await engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_epoch_old",
            ActionType = "SimulatedClick",
            Parameters = paramsMap,
            ApprovalId = "appr_epoch_old",
            SessionId = "sess_1",
            StopGeneration = 2,
            SimulatedDurationMs = 10
        }, "sess_1");

        Assert.False(staleExec.Success);
        Assert.Equal("Blocked", staleExec.Status);
        Assert.True(staleExec.ErrorMessage.Contains("never granted or does not exist") ||
                    staleExec.ErrorMessage.Contains("does not match current execution epoch"));
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 11: Concurrent Stop and dispatch cannot create an unauthorized execution
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test11_ConcurrentStopAndDispatch_NeverCreatesUnauthorizedExecution()
    {
        var (engine, _, _) = CreateTestEngine();

        int taskCount = 20;
        var tasks = new Task<SimulatedActionResponse>[taskCount];

        for (int i = 0; i < taskCount; i++)
        {
            int idx = i;
            tasks[i] = Task.Run(() => engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
            {
                ActionId = $"act_concurrent_{idx}",
                ActionType = "SimulatedScroll",
                SimulatedDurationMs = 50
            }, "sess_race"));
        }

        // Concurrently trigger emergency stop mid-flight
        await Task.Delay(10);
        var stopResp = await engine.TriggerEmergencyStopAsync("TestRunner", "Concurrent race stop");
        Assert.True(stopResp.Success);

        var results = await Task.WhenAll(tasks);

        int completed = results.Count(r => r.Success && r.Status == "Completed");
        int cancelledOrBlocked = results.Count(r => !r.Success && (r.Status == "Cancelled" || r.Status == "Blocked"));

        _output.WriteLine($"Concurrent stop race: Completed={completed}, Cancelled/Blocked={cancelledOrBlocked}");

        // Invariant: Total tasks must equal completed + cancelled/blocked, with zero unhandled exceptions
        Assert.Equal(taskCount, completed + cancelledOrBlocked);
        Assert.True(engine.IsEmergencyStopped);
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 12: Session disconnect cancels that session's queued and active work
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test12_SessionDisconnect_CancelsQueuedAndActiveWork()
    {
        var (engine, _, _) = CreateTestEngine();

        // Session A starts a 500ms active blocker
        var sessA_active = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_sessA_active",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 500
        }, "session_A");

        await Task.Delay(30);

        // Session A enqueues 2 actions
        var sessA_q1 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_sessA_q1",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 50
        }, "session_A");

        var sessA_q2 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_sessA_q2",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 50
        }, "session_A");

        // Session B enqueues 1 action
        var sessB_q1 = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_sessB_q1",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 50
        }, "session_B");

        Assert.Equal(3, engine.QueuedActionCount);

        // Session A disconnects!
        int cancelledCount = engine.CancelActionsForSession("session_A");
        Assert.True(cancelledCount >= 3, $"Expected at least 3 cancelled actions for session A, got {cancelledCount}");

        var resA_active = await sessA_active;
        var resA_q1 = await sessA_q1;
        var resA_q2 = await sessA_q2;

        Assert.Equal("Cancelled", resA_active.Status);
        Assert.Equal("Cancelled", resA_q1.Status);
        Assert.Equal("Cancelled", resA_q2.Status);

        // Session B should still execute cleanly
        var resB_q1 = await sessB_q1;
        Assert.True(resB_q1.Success);
        Assert.Equal("Completed", resB_q1.Status);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 13: Session disconnect leaves active action registered until worker finishes cleanup
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test13_SessionDisconnect_ActiveActionRemainsRegisteredUntilWorkerFinishesCleanup()
    {
        var (engine, _, _) = CreateTestEngine();

        var cleanupHoldGate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var cleanupReachedTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        engine.ActionLifecycleChanged += (sender, notification) =>
        {
            if (notification.ActionId == "act_sess_unwind" &&
                notification.Reason == "Simulation cancelled")
            {
                cleanupReachedTcs.TrySetResult(true);
                cleanupHoldGate.Task.GetAwaiter().GetResult();
            }
        };

        var taskA = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_sess_unwind",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 5000
        }, "sess_disconnect_test");

        await Task.Delay(30);
        Assert.Equal(1, engine.ActiveActionCount);

        // Cancel actions for this session
        int cancelled = engine.CancelActionsForSession("sess_disconnect_test");
        Assert.Equal(1, cancelled);

        // Wait until action worker enters cancellation unwinding at the gate
        await cleanupReachedTcs.Task.WaitAsync(TimeSpan.FromSeconds(2));

        // Invariant 1: Action MUST remain registered in _activeActions while worker is unwinding!
        // CancelActionsForSession must NOT eagerly remove active actions from _activeActions.
        Assert.Equal(1, engine.ActiveActionCount);

        // Invariant 2: Trigger Emergency Stop and attempt Resume with short timeout (50ms)
        // Resume CANNOT succeed while the disconnected session's action is still unwinding!
        await engine.TriggerEmergencyStopAsync("Test", "Emergency stop during disconnect unwind");
        var resumeResult = await engine.ResumeExecutionAsync("Test", "Attempt resume", engine.CurrentStopGeneration, drainTimeout: TimeSpan.FromMilliseconds(50));
        Assert.False(resumeResult.Success);
        Assert.True(engine.IsEmergencyStopped);
        Assert.Equal(1, engine.ActiveActionCount);

        // Release the cleanup gate so the worker can complete its finally block
        cleanupHoldGate.TrySetResult(true);

        var resultA = await taskA;
        Assert.False(resultA.Success);
        Assert.Equal("Cancelled", resultA.Status);

        // Invariant 3: After worker completes its finally block, it is unregistered
        Assert.Equal(0, engine.ActiveActionCount);

        // Now subsequent resume succeeds cleanly
        var secondResume = await engine.ResumeExecutionAsync("Test", "Resume after unwound", engine.CurrentStopGeneration, drainTimeout: TimeSpan.FromSeconds(2));
        Assert.True(secondResume.Success);
        Assert.False(engine.IsEmergencyStopped);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 14: Session disconnect isolates cancelled session while other sessions operate normally
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test14_SessionDisconnect_OtherSessionsContinueOperateCorrectly()
    {
        // Engine with maxConcurrency = 2 so both sessions can have active tasks
        var (engine, _, _) = CreateTestEngine(maxConcurrency: 2);

        var taskA = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_session_A_long",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 2000
        }, "session_A");

        var taskB = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_session_B_active",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 50
        }, "session_B");

        await Task.Delay(30);
        Assert.Equal(2, engine.ActiveActionCount);

        // Session B enqueues another task
        var taskB_queued = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_session_B_queued",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 50
        }, "session_B");

        Assert.Equal(1, engine.QueuedActionCount);

        // Disconnect Session A only
        int cancelledA = engine.CancelActionsForSession("session_A");
        Assert.Equal(1, cancelledA);

        var resA = await taskA;
        Assert.Equal("Cancelled", resA.Status);

        // Session B's active action must succeed unaffected
        var resB = await taskB;
        Assert.True(resB.Success);
        Assert.Equal("Completed", resB.Status);

        // Session B's queued action must also succeed unaffected
        var resB_queued = await taskB_queued;
        Assert.True(resB_queued.Success);
        Assert.Equal("Completed", resB_queued.Status);

        Assert.Equal(0, engine.ActiveActionCount);
        Assert.Equal(0, engine.QueuedActionCount);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 15: Drain begins before finalization and waits for cleanup
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test15_DrainBeginsBeforeFinalization_WaitsForCleanup()
    {
        var (engine, _, _) = CreateTestEngine();

        var cleanupGate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var cleanupReached = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        engine.ActionLifecycleChanged += (sender, n) =>
        {
            if (n.ActionId == "act_drain_wait" && n.Reason == "Simulation cancelled")
            {
                cleanupReached.TrySetResult(true);
                cleanupGate.Task.GetAwaiter().GetResult();
            }
        };

        var task = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_drain_wait",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 5000
        }, "sess_1");

        await Task.Delay(30);
        Assert.Equal(1, engine.ActiveActionCount);

        // Cancel action
        await engine.TriggerEmergencyStopAsync("Test", "Stop to trigger drain wait");
        await cleanupReached.Task.WaitAsync(TimeSpan.FromSeconds(2));

        // Start drain while cleanup is deliberately held open
        var drainTask = engine.DrainActiveTasksAsync(TimeSpan.FromSeconds(3));

        // Drain MUST NOT be completed yet because cleanup is held
        await Task.Delay(50);
        Assert.False(drainTask.IsCompleted, "DrainActiveTasksAsync must wait for cleanup while held.");
        Assert.Equal(1, engine.ActiveActionCount);

        // Release cleanup gate
        cleanupGate.TrySetResult(true);

        bool drained = await drainTask;
        Assert.True(drained, "DrainActiveTasksAsync must return true after cleanup finishes.");

        var res = await task;
        Assert.Equal("Cancelled", res.Status);
        Assert.Equal(0, engine.ActiveActionCount);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 16: Drain snapshot under lock ensures action cannot disappear before cleanup
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test16_DrainSnapshotUnderLock_ActionCannotDisappearBeforeCleanup()
    {
        var (engine, _, _) = CreateTestEngine();

        var cleanupGate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var cleanupReached = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        engine.ActionLifecycleChanged += (sender, n) =>
        {
            if (n.ActionId == "act_snapshot_lock" && n.Reason == "Simulation cancelled")
            {
                cleanupReached.TrySetResult(true);
                cleanupGate.Task.GetAwaiter().GetResult();
            }
        };

        var task = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_snapshot_lock",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 5000
        }, "sess_1");

        await Task.Delay(30);
        Assert.Equal(1, engine.ActiveActionCount);

        await engine.TriggerEmergencyStopAsync("Test", "Trigger cancellation");
        await cleanupReached.Task.WaitAsync(TimeSpan.FromSeconds(2));

        // Attempt drain with short timeout while action is in cleanup: must NOT disappear from snapshot!
        bool drained = await engine.DrainActiveTasksAsync(TimeSpan.FromMilliseconds(50));
        Assert.False(drained, "Action must be captured in snapshot under lock; drain must timeout, not return early.");
        Assert.Equal(1, engine.ActiveActionCount);

        cleanupGate.TrySetResult(true);
        await task;
        Assert.Equal(0, engine.ActiveActionCount);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 17: Drain begins after finalization and correctly returns immediately
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test17_DrainBeginsAfterFinalization_ReturnsTrueImmediately()
    {
        var (engine, _, _) = CreateTestEngine();

        var task = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_fast_finish",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 10
        }, "sess_1");

        var res = await task;
        Assert.True(res.Success);

        // Drain called after finalization must snapshot tasks under _stateLock and return true promptly
        var sw = Stopwatch.StartNew();
        bool drained = await engine.DrainActiveTasksAsync(TimeSpan.FromSeconds(2));
        sw.Stop();

        Assert.True(drained);
        Assert.True(sw.Elapsed.TotalMilliseconds < 50, $"Drain after finalization took {sw.Elapsed.TotalMilliseconds:F2}ms, expected < 50ms.");
        Assert.Equal(0, engine.ActiveActionCount);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 18: Concurrent Resume and finalization maintains strict invariants
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test18_ConcurrentResumeAndFinalization_MaintainsInvariants()
    {
        var (engine, _, _) = CreateTestEngine();

        for (int i = 0; i < 10; i++)
        {
            var task = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
            {
                ActionId = $"act_race_fin_{i}",
                ActionType = "SimulatedScroll",
                SimulatedDurationMs = 40
            }, "sess_1");

            await Task.Delay(10);

            var stopTask = engine.TriggerEmergencyStopAsync("Test", $"Race stop #{i}");
            var resumeTask = Task.Run(async () =>
            {
                await Task.Delay(5);
                return await engine.ResumeExecutionAsync("Test", $"Race resume #{i}", engine.CurrentStopGeneration, drainTimeout: TimeSpan.FromSeconds(2));
            });

            await Task.WhenAll(stopTask, resumeTask, task);

            // Invariant: After both complete, ActiveActionCount must be 0
            Assert.Equal(0, engine.ActiveActionCount);
        }

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 19: Stop/Resume generation transition during finalization
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test19_StopResumeGenerationTransitionDuringFinalization()
    {
        var (engine, _, _) = CreateTestEngine();

        var cleanupGate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var cleanupReached = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        engine.ActionLifecycleChanged += (sender, n) =>
        {
            if (n.ActionId == "act_gen_transition" && n.Reason == "Simulation cancelled")
            {
                cleanupReached.TrySetResult(true);
                cleanupGate.Task.GetAwaiter().GetResult();
            }
        };

        ulong initialGen = engine.CurrentStopGeneration;

        var task = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_gen_transition",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 5000
        }, "sess_1");

        await Task.Delay(30);

        // Emergency Stop increments epoch
        var stopResp = await engine.TriggerEmergencyStopAsync("Test", "Epoch increment stop");
        Assert.True(stopResp.StopGeneration > initialGen);
        await cleanupReached.Task.WaitAsync(TimeSpan.FromSeconds(2));

        // Release cleanup
        cleanupGate.TrySetResult(true);
        var res = await task;
        Assert.Equal("Cancelled", res.Status);

        // Resume execution in new epoch
        var resumeResp = await engine.ResumeExecutionAsync("Test", "Epoch resume", engine.CurrentStopGeneration, drainTimeout: TimeSpan.FromSeconds(2));
        Assert.True(resumeResp.Success);
        Assert.False(engine.IsEmergencyStopped);

        // Enqueue new action in new epoch: executes successfully
        var newTask = await engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_new_epoch",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 20
        }, "sess_1");

        Assert.True(newTask.Success);
        Assert.Equal("Completed", newTask.Status);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 20: Linked cancellation registrations disposed before completion signal
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test20_LinkedCtsDisposedBeforeCompletionSignalled()
    {
        var (engine, _, _) = CreateTestEngine();

        using var clientCts = new CancellationTokenSource();

        var task = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_linked_dispose",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 50
        }, "sess_1", clientCts.Token);

        var res = await task;
        Assert.True(res.Success);

        // When the action completed, linkedCts was explicitly disposed in finally
        // Client CTS should have 0 lingering registrations; cancelling it now must not throw or affect engine
        clientCts.Cancel();

        Assert.Equal(0, engine.ActiveActionCount);
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 21: Exception and cancellation cleanup preserve correct caller response
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test21_CancellationCleanup_PreservesCorrectCallerResponse()
    {
        var (engine, _, _) = CreateTestEngine();

        var task = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_clean_response",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 2000
        }, "sess_1");

        await Task.Delay(30);

        await engine.TriggerEmergencyStopAsync("Test", "Cancel for response check");
        var res = await task;

        // Invariants: Response must be Cancelled, Success false, ErrorMessage preserved
        Assert.False(res.Success);
        Assert.Equal("Cancelled", res.Status);
        Assert.Contains("cancelled", res.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, engine.ActiveActionCount);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 22: Duplicate Emergency Stop delivery is strictly idempotent
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test22_EmergencyStop_DuplicateDelivery_IsIdempotent()
    {
        var (engine, _, _) = CreateTestEngine();

        string fixedStopId = "stop_fixed_idempotent_01";

        // 1. Initial stop invocation
        var initialResp = await engine.TriggerEmergencyStopAsync("SourceA", "First delivery", fixedStopId);
        Assert.True(initialResp.Success);
        Assert.Equal(fixedStopId, initialResp.StopId);
        ulong initialGen = initialResp.StopGeneration;

        // 2. Concurrently deliver identical stopId multiple times (e.g. priority queue + reconnect handshake retry)
        int duplicateCount = 10;
        var duplicateTasks = Enumerable.Range(0, duplicateCount)
            .Select(i => engine.TriggerEmergencyStopAsync($"Source_{i}", $"Duplicate delivery #{i}", fixedStopId))
            .ToArray();

        var duplicateResults = await Task.WhenAll(duplicateTasks);

        // 3. Verify every invocation returned identical response and did NOT spuriously increment epoch
        foreach (var r in duplicateResults)
        {
            Assert.True(r.Success);
            Assert.Equal(fixedStopId, r.StopId);
            Assert.Equal(initialGen, r.StopGeneration);
        }

        Assert.Equal(initialGen, engine.CurrentStopGeneration);
        Assert.True(engine.IsEmergencyStopped);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 23: Handshake reconciles native stop when client connects reporting stopped
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test23_Handshake_ReconcilesNativeStop_WhenClientIsStopped()
    {
        var (engine, _, stateMgr) = CreateTestEngine();
        Assert.False(engine.IsEmergencyStopped);

        string pipeName = "test-pipe-" + Guid.NewGuid().ToString("N");
        using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);

        var connectTask = server.WaitForConnectionAsync();
        await client.ConnectAsync();
        await connectTask;

        var session = new IpcClientSession(server, stateMgr, NullLogger<IpcClientSession>.Instance, TestPeerVerifiers.AllowAll, executionEngine: engine);
        using var cts = new CancellationTokenSource();
        var sessionTask = Task.Run(() => session.RunSessionAsync(cts.Token));

        // Client performs handshake reporting IsEmergencyStopped = true from native latch
        string clientStopId = "stop_native_handshake_reconcile";
        var handshakeReq = new HandshakeRequest
        {
            ClientName = "NativeHud.Test",
            ProtocolVersion = IpcConstants.CurrentProtocolVersion,
            ClientProcessId = Environment.ProcessId,
            IsEmergencyStopped = true,
            StopId = clientStopId,
            StopReason = "Native stop latch was active at connect",
            StopGeneration = 1
        };

        var handshakeEnv = IpcEnvelope.Create(nameof(HandshakeRequest), handshakeReq);
        await client.WriteAsync(handshakeEnv.ToLengthPrefixedBytes());
        await client.FlushAsync();

        // Read HandshakeResponse
        var respEnv = await ReadEnvelopeAsync(client, cts.Token);
        Assert.NotNull(respEnv);
        Assert.Equal(nameof(HandshakeResponse), respEnv.Type);

        var handshakeResp = respEnv.DeserializePayload<HandshakeResponse>();
        Assert.NotNull(handshakeResp);
        Assert.Equal("Accepted", handshakeResp.Status);
        Assert.True(handshakeResp.IsEmergencyStopped, "Handshake response must confirm reconciled stopped status");

        // Verify daemon execution engine is now stopped
        Assert.True(engine.IsEmergencyStopped, "Daemon must reconcile to stopped immediately");

        // Verify actions are blocked
        var actionRes = await engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_blocked_reconciled",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 10
        }, "sess_test");
        Assert.False(actionRes.Success);
        Assert.Equal("Blocked", actionRes.Status);

        cts.Cancel();
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 24: Handshake communicates daemon stop when daemon is already stopped
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test24_Handshake_CommunicatesDaemonStop_WhenDaemonIsStopped()
    {
        var (engine, _, stateMgr) = CreateTestEngine();

        // Daemon is stopped prior to client connection
        var stopResp = await engine.TriggerEmergencyStopAsync("DaemonSelf", "Pre-existing stop");
        Assert.True(engine.IsEmergencyStopped);

        string pipeName = "test-pipe-" + Guid.NewGuid().ToString("N");
        using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);

        var connectTask = server.WaitForConnectionAsync();
        await client.ConnectAsync();
        await connectTask;

        var session = new IpcClientSession(server, stateMgr, NullLogger<IpcClientSession>.Instance, TestPeerVerifiers.AllowAll, executionEngine: engine);
        using var cts = new CancellationTokenSource();
        var sessionTask = Task.Run(() => session.RunSessionAsync(cts.Token));

        // Client connects with IsEmergencyStopped = false
        var handshakeReq = new HandshakeRequest
        {
            ClientName = "NativeHud.Test",
            ProtocolVersion = IpcConstants.CurrentProtocolVersion,
            ClientProcessId = Environment.ProcessId,
            IsEmergencyStopped = false
        };

        var handshakeEnv = IpcEnvelope.Create(nameof(HandshakeRequest), handshakeReq);
        await client.WriteAsync(handshakeEnv.ToLengthPrefixedBytes());
        await client.FlushAsync();

        var respEnv = await ReadEnvelopeAsync(client, cts.Token);
        Assert.NotNull(respEnv);
        var handshakeResp = respEnv.DeserializePayload<HandshakeResponse>();
        Assert.NotNull(handshakeResp);

        // Invariant: Handshake response informs client that daemon is stopped, preventing implicit resume
        Assert.True(handshakeResp.IsEmergencyStopped);
        Assert.Equal(stopResp.StopGeneration, handshakeResp.StopGeneration);

        cts.Cancel();
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 25: Resume cannot succeed while drain is blocked; stop remains latched
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test25_ResumeCannotSucceed_WhileDrainBlocked_PreservesStop()
    {
        var (engine, _, _) = CreateTestEngine();

        var cleanupHold = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var cleanupReached = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        engine.ActionLifecycleChanged += (s, n) =>
        {
            if (n.ActionId == "act_block_resume_drain" && n.Reason == "Simulation cancelled")
            {
                cleanupReached.TrySetResult(true);
                cleanupHold.Task.GetAwaiter().GetResult();
            }
        };

        var act = engine.ExecuteSimulatedActionAsync(new SimulatedActionRequest
        {
            ActionId = "act_block_resume_drain",
            ActionType = "SimulatedScroll",
            SimulatedDurationMs = 5000
        }, "sess_hold");

        await Task.Delay(30);
        Assert.Equal(1, engine.ActiveActionCount);

        await engine.TriggerEmergencyStopAsync("Test", "Stop while action active");
        await cleanupReached.Task.WaitAsync(TimeSpan.FromSeconds(2));

        // Attempt resume while worker is held in cleanup
        var resumeResp = await engine.ResumeExecutionAsync("Test", "Attempt resume", engine.CurrentStopGeneration, drainTimeout: TimeSpan.FromMilliseconds(50));
        Assert.False(resumeResp.Success);
        Assert.True(engine.IsEmergencyStopped, "System must remain stopped");

        // Release hold gate
        cleanupHold.TrySetResult(true);
        await act;

        // Clean up
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 26: Bounded Stop Deduplication Cache safely caps memory and evicts LRU
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public void Test26_DeduplicationCache_ReachesCapacity_AndSafelyEvicts()
    {
        var cache = new BoundedStopCache(capacity: 32);
        Assert.Equal(32, cache.Capacity);
        Assert.Equal(0, cache.Count);

        // 1. Insert 32 items
        for (int i = 0; i < 32; i++)
        {
            cache.AddOrUpdate($"stop_{i}", new EmergencyStopResponse
            {
                StopId = $"stop_{i}",
                Success = true,
                StopGeneration = (ulong)(i + 1)
            });
        }
        Assert.Equal(32, cache.Count);

        // 2. Insert 10 more items -> must evict the first 10 items (stop_0 to stop_9)
        for (int i = 32; i < 42; i++)
        {
            cache.AddOrUpdate($"stop_{i}", new EmergencyStopResponse
            {
                StopId = $"stop_{i}",
                Success = true,
                StopGeneration = (ulong)(i + 1)
            });
        }

        // Capacity strictly capped at 32
        Assert.Equal(32, cache.Count);

        // Evicted entries return false
        for (int i = 0; i < 10; i++)
        {
            Assert.False(cache.TryGet($"stop_{i}", out _), $"stop_{i} should have been evicted");
        }

        // Retained entries return true
        for (int i = 10; i < 42; i++)
        {
            Assert.True(cache.TryGet($"stop_{i}", out var resp), $"stop_{i} should be retained");
            Assert.Equal($"stop_{i}", resp?.StopId);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 27: Resume rejects stale or mismatched generation
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test27_Resume_RejectsGenerationMismatch()
    {
        var (engine, _, _) = CreateTestEngine();

        // 1. Trigger stop -> generation 2
        var stopResp = await engine.TriggerEmergencyStopAsync("Test", "Stop", sessionId: "sess_test");
        Assert.True(stopResp.Success);
        Assert.Equal((ulong)2, stopResp.StopGeneration);

        // 2. Client sends ResumeExecutionRequest with stale expected generation (1)
        var resumeResp = await engine.ResumeExecutionAsync(
            source: "TestClient",
            reason: "Resume attempt with stale generation",
            resumeId: "res_stale",
            sessionId: "sess_test",
            stopGeneration: 1);

        // Must reject fail-closed
        Assert.False(resumeResp.Success);
        Assert.Equal("sess_test", resumeResp.SessionId);
        Assert.Equal((ulong)2, resumeResp.StopGeneration);
        Assert.Contains("Generation mismatch", resumeResp.ErrorMessage);
        Assert.True(engine.IsEmergencyStopped, "Engine must remain stopped");

        // 3. Client sends ResumeExecutionRequest with matching generation (2)
        var validResume = await engine.ResumeExecutionAsync(
            source: "TestClient",
            reason: "Resume with matching generation",
            resumeId: "res_valid",
            sessionId: "sess_test",
            stopGeneration: 2);

        Assert.True(validResume.Success);
        Assert.Equal("sess_test", validResume.SessionId);
        Assert.Equal((ulong)2, validResume.StopGeneration);
        Assert.False(engine.IsEmergencyStopped, "Engine should now be resumed");

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 28: Repeated Stop while already stopped preserves active epoch
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test28_RepeatedStop_WhileAlreadyStopped_PreservesActiveGeneration()
    {
        var (engine, _, _) = CreateTestEngine();

        // Initial stop advances generation from 1 to 2
        var stop1 = await engine.TriggerEmergencyStopAsync("Test", "Initial stop", "stop_init");
        Assert.True(stop1.Success);
        Assert.Equal((ulong)2, stop1.StopGeneration);
        Assert.Equal((ulong)2, engine.CurrentStopGeneration);

        // 5 subsequent stops while already stopped must NOT increment generation
        for (int i = 0; i < 5; i++)
        {
            var stopSubsequent = await engine.TriggerEmergencyStopAsync("Test", $"Repeated stop {i}", $"stop_rep_{i}");
            Assert.True(stopSubsequent.Success);
            Assert.Equal((ulong)2, stopSubsequent.StopGeneration);
            Assert.Equal((ulong)2, engine.CurrentStopGeneration);
        }

        Assert.True(engine.IsEmergencyStopped);
        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 29: Resume binds session token and generation on response
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test29_Resume_BindsSessionAndGeneration_OnResponse()
    {
        var (engine, _, _) = CreateTestEngine();

        await engine.TriggerEmergencyStopAsync("Test", "Stop", sessionId: "session_xyz");
        Assert.True(engine.IsEmergencyStopped);

        var resp = await engine.ResumeExecutionAsync(
            source: "FrontendButton",
            reason: "User confirmed",
            resumeId: "res_bind_test",
            sessionId: "session_xyz",
            stopGeneration: 2);

        Assert.True(resp.Success);
        Assert.Equal("res_bind_test", resp.ResumeId);
        Assert.Equal("session_xyz", resp.SessionId);
        Assert.Equal((ulong)2, resp.StopGeneration);

        engine.Dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 30: End-to-end replay of an evicted Stop ID against ActionExecutionEngine
    // ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public async Task Test30_Replay_EvictedStopId_TriggersNewStopEpoch_AndPreventsStaleResume()
    {
        var (engine, _, _) = CreateTestEngine();

        // 1. Initial stop with specific stop ID -> Generation 2
        var initialStop = await engine.TriggerEmergencyStopAsync(
            source: "TestClient",
            reason: "Initial stop",
            stopId: "stop_evict_target",
            sessionId: "sess_1");
        Assert.True(initialStop.Success);
        Assert.Equal((ulong)2, initialStop.StopGeneration);
        Assert.True(engine.IsEmergencyStopped);

        // 2. Resume execution back to running state
        var initialResume = await engine.ResumeExecutionAsync(
            source: "TestClient",
            reason: "Resume to running",
            resumeId: "res_init",
            sessionId: "sess_1",
            stopGeneration: 2);
        Assert.True(initialResume.Success);
        Assert.False(engine.IsEmergencyStopped);

        // 3. Evict "stop_evict_target" from the 256-capacity BoundedStopCache
        // By processing 300 distinct stop requests through TriggerEmergencyStopAsync
        for (int i = 0; i < 300; i++)
        {
            await engine.TriggerEmergencyStopAsync(
                source: "SpamSource",
                reason: $"Filler stop {i}",
                stopId: $"filler_stop_{i}",
                sessionId: "sess_1");

            var res = await engine.ResumeExecutionAsync(
                source: "SpamSource",
                reason: "Resume filler",
                sessionId: "sess_1",
                stopGeneration: engine.CurrentStopGeneration);
            Assert.True(res.Success);
        }

        Assert.False(engine.IsEmergencyStopped);
        ulong genBeforeReplay = engine.CurrentStopGeneration;
        Assert.True(genBeforeReplay > 300, $"Expected generation > 300 but was {genBeforeReplay}");

        // Verify "stop_evict_target" is no longer in cache
        Assert.False(engine.ProcessedStopsCache.TryGet("stop_evict_target", out _));

        // 4. Adversary replays the original "stop_evict_target"
        var replayStop = await engine.TriggerEmergencyStopAsync(
            source: "AttackerReplay",
            reason: "Replaying old evicted stop",
            stopId: "stop_evict_target",
            sessionId: "sess_1");

        // Must succeed in stopping the engine, but in a NEW, higher generation!
        Assert.True(replayStop.Success);
        Assert.True(engine.IsEmergencyStopped, "Engine must be stopped by replayed stop");
        Assert.Equal(genBeforeReplay + 1, replayStop.StopGeneration);
        Assert.True(replayStop.StopGeneration > 300);
        // It must NEVER regress to generation 2
        Assert.NotEqual((ulong)2, replayStop.StopGeneration);

        // 5. An old resume request from generation 2 CANNOT resume this new epoch
        var staleResume = await engine.ResumeExecutionAsync(
            source: "AttackerResume",
            reason: "Attempt resume with epoch 2 token",
            resumeId: "res_stale_epoch2",
            sessionId: "sess_1",
            stopGeneration: 2);
        Assert.False(staleResume.Success);
        Assert.Contains("Generation mismatch", staleResume.ErrorMessage);
        Assert.True(engine.IsEmergencyStopped, "Engine must remain stopped");

        // 6. Only a resume with the new matching generation can resume
        var validResume = await engine.ResumeExecutionAsync(
            source: "ValidClient",
            reason: "Resume new epoch",
            resumeId: "res_valid_epoch",
            sessionId: "sess_1",
            stopGeneration: replayStop.StopGeneration);
        Assert.True(validResume.Success);
        Assert.False(engine.IsEmergencyStopped);

        engine.Dispose();
    }

    private static async Task<IpcEnvelope?> ReadEnvelopeAsync(PipeStream stream, CancellationToken ct = default)
    {
        byte[] header = new byte[4];
        int read = await stream.ReadAsync(header.AsMemory(0, 4), ct);
        if (read < 4) return null;
        uint len = BitConverter.ToUInt32(header, 0);
        byte[] payload = new byte[len];
        int total = 0;
        while (total < len)
        {
            int r = await stream.ReadAsync(payload.AsMemory(total, (int)len - total), ct);
            if (r == 0) return null;
            total += r;
        }
        return IpcEnvelope.FromJsonBytes(payload);
    }
}
