using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages;

public record SystemRamMetrics
{
    [JsonPropertyName("totalBytes")]
    public ulong TotalBytes { get; init; }

    [JsonPropertyName("availableBytes")]
    public ulong AvailableBytes { get; init; }

    [JsonPropertyName("usedBytes")]
    public ulong UsedBytes { get; init; }

    [JsonPropertyName("loadPercentage")]
    public double LoadPercentage { get; init; }
}

public record CpuMetrics
{
    [JsonPropertyName("totalUsagePercent")]
    public double TotalUsagePercent { get; init; }

    [JsonPropertyName("processUsagePercent")]
    public double ProcessUsagePercent { get; init; }
}

public record GpuMetrics
{
    [JsonPropertyName("adapterName")]
    public string AdapterName { get; init; } = "Intel(R) Iris(R) Xe Graphics";

    [JsonPropertyName("dedicatedVideoMemoryBytes")]
    public ulong DedicatedVideoMemoryBytes { get; init; }

    [JsonPropertyName("sharedSystemMemoryBytes")]
    public ulong SharedSystemMemoryBytes { get; init; }

    [JsonPropertyName("currentUsageBytes")]
    public ulong CurrentUsageBytes { get; init; }

    [JsonPropertyName("budgetBytes")]
    public ulong BudgetBytes { get; init; }

    [JsonPropertyName("isSharedMemoryArchitecture")]
    public bool IsSharedMemoryArchitecture { get; init; } = true;
}

public record ProcessMemoryMetrics
{
    [JsonPropertyName("workingSetBytes")]
    public long WorkingSetBytes { get; init; }

    [JsonPropertyName("privateBytes")]
    public long PrivateBytes { get; init; }
}

public record TelemetryUpdate
{
    [JsonPropertyName("systemRam")]
    public SystemRamMetrics SystemRam { get; init; } = new();

    [JsonPropertyName("cpu")]
    public CpuMetrics Cpu { get; init; } = new();

    [JsonPropertyName("gpu")]
    public GpuMetrics Gpu { get; init; } = new();

    [JsonPropertyName("processMemory")]
    public ProcessMemoryMetrics ProcessMemory { get; init; } = new();

    [JsonPropertyName("resourceStatus")]
    public string ResourceStatus { get; init; } = "Normal"; // Normal, Warning, Critical, Degraded

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;
}

