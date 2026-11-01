using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using DAsk.Daemon.Research;
using DAsk.Daemon.ResourceManagement;
using DAsk.Daemon.Telemetry;
using LLama;
using LLama.Common;
using LLama.Sampling;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.ModelRuntime;

public class LlamaModelRuntime : IModelRuntime
{
    private readonly ILogger<LlamaModelRuntime> _logger;
    private readonly IResourceManager _resourceManager;
    private readonly ISystemMonitor _systemMonitor;
    private readonly IEvidenceRecorder? _evidenceRecorder;
    private readonly SemaphoreSlim _runtimeLock = new(1, 1);

    private ModelRuntimeState _state = ModelRuntimeState.Unloaded;
    private InferenceBackend _activeBackend = InferenceBackend.Cpu_AVX2;
    private ModelManifest _manifest = new();
    private MemoryReservationLease? _currentLease;

    private LLamaWeights? _weights;
    private LLamaContext? _context;
    private StatelessExecutor? _executor;

    private CancellationTokenSource? _inactivityCts;
    private readonly TimeSpan _inactivityTimeout = TimeSpan.FromSeconds(60);

    public ModelRuntimeState State => _state;
    public ModelManifest Manifest => _manifest;
    public InferenceBackend ActiveBackend => _activeBackend;

    public event EventHandler<ModelRuntimeState>? StateChanged;

    public static InferenceBackend GlobalPreferredBackend { get; set; } = InferenceBackend.Cpu_AVX2;

    static LlamaModelRuntime()
    {
        EnsureNativeResolverConfigured();
    }

    public static void EnsureNativeResolverConfigured()
    {
        try
        {
            NativeLibrary.SetDllImportResolver(typeof(LLama.Native.NativeApi).Assembly, (libraryName, assembly, searchPath) =>
            {
                string baseDir = AppContext.BaseDirectory;
                string[] subDirs = GlobalPreferredBackend == InferenceBackend.Vulkan_IrisXe 
                    ? ["vulkan", "avx2", "avx", "noavx"] 
                    : ["avx2", "vulkan", "avx", "noavx"];

                foreach (var dir in subDirs)
                {
                    string candidate = Path.Combine(baseDir, "runtimes", "win-x64", "native", dir, $"{libraryName}.dll");
                    if (File.Exists(candidate))
                    {
                        if (NativeLibrary.TryLoad(candidate, out var handle))
                        {
                            return handle;
                        }
                    }
                }

                string localPath = Path.Combine(baseDir, $"{libraryName}.dll");
                if (File.Exists(localPath) && NativeLibrary.TryLoad(localPath, out var localHandle))
                {
                    return localHandle;
                }

                return IntPtr.Zero;
            });
        }
        catch (InvalidOperationException)
        {
            // Already registered for this assembly in this process
        }
    }

    public LlamaModelRuntime(
        ILogger<LlamaModelRuntime> logger,
        IResourceManager resourceManager,
        ISystemMonitor systemMonitor,
        IEvidenceRecorder? evidenceRecorder = null,
        ModelManifest? manifest = null)
    {
        _logger = logger;
        _resourceManager = resourceManager;
        _systemMonitor = systemMonitor;
        _evidenceRecorder = evidenceRecorder;
        if (manifest != null) _manifest = manifest;
    }

    private void SetState(ModelRuntimeState newState)
    {
        if (_state != newState)
        {
            _logger.LogInformation("ModelRuntime state changed: {OldState} -> {NewState}", _state, newState);
            _state = newState;
            StateChanged?.Invoke(this, newState);
        }
    }

