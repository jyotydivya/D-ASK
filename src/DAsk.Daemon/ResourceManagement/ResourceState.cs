namespace DAsk.Daemon.ResourceManagement;

public enum ResourceSeverity
{
    Normal,
    Warning,
    Critical,
    Degraded
}

public enum SubsystemType
{
    NativeHud,
    DaemonCore,
    VectorDb,
    LlmInference,
    SpeechEngine,
    VisionEngine,
    AdbBridge
}

public record SubsystemAllocationRecord
{
    public SubsystemType Subsystem { get; init; }
    public string Name { get; init; } = string.Empty;
    public ulong AllocatedBytes { get; set; }
    public ulong PeakBytes { get; set; }
    public DateTimeOffset LastUpdated { get; set; } = DateTimeOffset.UtcNow;
}

public record ModelAllocationCheckResult
{
    public bool IsAllowed { get; init; }
    public string Reason { get; init; } = string.Empty;
    public ulong RequiredMemoryBytes { get; init; }
    public ulong AvailablePhysicalMemoryBytes { get; init; }
    public ulong MinimumHeadroomBytes { get; init; }
    public bool FallbackToCpuRecommended { get; init; }
    public MemoryReservationLease? Lease { get; init; }
}

public class MemoryReservationLease : IDisposable
{
    private readonly Action<MemoryReservationLease>? _onDispose;
    private int _disposed = 0;

    public string LeaseId { get; } = Guid.NewGuid().ToString("N");
    public string ModelName { get; }
    public ulong ReservedBytes { get; }
    public DateTimeOffset AcquiredAt { get; } = DateTimeOffset.UtcNow;

    public MemoryReservationLease(string modelName, ulong reservedBytes, Action<MemoryReservationLease>? onDispose = null)
    {
        ModelName = modelName;
        ReservedBytes = reservedBytes;
        _onDispose = onDispose;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _onDispose?.Invoke(this);
        }
    }
}

