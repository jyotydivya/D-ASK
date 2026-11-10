# Issue: Emergency Stop can undercount active actions (intermittent test failures)

**Status:** fixed in Phase 6 (2026-11-05). The active actions are now snapshotted under the lock before the shared token is cancelled. The existing assertions are unchanged. Before the fix, at least one of the two tests failed in 7 of 8 runs; after it, 20 of 20 runs pass, along with a new regression test that fails on the old engine. The text below is the original report.
**Affected tests:** `SafetyInfrastructureTests.Scenario01_Active_Action_Cancelled_Immediately_On_Emergency_Stop` and `ExecutionEngineCorrectnessTests.Test06_EmergencyStop_CancelsQueuedWork`. Both assert `ActiveActionsCancelled == 1` and intermittently see 0.

## Evidence that Phase 5 did not cause it (measured)
Phase 5's only engine change is two null-checked event calls. In a scratch copy of the code with those calls removed, the two tests behaved the same when run together in isolation, with at least one failure in 8 of 8 runs (with the calls: also 8 of 8).

## Likely cause (from reading the code, not proven by a dedicated test)
In `ActionExecutionEngine.TriggerEmergencyStopAsync`, `_emergencyStopCts.Cancel()` fires inside the lock, before the loop that counts `_activeActions`. An action linked to that token can finish cancelling and remove itself before the loop reaches it, so the reported count is too low.

If that's right, the action is still cancelled and only the *reported number* is wrong. The test stops at the count assertion, so its later assertions (that the action really was cancelled) don't run in the failing case and don't confirm this.

## Suggested fix (separate change)
Take the count, or a snapshot of `_activeActions`, before cancelling the shared token. Keep the existing assertions; they describe the right behaviour.
