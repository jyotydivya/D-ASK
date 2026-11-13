namespace DAsk.Daemon.Research;

/// <summary>
/// Result of <see cref="SqliteEvidenceRecorder.VerifyAuditChainAsync"/>. On failure, <see cref="FirstBadSeq"/> and
/// <see cref="Problem"/> say where and why; events before that point verified. Corruption is reported, never repaired:
/// later events keep linking to the last stored hash, so a break stays visible.
/// </summary>
public sealed record AuditChainVerification(
    bool Ok,
    long VerifiedEvents,
    long? FirstBadSeq,
    string? Problem,
    long UnchainedRows,
    string? HeadHash)
{
    public static AuditChainVerification Fail(long verified, long seq, string problem) =>
        new(false, verified, seq, problem, 0, null);
}
