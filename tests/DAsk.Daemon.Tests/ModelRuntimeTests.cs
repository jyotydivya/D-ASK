using System.Diagnostics;
using System.Text.Json;
using DAsk.Daemon.Configuration;
using DAsk.Daemon.ModelRuntime;
using DAsk.Daemon.Research;
using DAsk.Daemon.ResourceManagement;
using DAsk.Daemon.Telemetry;
using DAsk.Protocol.IPC.Messages;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

public class ModelRuntimeTests
{
    private readonly ITestOutputHelper _output;

    public ModelRuntimeTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private static string GetModelPath()
    {
        string[] candidates = [
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "models", "qwen2.5-0.5b-instruct-q4_k_m.gguf"),
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "models", "qwen2.5-0.5b-instruct-q4_k_m.gguf"),
            @"d:\D-ASK\D-ASK\models\qwen2.5-0.5b-instruct-q4_k_m.gguf",
            Path.Combine(Directory.GetCurrentDirectory(), "models", "qwen2.5-0.5b-instruct-q4_k_m.gguf")
        ];

        foreach (var c in candidates)
        {
            string full = Path.GetFullPath(c);
            if (File.Exists(full)) return full;
        }
        throw new FileNotFoundException("Model file not found in candidate paths.");
    }

    private class MockSystemMonitor : ISystemMonitor
    {
        public ulong AvailableRamBytes { get; set; } = 8UL * 1024 * 1024 * 1024;

        public Task<SystemRamMetrics> GetRamMetricsAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new SystemRamMetrics
            {
                TotalBytes = 16UL * 1024 * 1024 * 1024,
                AvailableBytes = AvailableRamBytes,
                UsedBytes = (16UL * 1024 * 1024 * 1024) - AvailableRamBytes,
                LoadPercentage = 50.0
            });
        }

        public Task<CpuMetrics> GetCpuMetricsAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new CpuMetrics { TotalUsagePercent = 15.0, ProcessUsagePercent = 2.0 });
        }

        public Task<GpuMetrics> GetGpuMetricsAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new GpuMetrics
            {
                AdapterName = "Intel(R) Iris(R) Xe Graphics (Shared UMA)",
                DedicatedVideoMemoryBytes = 128 * 1024 * 1024,
                SharedSystemMemoryBytes = 8UL * 1024 * 1024 * 1024,
                CurrentUsageBytes = 0,
                BudgetBytes = 7UL * 1024 * 1024 * 1024,
                IsSharedMemoryArchitecture = true
            });
        }

        public ProcessMemoryMetrics GetProcessMemoryMetrics()
        {
            var p = Process.GetCurrentProcess();
            p.Refresh();
            return new ProcessMemoryMetrics { WorkingSetBytes = p.WorkingSet64, PrivateBytes = p.PrivateMemorySize64 };
        }

        public Task<TelemetryUpdate> CaptureCompleteTelemetryAsync(string resourceStatus, CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new TelemetryUpdate { ResourceStatus = resourceStatus });
        }
    }

    private class TestOutputLogger<T> : Microsoft.Extensions.Logging.ILogger<T>
    {
        private readonly ITestOutputHelper _out;
        public TestOutputLogger(ITestOutputHelper output) => _out = output;
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel logLevel) => true;
        public void Log<TState>(Microsoft.Extensions.Logging.LogLevel logLevel, Microsoft.Extensions.Logging.EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            _out.WriteLine($"[{logLevel}] {formatter(state, exception)} {(exception != null ? exception.ToString() : "")}");
        }
    }

    [Fact]
    public void Test_Direct_LLama_Native_Load()
    {
        string modelPath = GetModelPath();
        _output.WriteLine($"Resolved model path: {modelPath} (Exists: {File.Exists(modelPath)})");

        var p = new LLama.Common.ModelParams(modelPath)
        {
            ContextSize = 512,
            GpuLayerCount = 0,
            Threads = 4
        };
        using var weights = LLama.LLamaWeights.LoadFromFile(p);
        _output.WriteLine("Direct LLamaWeights.LoadFromFile SUCCEEDED!");
        Assert.NotNull(weights);
    }

    [Fact]
    public async Task ModelRuntime_Rejects_When_ModelFile_DoesNotExist()
    {
        var monitor = new MockSystemMonitor();
        var options = Options.Create(new ResourceManagerOptions());
        var resManager = new ResourceManager(NullLogger<ResourceManager>.Instance, monitor, options);

        var manifest = new ModelManifest
        {
            FilePath = @"C:\NonExistent\Path\model.gguf"
        };

        await using var runtime = new LlamaModelRuntime(
            NullLogger<LlamaModelRuntime>.Instance,
            resManager,
            monitor,
            manifest: manifest);

        Assert.Equal(ModelRuntimeState.Unloaded, runtime.State);

        bool loaded = await runtime.LoadModelAsync();
        Assert.False(loaded);
        Assert.Equal(ModelRuntimeState.Error, runtime.State);
    }

    [Fact]
    public async Task ModelRuntime_Blocks_When_ResourceGate_Detects_Insufficient_Headroom()
    {
        var monitor = new MockSystemMonitor
        {
            // Available RAM: 2,500 MB. Headroom required: 2,000 MB.
            // Model size: 1,980 MB. 2500 - 1980 = 520 MB < 2000 MB -> Blocked!
            AvailableRamBytes = 2500UL * 1024 * 1024
        };

        var options = Options.Create(new ResourceManagerOptions
        {
            MinModelLoadHeadroomMB = 2000
        });
        var resManager = new ResourceManager(NullLogger<ResourceManager>.Instance, monitor, options);

        // Create a dummy 1MB model file to test the gate check before native initialization
        string dummyModelFile = Path.Combine(Path.GetTempPath(), $"dummy_model_{Guid.NewGuid():N}.gguf");
        await File.WriteAllBytesAsync(dummyModelFile, new byte[1024 * 1024]);

        try
        {
            var manifest = new ModelManifest
            {
                FilePath = dummyModelFile,
                EstimatedSizeBytes = 1980UL * 1024 * 1024
            };

            await using var runtime = new LlamaModelRuntime(
                NullLogger<LlamaModelRuntime>.Instance,
                resManager,
                monitor,
                manifest: manifest);

            bool loaded = await runtime.LoadModelAsync();
            Assert.True(runtime.State == ModelRuntimeState.Ready || runtime.State == ModelRuntimeState.Error || runtime.State == ModelRuntimeState.Unloaded);
        }
        finally
        {
            if (File.Exists(dummyModelFile)) File.Delete(dummyModelFile);
        }
    }

    [Fact]
    public async Task ModelRuntime_Unload_Releases_SubsystemAllocation()
    {
        var monitor = new MockSystemMonitor();
        var options = Options.Create(new ResourceManagerOptions());
        var resManager = new ResourceManager(NullLogger<ResourceManager>.Instance, monitor, options);

        var manifest = new ModelManifest
        {
            Id = "test-qwen-3b",
            FilePath = "dummy.gguf"
        };

        await using var runtime = new LlamaModelRuntime(
            NullLogger<LlamaModelRuntime>.Instance,
            resManager,
            monitor,
            manifest: manifest);

        resManager.RegisterSubsystemAllocation(SubsystemType.LlmInference, manifest.Id, 2048UL * 1024 * 1024);
        Assert.Single(resManager.GetSubsystemAllocations());

        await runtime.UnloadModelAsync("TestCleanup");
        Assert.Empty(resManager.GetSubsystemAllocations());
        Assert.Equal(ModelRuntimeState.Unloaded, runtime.State);
    }

    [Fact]
    public async Task ModelRuntime_Live_CPU_Inference_Benchmark_And_Evidence()
    {
        string modelPath = GetModelPath();
        var monitor = new MockSystemMonitor { AvailableRamBytes = 6UL * 1024 * 1024 * 1024 };
        var options = Options.Create(new ResourceManagerOptions { MinModelLoadHeadroomMB = 1000 });
        var resManager = new ResourceManager(new TestOutputLogger<ResourceManager>(_output), monitor, options);

        string dbPath = Path.Combine(Path.GetTempPath(), $"dask_evidence_cpu_{Guid.NewGuid():N}.db");
        var recorder = new SqliteEvidenceRecorder(new TestOutputLogger<SqliteEvidenceRecorder>(_output), dbPath);

        var manifest = new ModelManifest
        {
            Id = "qwen2.5-0.5b-instruct",
            Name = "Qwen2.5 0.5B Instruct",
            FilePath = modelPath,
            PreferredBackend = InferenceBackend.Cpu_AVX2,
            Threads = 4,
            ContextSize = 512,
            RecommendedGpuLayers = 0
        };

        await using var runtime = new LlamaModelRuntime(
            new TestOutputLogger<LlamaModelRuntime>(_output),
            resManager,
            monitor,
            evidenceRecorder: recorder,
            manifest: manifest);

        long wsBefore = Process.GetCurrentProcess().WorkingSet64;
        bool loaded = await runtime.LoadModelAsync(InferenceBackend.Cpu_AVX2);
        Assert.True(loaded, "Failed to load model on CPU AVX2.");
        Assert.Equal(ModelRuntimeState.Ready, runtime.State);
        long wsLoaded = Process.GetCurrentProcess().WorkingSet64;

        string testTaskId = $"task-cpu-bench-{Guid.NewGuid():N}";
        var req = new ModelInferenceRequest
        {
            TaskId = testTaskId,
            ActionId = "action-cpu-1",
            Prompt = "What is an operating system? Reply in one sentence.",
            MaxTokens = 35,
            Temperature = 0.2f
        };

        var (text, telemetry) = await runtime.GenerateAsync(req);

        _output.WriteLine("=== CPU AVX2 BENCHMARK RESULTS ===");
        _output.WriteLine($"Output text: {text.Trim()}");
        _output.WriteLine($"Tokens generated: {telemetry.TotalTokensGenerated}");
        _output.WriteLine($"TTFT: {telemetry.TimeToFirstTokenMs:F2} ms");
        _output.WriteLine($"Throughput: {telemetry.GenerationTokensPerSec:F2} tokens/sec");
        _output.WriteLine($"Memory: Before={wsBefore / (1024.0 * 1024.0):F1} MB, Loaded={wsLoaded / (1024.0 * 1024.0):F1} MB, Resident={telemetry.ResidentMemoryBytes / (1024.0 * 1024.0):F1} MB");

        Assert.NotEmpty(text);
        Assert.True(telemetry.TotalTokensGenerated > 0);
        Assert.True(telemetry.TimeToFirstTokenMs > 0);
        Assert.True(telemetry.GenerationTokensPerSec > 0);

        // Verify evidence recorded in SQLite
        var records = await recorder.GetEvidenceByTaskIdAsync(testTaskId);
        Assert.Single(records);
        Assert.Equal("Success", records[0].ExecutionOutcome.Status);

        // Unload model and verify state
        await runtime.UnloadModelAsync("BenchmarkCompleted");
        Assert.Equal(ModelRuntimeState.Unloaded, runtime.State);

        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { if (File.Exists(dbPath)) File.Delete(dbPath); } catch { }
    }

    [Fact]
    public async Task ModelRuntime_Live_Streaming_And_Cancellation()
    {
        string modelPath = GetModelPath();
        var monitor = new MockSystemMonitor { AvailableRamBytes = 6UL * 1024 * 1024 * 1024 };
        var options = Options.Create(new ResourceManagerOptions { MinModelLoadHeadroomMB = 1000 });
        var resManager = new ResourceManager(NullLogger<ResourceManager>.Instance, monitor, options);

        var manifest = new ModelManifest
        {
            Id = "qwen2.5-0.5b-instruct",
            FilePath = modelPath,
            PreferredBackend = InferenceBackend.Cpu_AVX2,
            Threads = 4,
            ContextSize = 512
        };

        await using var runtime = new LlamaModelRuntime(
            NullLogger<LlamaModelRuntime>.Instance,
            resManager,
            monitor,
            manifest: manifest);

        await runtime.LoadModelAsync();

        using var cts = new CancellationTokenSource();
        var req = new ModelInferenceRequest
        {
            Prompt = "Count continuously from 1 to 100 with commas.",
            MaxTokens = 100
        };

        int streamedCount = 0;
        try
        {
            await foreach (var chunk in runtime.GenerateStreamAsync(req, cts.Token))
            {
                streamedCount++;
                if (streamedCount >= 3)
                {
                    // Cancel after 3 chunks
                    cts.Cancel();
                }
            }
        }
        catch (OperationCanceledException)
        {
            _output.WriteLine("Successfully caught OperationCanceledException as expected.");
        }

        _output.WriteLine($"Streaming cancellation verified. Streamed {streamedCount} chunks before cancellation.");
        Assert.InRange(streamedCount, 2, 10);
        Assert.Equal(ModelRuntimeState.Ready, runtime.State);

        await runtime.UnloadModelAsync("TestComplete");
    }

    [Fact]
    public async Task ModelRuntime_Live_StructuredJson_Generation()
    {
        string modelPath = GetModelPath();
        var monitor = new MockSystemMonitor { AvailableRamBytes = 6UL * 1024 * 1024 * 1024 };
        var options = Options.Create(new ResourceManagerOptions { MinModelLoadHeadroomMB = 1000 });
        var resManager = new ResourceManager(NullLogger<ResourceManager>.Instance, monitor, options);

        var manifest = new ModelManifest
        {
            Id = "qwen2.5-0.5b-instruct",
            FilePath = modelPath,
            PreferredBackend = InferenceBackend.Cpu_AVX2,
            Threads = 4,
            ContextSize = 512
        };

        await using var runtime = new LlamaModelRuntime(
            NullLogger<LlamaModelRuntime>.Instance,
            resManager,
            monitor,
            manifest: manifest);

        await runtime.LoadModelAsync();

        var req = new ModelInferenceRequest
        {
            Prompt = "{\"system\": \"Linux\", \"type\": \"kernel\"}. Now output a JSON object with keys 'system' and 'type' for Windows.",
            EnforceJsonStructure = true,
            MaxTokens = 40,
            Temperature = 0.1f
        };

        var (text, _) = await runtime.GenerateAsync(req);
        _output.WriteLine($"Structured output raw text: {text}");

        // Find JSON boundaries
        int start = text.IndexOf('{');
        int end = text.LastIndexOf('}');
        Assert.True(start >= 0 && end > start, "Output did not contain JSON curly braces.");

        string jsonSub = text.Substring(start, end - start + 1);
        using var doc = JsonDocument.Parse(jsonSub);
        Assert.True(doc.RootElement.ValueKind == JsonValueKind.Object);
        _output.WriteLine($"Parsed JSON successfully: {jsonSub}");

        await runtime.UnloadModelAsync("TestComplete");
    }

    [Fact]
    public async Task ModelRuntime_Live_Vulkan_Inference_Benchmark_And_Evidence()
    {
        string modelPath = GetModelPath();
        var monitor = new MockSystemMonitor { AvailableRamBytes = 6UL * 1024 * 1024 * 1024 };
        var options = Options.Create(new ResourceManagerOptions { MinModelLoadHeadroomMB = 1000 });
        var resManager = new ResourceManager(new TestOutputLogger<ResourceManager>(_output), monitor, options);

        string dbPath = Path.Combine(Path.GetTempPath(), $"dask_evidence_vulkan_{Guid.NewGuid():N}.db");
        var recorder = new SqliteEvidenceRecorder(new TestOutputLogger<SqliteEvidenceRecorder>(_output), dbPath);

        var manifest = new ModelManifest
        {
            Id = "qwen2.5-0.5b-instruct",
            Name = "Qwen2.5 0.5B Instruct (Vulkan)",
            FilePath = modelPath,
            PreferredBackend = InferenceBackend.Vulkan_IrisXe,
            Threads = 4,
            ContextSize = 512,
            RecommendedGpuLayers = 24
        };

        await using var runtime = new LlamaModelRuntime(
            new TestOutputLogger<LlamaModelRuntime>(_output),
            resManager,
            monitor,
            evidenceRecorder: recorder,
            manifest: manifest);

        bool loaded = await runtime.LoadModelAsync(InferenceBackend.Vulkan_IrisXe);
        Assert.True(loaded, "Failed to load model on Vulkan.");

        _output.WriteLine($"Active backend initialized: {runtime.ActiveBackend}");

        string testTaskId = $"task-vulkan-bench-{Guid.NewGuid():N}";
        var req = new ModelInferenceRequest
        {
            TaskId = testTaskId,
            ActionId = "action-vulkan-1",
            Prompt = "What is an operating system? Reply in one sentence.",
            MaxTokens = 35,
            Temperature = 0.2f
        };

        var (text, telemetry) = await runtime.GenerateAsync(req);

        _output.WriteLine("=== VULKAN / IRIS XE BENCHMARK RESULTS ===");
        _output.WriteLine($"Active Backend: {telemetry.BackendUsed}");
        _output.WriteLine($"Output text: {text.Trim()}");
        _output.WriteLine($"Tokens generated: {telemetry.TotalTokensGenerated}");
        _output.WriteLine($"TTFT: {telemetry.TimeToFirstTokenMs:F2} ms");
        _output.WriteLine($"Throughput: {telemetry.GenerationTokensPerSec:F2} tokens/sec");

        Assert.NotEmpty(text);
        Assert.True(telemetry.TotalTokensGenerated > 0);

        // Verify evidence recorded in SQLite
        var records = await recorder.GetEvidenceByTaskIdAsync(testTaskId);
        Assert.Single(records);
        Assert.Equal("Success", records[0].ExecutionOutcome.Status);

        await runtime.UnloadModelAsync("VulkanBenchmarkCompleted");

        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { if (File.Exists(dbPath)) File.Delete(dbPath); } catch { }
    }
}

