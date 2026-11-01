using System.Collections.Concurrent;
using DAsk.Daemon.Configuration;
using DAsk.Daemon.Telemetry;
using DAsk.Protocol.IPC.Messages;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace DAsk.Daemon.ResourceManagement;

public class ResourceManager : IResourceManager
{
    private readonly ILogger<ResourceManager> _logger;
    private readonly ISystemMonitor _systemMonitor;
    private readonly ResourceManagerOptions _options;
    private readonly ConcurrentDictionary<string, SubsystemAllocationRecord> _allocations = new();
    private readonly ConcurrentDictionary<string, MemoryReservationLease> _activeReservations = new();
    private readonly SemaphoreSlim _reservationLock = new(1, 1);

    private ResourceSeverity _currentSeverity = ResourceSeverity.Normal;
    private bool _isDegradedMode = false;

    public ResourceSeverity CurrentSeverity => _currentSeverity;
    public bool IsDegradedMode => _isDegradedMode;
    public ulong TotalActiveReservationsBytes => (ulong)_activeReservations.Values.Sum(r => (long)r.ReservedBytes);

    public event EventHandler<ResourceAlert>? ResourceAlertTriggered;

    public ResourceManager(
        ILogger<ResourceManager> logger,
        ISystemMonitor systemMonitor,
        IOptions<ResourceManagerOptions> options)
    {
        _logger = logger;
        _systemMonitor = systemMonitor;
        _options = options.Value;
    }

    public async Task<ResourceSeverity> EvaluateCurrentResourcesAsync(CancellationToken cancellationToken = default)
    {
        var ram = await _systemMonitor.GetRamMetricsAsync(cancellationToken);
        var cpu = await _systemMonitor.GetCpuMetricsAsync(cancellationToken);

        ulong availMB = ram.AvailableBytes / (1024 * 1024);
        ResourceSeverity newSeverity;

        if (availMB < _options.CriticalAvailableMemoryMB)
        {
            newSeverity = ResourceSeverity.Critical;
        }
        else if (availMB < _options.WarningAvailableMemoryMB)
        {
            newSeverity = ResourceSeverity.Warning;
        }
        else
        {
            newSeverity = ResourceSeverity.Normal;
        }

        // Check CPU throttle
        if (cpu.TotalUsagePercent > _options.CpuThrottleThresholdPercent && newSeverity == ResourceSeverity.Normal)
        {
            newSeverity = ResourceSeverity.Warning;
        }

        if (newSeverity != _currentSeverity)
        {
            _logger.LogWarning("Resource state changed from {OldState} to {NewState}. Available RAM: {AvailMB} MB, CPU: {Cpu}%",
                _currentSeverity, newSeverity, availMB, cpu.TotalUsagePercent);

            _currentSeverity = newSeverity;
            _isDegradedMode = (_currentSeverity == ResourceSeverity.Critical);

            var alert = new ResourceAlert
            {
                Severity = newSeverity.ToString(),
                Reason = newSeverity == ResourceSeverity.Critical 
                    ? $"Physical RAM is critically low ({availMB} MB available, threshold is {_options.CriticalAvailableMemoryMB} MB)."
                    : $"Physical RAM is running low ({availMB} MB available, threshold is {_options.WarningAvailableMemoryMB} MB).",
                AvailableMemoryBytes = ram.AvailableBytes,
                ThresholdBytes = (newSeverity == ResourceSeverity.Critical 
                    ? _options.CriticalAvailableMemoryMB 
                    : _options.WarningAvailableMemoryMB) * 1024 * 1024,
                ActionTaken = _isDegradedMode ? "DegradedMode" : "None",
                IsBlockedFromModelLoad = (_currentSeverity == ResourceSeverity.Critical),
                Timestamp = DateTimeOffset.UtcNow
            };

            ResourceAlertTriggered?.Invoke(this, alert);
        }

        return _currentSeverity;
    }

