using System.Collections.Concurrent;
using DAsk.Protocol.IPC.Messages;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.State;

public class StateManager : IStateManager
{
    private readonly ILogger<StateManager> _logger;
    private readonly ConcurrentDictionary<string, TaskStateDto> _tasks = new();
    private readonly object _stateLock = new();

    private string _activeStatus = "Idle";
    private string _orbMode = "Normal";
    private long _sequenceNumber = 0;

    public string ActiveStatus
    {
        get { lock (_stateLock) return _activeStatus; }
    }

    public string OrbMode
    {
        get { lock (_stateLock) return _orbMode; }
    }

    public long CurrentSequenceNumber
    {
        get { lock (_stateLock) return _sequenceNumber; }
    }

    public event EventHandler<StateUpdate>? StateChanged;

    public StateManager(ILogger<StateManager> logger)
    {
        _logger = logger;
    }

    public void SetStatus(string status, string? orbMode = null)
    {
        StateUpdate update;
        lock (_stateLock)
        {
            _activeStatus = status;
            if (orbMode != null)
            {
                _orbMode = orbMode;
            }
            _sequenceNumber++;

            update = new StateUpdate
            {
                ActiveStatus = _activeStatus,
                OrbMode = _orbMode,
                SequenceNumber = _sequenceNumber
            };
        }

        _logger.LogInformation("Daemon status updated to '{Status}', OrbMode: '{OrbMode}', Seq: {Seq}",
            update.ActiveStatus, update.OrbMode, update.SequenceNumber);

        StateChanged?.Invoke(this, update);
    }

    public void AddOrUpdateTask(string taskId, string title, string status)
    {
        long seq;
        lock (_stateLock)
        {
            _sequenceNumber++;
            seq = _sequenceNumber;
        }

        var task = new TaskStateDto
        {
            TaskId = taskId,
            Title = title,
            Status = status,
            CreatedAt = DateTimeOffset.UtcNow
        };

        _tasks.AddOrUpdate(taskId, task, (_, _) => task);

        _logger.LogInformation("Task updated: [{TaskId}] {Title} -> {Status} (Seq: {Seq})", taskId, title, status, seq);

        StateChanged?.Invoke(this, new StateUpdate
        {
            ActiveStatus = ActiveStatus,
            OrbMode = OrbMode,
            TaskId = taskId,
            TaskSummary = $"{title} ({status})",
            SequenceNumber = seq
        });
    }

    public void RemoveTask(string taskId)
    {
        if (_tasks.TryRemove(taskId, out _))
        {
            long seq;
            lock (_stateLock)
            {
                _sequenceNumber++;
                seq = _sequenceNumber;
            }

            _logger.LogInformation("Task removed: [{TaskId}] (Seq: {Seq})", taskId, seq);

            StateChanged?.Invoke(this, new StateUpdate
            {
                ActiveStatus = ActiveStatus,
                OrbMode = OrbMode,
                TaskId = taskId,
                TaskSummary = "Removed",
                SequenceNumber = seq
            });
        }
    }

    public StateRestoreResponse CreateStateSnapshot()
    {
        lock (_stateLock)
        {
            return new StateRestoreResponse
            {
                ActiveStatus = _activeStatus,
                OrbMode = _orbMode,
                ActiveTasks = _tasks.Values.ToList(),
                SequenceNumber = _sequenceNumber,
                RestoredSuccessfully = true
            };
        }
    }

    public bool RestoreClientState(StateRestoreRequest request, out StateRestoreResponse response)
    {
        _logger.LogInformation("Client requested state restoration. Client last sequence: {ClientSeq}", request.LastKnownSeq);

        response = CreateStateSnapshot();
        return true;
    }
}

