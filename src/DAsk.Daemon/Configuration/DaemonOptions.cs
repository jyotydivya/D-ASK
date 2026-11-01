namespace DAsk.Daemon.Configuration;

public class DaemonOptions
{
    public const string SectionName = "Daemon";

    public string PipeName { get; set; } = "d-ask-ipc-v1";
    public int TelemetryIntervalMs { get; set; } = 1000;
    public int HeartbeatIntervalMs { get; set; } = 5000;
    public int MaxConnectedClients { get; set; } = 4;
}

public class ResourceManagerOptions
{
    public const string SectionName = "ResourceManager";

    public ulong WarningAvailableMemoryMB { get; set; } = 2500;
    public ulong CriticalAvailableMemoryMB { get; set; } = 1800;
    public double CpuThrottleThresholdPercent { get; set; } = 85.0;
    public ulong MinModelLoadHeadroomMB { get; set; } = 2000;
    public bool TrackSubsystemAllocations { get; set; } = true;
}

