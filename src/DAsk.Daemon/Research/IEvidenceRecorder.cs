namespace DAsk.Daemon.Research;

public interface IEvidenceRecorder
{
    Task InitializeAsync(CancellationToken cancellationToken = default);
    Task RecordEvidenceAsync(ExecutionEvidenceRecord record, CancellationToken cancellationToken = default);
    Task<ExecutionEvidenceRecord?> GetEvidenceByIdAsync(string recordId, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<ExecutionEvidenceRecord>> GetEvidenceByTaskIdAsync(string taskId, CancellationToken cancellationToken = default);

    Task RecordSafetyAuditAsync(SafetyAuditRecord record, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<SafetyAuditRecord>> GetSafetyAuditRecordsAsync(int limit = 100, CancellationToken cancellationToken = default);
}