    public async Task<ModelAllocationCheckResult> CanAllocateModelAsync(
        string modelName, 
        ulong estimatedSizeBytes, 
        CancellationToken cancellationToken = default)
    {
        var ram = await _systemMonitor.GetRamMetricsAsync(cancellationToken);
        ulong totalAvailBytes = ram.AvailableBytes;
        ulong activeReservations = TotalActiveReservationsBytes;
        ulong effectiveAvailBytes = totalAvailBytes > activeReservations ? totalAvailBytes - activeReservations : 0;
        ulong minHeadroomBytes = _options.MinModelLoadHeadroomMB * 1024 * 1024;

        _logger.LogInformation("Evaluating model allocation: '{ModelName}', Required: {ReqMB} MB, Available: {AvailMB} MB, ActiveReservations: {ResMB} MB, Min Headroom: {HeadroomMB} MB",
            modelName, estimatedSizeBytes / (1024 * 1024), effectiveAvailBytes / (1024 * 1024), activeReservations / (1024 * 1024), _options.MinModelLoadHeadroomMB);

        if (effectiveAvailBytes < estimatedSizeBytes + minHeadroomBytes)
        {
            ulong projectedHeadroomBytes = effectiveAvailBytes > estimatedSizeBytes ? effectiveAvailBytes - estimatedSizeBytes : 0;
            string reason = $"Insufficient physical RAM to load '{modelName}'. Effective Available (less reservations): {effectiveAvailBytes / (1024 * 1024)} MB, Required: {estimatedSizeBytes / (1024 * 1024)} MB. Projected headroom ({projectedHeadroomBytes / (1024 * 1024)} MB) would breach the minimum safety threshold of {_options.MinModelLoadHeadroomMB} MB.";

            _logger.LogWarning("Model allocation BLOCKED: {Reason}", reason);

            return new ModelAllocationCheckResult
            {
                IsAllowed = false,
                Reason = reason,
                RequiredMemoryBytes = estimatedSizeBytes,
                AvailablePhysicalMemoryBytes = effectiveAvailBytes,
                MinimumHeadroomBytes = minHeadroomBytes,
                FallbackToCpuRecommended = false,
                Lease = null
            };
        }

        return new ModelAllocationCheckResult
        {
            IsAllowed = true,
            Reason = "Sufficient physical memory available.",
            RequiredMemoryBytes = estimatedSizeBytes,
            AvailablePhysicalMemoryBytes = effectiveAvailBytes,
            MinimumHeadroomBytes = minHeadroomBytes,
            FallbackToCpuRecommended = false,
            Lease = null
        };
    }

    public async Task<ModelAllocationCheckResult> TryAcquireReservationAsync(
        string modelName,
        ulong estimatedSizeBytes,
        CancellationToken cancellationToken = default)
    {
        await _reservationLock.WaitAsync(cancellationToken);
        try
        {
            var checkResult = await CanAllocateModelAsync(modelName, estimatedSizeBytes, cancellationToken);
            if (!checkResult.IsAllowed)
            {
                return checkResult;
            }

            var lease = new MemoryReservationLease(modelName, estimatedSizeBytes, ReleaseReservation);
            _activeReservations.TryAdd(lease.LeaseId, lease);

            _logger.LogInformation("Memory reservation lease ACQUIRED: LeaseId='{LeaseId}', Model='{Model}', Size={SizeMB} MB. Total Active Reservations: {TotalMB} MB",
                lease.LeaseId, modelName, estimatedSizeBytes / (1024 * 1024), TotalActiveReservationsBytes / (1024 * 1024));

            return checkResult with { Lease = lease };
        }
        finally
        {
            _reservationLock.Release();
        }
    }

    public void ReleaseReservation(MemoryReservationLease lease)
    {
        if (_activeReservations.TryRemove(lease.LeaseId, out _))
        {
            _logger.LogInformation("Memory reservation lease RELEASED: LeaseId='{LeaseId}', Model='{Model}', Size={SizeMB} MB. Remaining Active Reservations: {RemainingMB} MB",
                lease.LeaseId, lease.ModelName, lease.ReservedBytes / (1024 * 1024), TotalActiveReservationsBytes / (1024 * 1024));
        }
    }

    public void RegisterSubsystemAllocation(SubsystemType subsystem, string name, ulong bytes)
    {
        string key = $"{subsystem}:{name}";
        _allocations.AddOrUpdate(key,
            _ => new SubsystemAllocationRecord
            {
                Subsystem = subsystem,
                Name = name,
                AllocatedBytes = bytes,
                PeakBytes = bytes,
                LastUpdated = DateTimeOffset.UtcNow
            },
            (_, existing) =>
            {
                existing.AllocatedBytes = bytes;
                if (bytes > existing.PeakBytes) existing.PeakBytes = bytes;
                existing.LastUpdated = DateTimeOffset.UtcNow;
                return existing;
            });

        _logger.LogDebug("Subsystem allocation updated: {Subsystem}:{Name} = {BytesMB} MB",
            subsystem, name, bytes / (1024 * 1024));
    }

    public void UnregisterSubsystemAllocation(SubsystemType subsystem, string name)
    {
        string key = $"{subsystem}:{name}";
        _allocations.TryRemove(key, out _);
        _logger.LogDebug("Subsystem allocation unregistered: {Subsystem}:{Name}", subsystem, name);
    }

    public IReadOnlyList<SubsystemAllocationRecord> GetSubsystemAllocations()
    {
        return _allocations.Values.ToList();
    }
}

