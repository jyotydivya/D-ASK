namespace DAsk.Daemon.ModelRuntime;

public record ModelManifest
{
    public string Id { get; init; } = "qwen2.5-3b-instruct-q4_k_m";
    public string Name { get; init; } = "Qwen2.5-3B-Instruct (Q4_K_M)";
    public string FilePath { get; init; } = @"models\qwen2.5-3b-instruct-q4_k_m.gguf";
    public ulong EstimatedSizeBytes { get; init; } = 2_126_807_040; // ~1.98 GB
    public int RecommendedGpuLayers { get; init; } = 28; // 28 layers to Iris Xe Vulkan
    public uint ContextSize { get; init; } = 4096;
    public int Threads { get; init; } = 4; // 4 threads pinned to P-cores
    public InferenceBackend PreferredBackend { get; init; } = InferenceBackend.Vulkan_IrisXe;
    public ulong MinimumHeadroomMB { get; init; } = 2000;
}

