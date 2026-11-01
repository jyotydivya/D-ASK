using DAsk.Protocol.IPC.Messages;

namespace DAsk.Daemon.State;

public interface IStateManager
{
    string ActiveStatus { get; }
    string OrbMode { get; }
    long CurrentSequenceNumber { get; }

    void SetStatus(string status, string? orbMode = null);
    void AddOrUpdateTask(string taskId, string title, string status);
    void RemoveTask(string taskId);
    StateRestoreResponse CreateStateSnapshot();
    bool RestoreClientState(StateRestoreRequest request, out StateRestoreResponse response);

    event EventHandler<StateUpdate>? StateChanged;
}

