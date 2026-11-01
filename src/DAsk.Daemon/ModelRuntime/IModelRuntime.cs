namespace DAsk.Daemon.ModelRuntime;

public interface IModelRuntime : IAsyncDisposable
{
    ModelRuntimeState State { get; }
    ModelManifest Manifest { get; }
    InferenceBackend ActiveBackend { get; }

    Task<bool> LoadModelAsync(InferenceBackend? backendOverride = null, CancellationToken cancellationToken = default);
    Task UnloadModelAsync(string reason, CancellationToken cancellationToken = default);

    IAsyncEnumerable<TokenChunk> GenerateStreamAsync(
        ModelInferenceRequest request,
        CancellationToken cancellationToken = default);

    Task<(string Text, ModelExecutionTelemetry Telemetry)> GenerateAsync(
        ModelInferenceRequest request,
        CancellationToken cancellationToken = default);

    event EventHandler<ModelRuntimeState>? StateChanged;
}

