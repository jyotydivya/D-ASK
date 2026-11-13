namespace DAsk.Daemon.ModelRuntime;

public enum ModelRuntimeState
{
    Unloaded,
    Loading,
    Ready,
    Generating,
    Evicting,
    Error
}

public enum InferenceBackend
{
    Cpu_AVX2,
    Vulkan_IrisXe
}

public record ModelInferenceRequest
{
    public required string Prompt { get; init; }
    public string? SystemPrompt { get; init; }
    public float Temperature { get; init; } = 0.2f;
    public float TopP { get; init; } = 0.9f;
    public int MaxTokens { get; init; } = 512;
    public string? TaskId { get; init; }
    public string? ActionId { get; init; }
    public bool EnforceJsonStructure { get; init; }
    public IReadOnlyList<string>? StopSequences { get; init; }
}

public record TokenChunk
{
    public required string Text { get; init; }
    public int TokenIndex { get; init; }
    public bool IsFinal { get; init; }
}

public record ModelExecutionTelemetry
{
    public string ModelName { get; init; } = string.Empty;
    public string BackendUsed { get; init; } = "CPU_AVX2";
    public double TimeToFirstTokenMs { get; init; }
    public double PromptEvalTokensPerSec { get; init; }
    public double GenerationTokensPerSec { get; init; }
    public int PromptTokenCount { get; init; }
    public int TotalTokensGenerated { get; init; }
    public TimeSpan TotalDuration { get; init; }
    public ulong ResidentMemoryBytes { get; init; }
    public ulong PreInferenceAvailableRamBytes { get; init; }
    public ulong PostInferenceAvailableRamBytes { get; init; }
}

