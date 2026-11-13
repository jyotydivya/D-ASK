using DAsk.Protocol.IPC.Messages;

namespace DAsk.Daemon.Telemetry;

public interface ISystemMonitor
{
    Task<SystemRamMetrics> GetRamMetricsAsync(CancellationToken cancellationToken = default);
    Task<CpuMetrics> GetCpuMetricsAsync(CancellationToken cancellationToken = default);
    Task<GpuMetrics> GetGpuMetricsAsync(CancellationToken cancellationToken = default);
    ProcessMemoryMetrics GetProcessMemoryMetrics();
    Task<TelemetryUpdate> CaptureCompleteTelemetryAsync(string resourceStatus, CancellationToken cancellationToken = default);
}