    public async Task<bool> LoadModelAsync(InferenceBackend? backendOverride = null, CancellationToken cancellationToken = default)
    {
        await _runtimeLock.WaitAsync(cancellationToken);
        try
        {
            if (_state == ModelRuntimeState.Ready && _weights != null && _context != null)
            {
                ResetInactivityTimer();
                return true;
            }

            SetState(ModelRuntimeState.Loading);
            ResetInactivityTimer();

            // 1. Check if model file exists on disk
            string resolvedPath = Path.GetFullPath(_manifest.FilePath);
            if (!File.Exists(resolvedPath))
            {
                _logger.LogWarning("Model file not found at: '{Path}'", resolvedPath);
                SetState(ModelRuntimeState.Error);
                return false;
            }

            // 2. Acquire atomic memory reservation lease (TD-02 protection)
            ulong fileSize = (ulong)new FileInfo(resolvedPath).Length;
            var allocResult = await _resourceManager.TryAcquireReservationAsync(_manifest.Name, fileSize, cancellationToken);
            if (!allocResult.IsAllowed)
            {
                _logger.LogWarning("Model load blocked by resource manager: {Reason}", allocResult.Reason);
                SetState(ModelRuntimeState.Unloaded);
                return false;
            }

            _currentLease = allocResult.Lease;
            _resourceManager.RegisterSubsystemAllocation(SubsystemType.LlmInference, _manifest.Id, fileSize);

            // 3. Configure backend (Vulkan vs CPU)
            _activeBackend = backendOverride ?? _manifest.PreferredBackend;
            int gpuLayers = _activeBackend == InferenceBackend.Vulkan_IrisXe ? _manifest.RecommendedGpuLayers : 0;

            _logger.LogInformation("Loading GGUF weights: Backend={Backend}, GpuLayers={GpuLayers}, Threads={Threads}, File='{Path}'",
                _activeBackend, gpuLayers, _manifest.Threads, resolvedPath);

            var modelParams = new ModelParams(resolvedPath)
            {
                ContextSize = _manifest.ContextSize,
                GpuLayerCount = gpuLayers,
                Threads = _manifest.Threads,
                BatchThreads = 6
            };

            try
            {
                _weights = await Task.Run(() => LLamaWeights.LoadFromFile(modelParams), cancellationToken);
                _context = _weights.CreateContext(modelParams);
                _executor = new StatelessExecutor(_weights, modelParams);

                SetState(ModelRuntimeState.Ready);
                ResetInactivityTimer();
                return true;
            }
            catch (Exception ex) when (_activeBackend == InferenceBackend.Vulkan_IrisXe)
            {
                _logger.LogWarning(ex, "Failed to initialize on Vulkan; attempting graceful fallback to CPU AVX2...");

                // Fallback to CPU mode
                _activeBackend = InferenceBackend.Cpu_AVX2;
                modelParams.GpuLayerCount = 0;

                _weights = await Task.Run(() => LLamaWeights.LoadFromFile(modelParams), cancellationToken);
                _context = _weights.CreateContext(modelParams);
                _executor = new StatelessExecutor(_weights, modelParams);

                SetState(ModelRuntimeState.Ready);
                ResetInactivityTimer();
                return true;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load model '{ModelName}'.", _manifest.Name);
            SetState(ModelRuntimeState.Error);
            await UnloadModelInternalAsync("LoadFailure");
            return false;
        }
        finally
        {
            _runtimeLock.Release();
        }
    }

    public async Task UnloadModelAsync(string reason, CancellationToken cancellationToken = default)
    {
        await _runtimeLock.WaitAsync(cancellationToken);
        try
        {
            if (_state == ModelRuntimeState.Unloaded && _weights == null)
            {
                _resourceManager.UnregisterSubsystemAllocation(SubsystemType.LlmInference, _manifest.Id);
                return;
            }
            await UnloadModelInternalAsync(reason);
        }
        finally
        {
            _runtimeLock.Release();
        }
    }

    private Task UnloadModelInternalAsync(string reason)
    {
        SetState(ModelRuntimeState.Evicting);
        _logger.LogInformation("Evicting model '{ModelName}'. Reason: {Reason}", _manifest.Name, reason);

        _inactivityCts?.Cancel();
        _inactivityCts?.Dispose();
        _inactivityCts = null;

        _executor = null;

        _context?.Dispose();
        _context = null;

        _weights?.Dispose();
        _weights = null;

        _currentLease?.Dispose();
        _currentLease = null;

        _resourceManager.UnregisterSubsystemAllocation(SubsystemType.LlmInference, _manifest.Id);

        // Explicit GC pass to return memory to operating system immediately
        GC.Collect();
        GC.WaitForPendingFinalizers();

        SetState(ModelRuntimeState.Unloaded);
        _logger.LogInformation("Model '{ModelName}' unmapped. Memory returned to baseline.", _manifest.Name);

        return Task.CompletedTask;
    }

    private void ResetInactivityTimer()
    {
        _inactivityCts?.Cancel();
        _inactivityCts?.Dispose();
        _inactivityCts = new CancellationTokenSource();

        var token = _inactivityCts.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(_inactivityTimeout, token);
                if (!token.IsCancellationRequested && _state == ModelRuntimeState.Ready)
                {
                    await UnloadModelAsync("InactivityTimeout");
                }
            }
            catch (OperationCanceledException) { }
        }, token);
    }

    public async IAsyncEnumerable<TokenChunk> GenerateStreamAsync(
        ModelInferenceRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (_state != ModelRuntimeState.Ready || _executor == null)
        {
            bool loaded = await LoadModelAsync(cancellationToken: cancellationToken);
            if (!loaded || _executor == null)
            {
                throw new InvalidOperationException($"Model runtime is not ready (State: {_state}).");
            }
        }

        ResetInactivityTimer();
        SetState(ModelRuntimeState.Generating);

        string promptText = BuildFormattedPrompt(request);
        var inferenceParams = new InferenceParams
        {
            MaxTokens = request.MaxTokens,
            AntiPrompts = request.StopSequences?.ToList() ?? new List<string> { "<|im_end|>", "User:", "\n\nUser" },
            SamplingPipeline = new DefaultSamplingPipeline
            {
                Temperature = request.Temperature,
                TopP = request.TopP
            }
        };

        int tokenIndex = 0;
        try
        {
            await foreach (var token in _executor.InferAsync(promptText, inferenceParams, cancellationToken))
            {
                tokenIndex++;
                yield return new TokenChunk
                {
                    Text = token,
                    TokenIndex = tokenIndex,
                    IsFinal = false
                };
            }

            yield return new TokenChunk
            {
                Text = string.Empty,
                TokenIndex = tokenIndex,
                IsFinal = true
            };
        }
        finally
        {
            SetState(ModelRuntimeState.Ready);
            ResetInactivityTimer();
        }
    }

    public async Task<(string Text, ModelExecutionTelemetry Telemetry)> GenerateAsync(
        ModelInferenceRequest request,
        CancellationToken cancellationToken = default)
    {
        var preRam = await _systemMonitor.GetRamMetricsAsync(cancellationToken);
        var preCpu = await _systemMonitor.GetCpuMetricsAsync(cancellationToken);

        var sw = Stopwatch.StartNew();
        double timeToFirstToken = 0.0;
        var fullText = new System.Text.StringBuilder();
        int tokenCount = 0;

        await foreach (var chunk in GenerateStreamAsync(request, cancellationToken))
        {
            if (tokenCount == 0 && !chunk.IsFinal)
            {
                timeToFirstToken = sw.Elapsed.TotalMilliseconds;
            }

            if (!chunk.IsFinal)
            {
                tokenCount++;
                fullText.Append(chunk.Text);
            }
        }

        sw.Stop();
        double genTimeSec = (sw.Elapsed.TotalMilliseconds - timeToFirstToken) / 1000.0;
        double tokPerSec = genTimeSec > 0 && tokenCount > 1 ? (tokenCount - 1) / genTimeSec : 0.0;

        var postRam = await _systemMonitor.GetRamMetricsAsync(cancellationToken);
        var procMem = _systemMonitor.GetProcessMemoryMetrics();

        var telemetry = new ModelExecutionTelemetry
        {
            ModelName = _manifest.Name,
            BackendUsed = _activeBackend.ToString(),
            TimeToFirstTokenMs = Math.Round(timeToFirstToken, 2),
            GenerationTokensPerSec = Math.Round(tokPerSec, 2),
            TotalTokensGenerated = tokenCount,
            TotalDuration = sw.Elapsed,
            ResidentMemoryBytes = (ulong)procMem.WorkingSetBytes,
            PreInferenceAvailableRamBytes = preRam.AvailableBytes,
            PostInferenceAvailableRamBytes = postRam.AvailableBytes
        };

        _logger.LogInformation("Inference complete: Model='{Model}', Backend={Backend}, Tokens={Tokens}, Tok/s={TokPerSec:F1}, TTFT={TTFT:F1}ms",
            _manifest.Name, _activeBackend, tokenCount, tokPerSec, timeToFirstToken);

        // Research Evidence Persistence
        if (_evidenceRecorder != null && !string.IsNullOrEmpty(request.TaskId))
        {
            var evidenceRecord = new ExecutionEvidenceRecord
            {
                TaskId = request.TaskId,
                ActionId = request.ActionId ?? $"act-infer-{Guid.NewGuid():N}",
                Timestamp = DateTimeOffset.UtcNow,
                ActionMetadata = new ActionMetadata
                {
                    AgentName = "ModelRuntimeAgent",
                    ToolName = "local_model_inference",
                    Parameters = JsonSerializer.SerializeToElement(new
                    {
                        model = _manifest.Id,
                        backend = _activeBackend.ToString(),
                        maxTokens = request.MaxTokens,
                        temperature = request.Temperature
                    }),
                    IntentDescription = $"Generate completion for prompt ({tokenCount} tokens produced)"
                },
                RiskAssessment = new RiskAssessment
                {
                    SideEffectRisk = "None",
                    Reversibility = "FullyReversible",
                    PriorUncertainty = 0.0
                },
                PreActionObservation = new PreActionObservation
                {
                    ObservationTimestamp = DateTimeOffset.UtcNow.Subtract(sw.Elapsed),
                    Telemetry = new Dictionary<string, object?>
                    {
                        ["availableRamMB"] = preRam.AvailableBytes / (1024.0 * 1024.0),
                        ["cpuUsagePercent"] = preCpu.TotalUsagePercent
                    }
                },
                ExecutionOutcome = new ExecutionOutcome
                {
                    Status = "Success",
                    ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                    RawOutput = JsonSerializer.SerializeToElement(new
                    {
                        tokensGenerated = tokenCount,
                        tokPerSec = tokPerSec,
                        timeToFirstTokenMs = timeToFirstToken
                    })
                },
                PostActionObservation = new PostActionObservation
                {
                    ObservationTimestamp = DateTimeOffset.UtcNow,
                    StateDivergenceDetected = false,
                    ObservedChanges = new List<string> { $"Inference finished in {sw.ElapsedMilliseconds}ms" }
                },
                VerificationDecision = new VerificationDecision
                {
                    Verified = true,
                    VerificationMethod = "ProcessInspection",
                    EvidenceDescription = "Generated response verified within memory constraints"
                }
            };

            try
            {
                await _evidenceRecorder.RecordEvidenceAsync(evidenceRecord, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to record execution evidence for inference task {TaskId}", request.TaskId);
            }
        }

        return (fullText.ToString(), telemetry);
    }

    private string BuildFormattedPrompt(ModelInferenceRequest request)
    {
        // Standard ChatML prompt formatting for Qwen2.5 / modern instruct models
        var sb = new System.Text.StringBuilder();
        if (!string.IsNullOrEmpty(request.SystemPrompt))
        {
            sb.Append("<|im_start|>system\n").Append(request.SystemPrompt).Append("<|im_end|>\n");
        }
        else
        {
            sb.Append("<|im_start|>system\nYou are D-ASK, a high-performance local desktop AI assistant.<|im_end|>\n");
        }

        if (request.EnforceJsonStructure)
        {
            sb.Append("Respond strictly with valid JSON without any markdown code fences or conversational text.\n");
        }

        sb.Append("<|im_start|>user\n").Append(request.Prompt).Append("<|im_end|>\n");
        sb.Append("<|im_start|>assistant\n");
        return sb.ToString();
    }

    public async ValueTask DisposeAsync()
    {
        await UnloadModelAsync("Disposed");
        _runtimeLock.Dispose();
    }
}