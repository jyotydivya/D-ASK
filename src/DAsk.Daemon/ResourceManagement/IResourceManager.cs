using DAsk.Protocol.IPC.Messages;

namespace DAsk.Daemon.ResourceManagement;

public interface IResourceManager
{
    ResourceSeverity CurrentSeverity { get; }
    bool IsDegradedMode { get; }
    ulong TotalActiveReservationsBytes { get; }

    Task<ResourceSeverity> EvaluateCurrentResourcesAsync(CancellationToken cancellationToken = default);

    Task<ModelAllocationCheckResult> CanAllocateModelAsync(
        string modelName, 
        ulong estimatedSizeBytes, 
        CancellationToken cancellationToken = default);

    Task<ModelAllocationCheckResult> TryAcquireReservationAsync(
        string modelName,
        ulong estimatedSizeBytes,
        CancellationToken cancellationToken = default);

    void ReleaseReservation(MemoryReservationLease lease);

    void RegisterSubsystemAllocation(SubsystemType subsystem, string name, ulong bytes);
    void UnregisterSubsystemAllocation(SubsystemType subsystem, string name);
    IReadOnlyList<SubsystemAllocationRecord> GetSubsystemAllocations();

    event EventHandler<ResourceAlert>? ResourceAlertTriggered;
}

