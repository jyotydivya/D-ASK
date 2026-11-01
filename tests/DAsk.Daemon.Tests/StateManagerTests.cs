using DAsk.Daemon.State;
using DAsk.Protocol.IPC.Messages;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

public class StateManagerTests
{
    [Fact]
    public void SetStatus_IncrementsSequenceNumber_And_FiresEvent()
    {
        var manager = new StateManager(NullLogger<StateManager>.Instance);
        long initialSeq = manager.CurrentSequenceNumber;

        StateUpdate? capturedUpdate = null;
        manager.StateChanged += (_, update) => capturedUpdate = update;

        manager.SetStatus("Listening", "Pulse");

        Assert.Equal("Listening", manager.ActiveStatus);
        Assert.Equal("Pulse", manager.OrbMode);
        Assert.True(manager.CurrentSequenceNumber > initialSeq);

        Assert.NotNull(capturedUpdate);
        Assert.Equal("Listening", capturedUpdate.ActiveStatus);
        Assert.Equal("Pulse", capturedUpdate.OrbMode);
        Assert.Equal(manager.CurrentSequenceNumber, capturedUpdate.SequenceNumber);
    }

    [Fact]
    public void TaskManagement_AddsUpdatesAndRemovesTasks_Correctly()
    {
        var manager = new StateManager(NullLogger<StateManager>.Instance);

        manager.AddOrUpdateTask("task-1", "Inspect Memory", "InProgress");
        var snapshot1 = manager.CreateStateSnapshot();

        Assert.Single(snapshot1.ActiveTasks);
        Assert.Equal("task-1", snapshot1.ActiveTasks[0].TaskId);
        Assert.Equal("InProgress", snapshot1.ActiveTasks[0].Status);

        manager.AddOrUpdateTask("task-1", "Inspect Memory", "Completed");
        var snapshot2 = manager.CreateStateSnapshot();
        Assert.Single(snapshot2.ActiveTasks);
        Assert.Equal("Completed", snapshot2.ActiveTasks[0].Status);

        manager.RemoveTask("task-1");
        var snapshot3 = manager.CreateStateSnapshot();
        Assert.Empty(snapshot3.ActiveTasks);
    }

    [Fact]
    public void RestoreClientState_Returns_CurrentSnapshot()
    {
        var manager = new StateManager(NullLogger<StateManager>.Instance);
        manager.SetStatus("Processing", "Alert");
        manager.AddOrUpdateTask("task-restore", "Live Telemetry", "Active");

        var request = new StateRestoreRequest
        {
            LastKnownSeq = 0,
            ClientStatus = "Reconnecting"
        };

        bool ok = manager.RestoreClientState(request, out var response);

        Assert.True(ok);
        Assert.True(response.RestoredSuccessfully);
        Assert.Equal("Processing", response.ActiveStatus);
        Assert.Equal("Alert", response.OrbMode);
        Assert.Single(response.ActiveTasks);
        Assert.Equal("task-restore", response.ActiveTasks[0].TaskId);
    }
}

