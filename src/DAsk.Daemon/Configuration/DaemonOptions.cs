namespace DAsk.Daemon.Configuration;

public class DaemonOptions
{
    public const string SectionName = "Daemon";

    public string PipeName { get; set; } = "d-ask-ipc-v1";
    public int TelemetryIntervalMs { get; set; } = 1000;
    public int HeartbeatIntervalMs { get; set; } = 5000;

    /// <summary>
    /// HUD liveness lease (Phase 7B.1a): a valid heartbeat renews it for this long. The HUD pings every 5 s, so one
    /// missed ping is tolerated and two are not. When it lapses, panic-hotkey availability is withdrawn for that HUD,
    /// its pending approvals are invalidated and its actions cancelled.
    /// </summary>
    public int HeartbeatLeaseMs { get; set; } = 12_000;

    /// <summary>A heartbeat whose timestamp differs from the daemon clock by more than this is stale (delayed or replayed).</summary>
    public int HeartbeatMaxSkewMs { get; set; } = 3_000;
    public int MaxConnectedClients { get; set; } = 4;

    /// <summary>
    /// Exact executable paths allowed to connect to the pipe (defense-in-depth only: it does not
    /// stop same-user malware or replacement of the executable in a user-writable directory).
    /// Relative entries resolve against the daemon's base directory. Empty means fail closed:
    /// no peer is accepted.
    /// </summary>
    public List<string> AllowedClientImagePaths { get; set; } = new();

    /// <summary>A connection must complete a valid handshake within this time or it is closed.</summary>
    public int HandshakeTimeoutMs { get; set; } = 5000;
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

