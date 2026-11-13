using DAsk.Daemon.Configuration;
using DAsk.Daemon.ResourceManagement;
using DAsk.Daemon.Telemetry;
using DAsk.Protocol.IPC.Messages;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace DAsk.Daemon.Tests;

public class ResourceManagerTests
{
    private class FakeSystemMonitor : ISystemMonitor
    {
        public ulong AvailableRamBytes { get; set; } = 8UL * 1024 * 1024 * 1024; // 8 GB
        public ulong TotalRamBytes { get; set; } = 16UL * 1024 * 1024 * 1024;
        public double CpuTotalPercent { get; set; } = 10.0;

        public Task<SystemRamMetrics> GetRamMetricsAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new SystemRamMetrics
            {
                TotalBytes = TotalRamBytes,
                AvailableBytes = AvailableRamBytes,
                UsedBytes = TotalRamBytes - AvailableRamBytes,
                LoadPercentage = ((double)(TotalRamBytes - AvailableRamBytes) / TotalRamBytes) * 100.0
            });
        }

        public Task<CpuMetrics> GetCpuMetricsAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new CpuMetrics
            {
                TotalUsagePercent = CpuTotalPercent,
                ProcessUsagePercent = 1.0
            });
        }

        public Task<GpuMetrics> GetGpuMetricsAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new GpuMetrics
            {
                AdapterName = "Intel(R) Iris(R) Xe Graphics",
                DedicatedVideoMemoryBytes = 128 * 1024 * 1024,
                SharedSystemMemoryBytes = 8UL * 1024 * 1024 * 1024,
                CurrentUsageBytes = 200 * 1024 * 1024,
                BudgetBytes = 7UL * 1024 * 1024 * 1024,
                IsSharedMemoryArchitecture = true
            });
        }

        public ProcessMemoryMetrics GetProcessMemoryMetrics()
        {
            return new ProcessMemoryMetrics
            {
                WorkingSetBytes = 35 * 1024 * 1024,
                PrivateBytes = 25 * 1024 * 1024
            };
        }

        public async Task<TelemetryUpdate> CaptureCompleteTelemetryAsync(string resourceStatus, CancellationToken cancellationToken = default)
        {
            var ram = await GetRamMetricsAsync(cancellationToken);
            var cpu = await GetCpuMetricsAsync(cancellationToken);
            var gpu = await GetGpuMetricsAsync(cancellationToken);
            return new TelemetryUpdate
            {
                SystemRam = ram,
                Cpu = cpu,
                Gpu = gpu,
                ProcessMemory = GetProcessMemoryMetrics(),
                ResourceStatus = resourceStatus,
                Timestamp = DateTimeOffset.UtcNow
            };
        }
    }

    [Fact]
    public async Task EvaluateResources_Transitions_Normal_To_Warning_To_Critical()
    {
        var fakeMonitor = new FakeSystemMonitor();
        var options = Options.Create(new ResourceManagerOptions
        {
            WarningAvailableMemoryMB = 2500,
            CriticalAvailableMemoryMB = 1800,
            CpuThrottleThresholdPercent = 85.0,
            MinModelLoadHeadroomMB = 2000
        });

        var manager = new ResourceManager(NullLogger<ResourceManager>.Instance, fakeMonitor, options);

        // 1. Initial State with 8 GB free -> Normal
        fakeMonitor.AvailableRamBytes = 8UL * 1024 * 1024 * 1024;
        var s1 = await manager.EvaluateCurrentResourcesAsync();
        Assert.Equal(ResourceSeverity.Normal, s1);
        Assert.False(manager.IsDegradedMode);

        // 2. Drop to 2200 MB free -> Warning
        fakeMonitor.AvailableRamBytes = 2200UL * 1024 * 1024;
        var s2 = await manager.EvaluateCurrentResourcesAsync();
        Assert.Equal(ResourceSeverity.Warning, s2);
        Assert.False(manager.IsDegradedMode);

        // 3. Drop to 1400 MB free -> Critical
        fakeMonitor.AvailableRamBytes = 1400UL * 1024 * 1024;
        var s3 = await manager.EvaluateCurrentResourcesAsync();
        Assert.Equal(ResourceSeverity.Critical, s3);
        Assert.True(manager.IsDegradedMode);

        // 4. Recovery back to 4000 MB free -> Normal
        fakeMonitor.AvailableRamBytes = 4000UL * 1024 * 1024;
        var s4 = await manager.EvaluateCurrentResourcesAsync();
        Assert.Equal(ResourceSeverity.Normal, s4);
        Assert.False(manager.IsDegradedMode);
    }

    [Fact]
    public async Task CanAllocateModel_Blocks_When_Projected_Headroom_Breaches_Threshold()
    {
        var fakeMonitor = new FakeSystemMonitor();
        var options = Options.Create(new ResourceManagerOptions
        {
            MinModelLoadHeadroomMB = 2000 // 2 GB minimum headroom required
        });

        var manager = new ResourceManager(NullLogger<ResourceManager>.Instance, fakeMonitor, options);

        // Available RAM: 3.5 GB (3584 MB)
        fakeMonitor.AvailableRamBytes = 3584UL * 1024 * 1024;

        // Try to allocate Qwen2.5 3B (2.0 GB / 2048 MB)
        // 3584 MB - 2048 MB = 1536 MB projected headroom < 2000 MB min headroom!
        ulong qwenSize = 2048UL * 1024 * 1024;
        var result = await manager.CanAllocateModelAsync("Qwen2.5-3B-Instruct-Q4_K_M", qwenSize);

        Assert.False(result.IsAllowed);
        Assert.Contains("Insufficient physical RAM", result.Reason);
        Assert.Contains("breach the minimum safety threshold", result.Reason);

        // Now suppose available RAM is 5.0 GB (5120 MB)
        // 5120 MB - 2048 MB = 3072 MB projected headroom > 2000 MB -> Allowed!
        fakeMonitor.AvailableRamBytes = 5120UL * 1024 * 1024;
        var resultAllowed = await manager.CanAllocateModelAsync("Qwen2.5-3B-Instruct-Q4_K_M", qwenSize);

        Assert.True(resultAllowed.IsAllowed);
    }

    [Fact]
    public void Subsystem_Tracking_Registers_And_Updates_Peak()
    {
        var fakeMonitor = new FakeSystemMonitor();
        var options = Options.Create(new ResourceManagerOptions());
        var manager = new ResourceManager(NullLogger<ResourceManager>.Instance, fakeMonitor, options);

        manager.RegisterSubsystemAllocation(SubsystemType.DaemonCore, "WorkingSet", 35 * 1024 * 1024);
        manager.RegisterSubsystemAllocation(SubsystemType.NativeHud, "wgpuBuffer", 20 * 1024 * 1024);

        var list = manager.GetSubsystemAllocations();
        Assert.Equal(2, list.Count);

        // Update with higher value, verify peak increases
        manager.RegisterSubsystemAllocation(SubsystemType.NativeHud, "wgpuBuffer", 45 * 1024 * 1024);
        var hudRec = manager.GetSubsystemAllocations().First(x => x.Subsystem == SubsystemType.NativeHud);
        Assert.Equal(45UL * 1024 * 1024, hudRec.AllocatedBytes);
        Assert.Equal(45UL * 1024 * 1024, hudRec.PeakBytes);

        // Update with lower value, verify peak stays at 45 MB
        manager.RegisterSubsystemAllocation(SubsystemType.NativeHud, "wgpuBuffer", 25 * 1024 * 1024);
        hudRec = manager.GetSubsystemAllocations().First(x => x.Subsystem == SubsystemType.NativeHud);
        Assert.Equal(25UL * 1024 * 1024, hudRec.AllocatedBytes);
        Assert.Equal(45UL * 1024 * 1024, hudRec.PeakBytes);
    }

    [Fact]
    public async Task TryAcquireReservation_AcquiresLease_And_DeductsFromEffectiveHeadroom()
    {
        var fakeMonitor = new FakeSystemMonitor();
        var options = Options.Create(new ResourceManagerOptions
        {
            MinModelLoadHeadroomMB = 2000 // 2 GB safety buffer
        });
        var manager = new ResourceManager(NullLogger<ResourceManager>.Instance, fakeMonitor, options);

        // Host available RAM: 5,000 MB (5,120,000,000 B)
        fakeMonitor.AvailableRamBytes = 5000UL * 1024 * 1024;
        ulong modelSize = 2000UL * 1024 * 1024; // 2 GB model

        // 1. Acquire first lease -> Succeeds (Projected headroom = 5000 - 2000 = 3000 MB > 2000 MB)
        var result1 = await manager.TryAcquireReservationAsync("Model-A", modelSize);
        Assert.True(result1.IsAllowed);
        Assert.NotNull(result1.Lease);
        Assert.Equal(modelSize, manager.TotalActiveReservationsBytes);

        // 2. Attempt second lease -> Fails (Effective avail = 5000 - 2000 = 3000 MB. Headroom if loaded = 3000 - 2000 = 1000 MB < 2000 MB threshold!)
        var result2 = await manager.TryAcquireReservationAsync("Model-B", modelSize);
        Assert.False(result2.IsAllowed);
        Assert.Null(result2.Lease);

        // 3. Dispose first lease -> Releases reservation
        result1.Lease.Dispose();
        Assert.Equal(0UL, manager.TotalActiveReservationsBytes);

        // 4. Now second lease attempt succeeds
        var result3 = await manager.TryAcquireReservationAsync("Model-B", modelSize);
        Assert.True(result3.IsAllowed);
        Assert.NotNull(result3.Lease);
        result3.Lease.Dispose();
    }

    [Fact]
    public async Task Concurrent_Reservations_Prevent_Overcommit_TOCTOU()
    {
        var fakeMonitor = new FakeSystemMonitor();
        var options = Options.Create(new ResourceManagerOptions
        {
            MinModelLoadHeadroomMB = 2000 // 2 GB minimum headroom
        });
        var manager = new ResourceManager(NullLogger<ResourceManager>.Instance, fakeMonitor, options);

        // Total available: 4,500 MB.
        // With 2,000 MB required headroom, there is only 2,500 MB budget for allocation.
        // A 2,000 MB model can fit ONCE, but CANNOT fit twice!
        fakeMonitor.AvailableRamBytes = 4500UL * 1024 * 1024;
        ulong modelSize = 2000UL * 1024 * 1024;

        // Launch 5 concurrent tasks simultaneously attempting to acquire a reservation
        var tasks = Enumerable.Range(1, 5).Select(i =>
            Task.Run(async () => await manager.TryAcquireReservationAsync($"ConcurrentModel-{i}", modelSize))
        ).ToArray();

        var results = await Task.WhenAll(tasks);

        int successCount = results.Count(r => r.IsAllowed);
        int failureCount = results.Count(r => !r.IsAllowed);

        // Exactly 1 must succeed; all others must be blocked atomically without race condition
        Assert.Equal(1, successCount);
        Assert.Equal(4, failureCount);

        // Cleanup the single acquired lease
        var winningResult = results.First(r => r.IsAllowed);
        winningResult.Lease?.Dispose();
        Assert.Equal(0UL, manager.TotalActiveReservationsBytes);
    }
}

