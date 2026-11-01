using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Configuration;
using DAsk.Daemon.IPC;
using DAsk.Daemon.ModelRuntime;
using DAsk.Daemon.Research;
using DAsk.Daemon.ResourceManagement;
using DAsk.Daemon.State;
using DAsk.Daemon.Telemetry;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon;

public class Program
{
    public static async Task Main(string[] args)
    {
        // Establish Per-Monitor DPI Awareness V2 before any GDI or window creation
        DpiCoordinateConverter.InitializeDpiAwareness();

        Console.Title = "D-ASK Native Assistant Daemon";
        Console.WriteLine(@"
  ██████╗         █████╗ ███████╗██╗  ██╗
  ██╔══██╗       ██╔══██╗██╔════╝██║ ██╔╝
  ██║  ██║ █████╗███████║███████╗█████╔╝ 
  ██║  ██║ ╚════╝██╔══██║╚════██║██╔═██╗ 
  ██████╔╝       ██║  ██║███████║██║  ██╗
  ╚═════╝        ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
  Native Assistant Daemon (Stage 1 Skeleton)
");

        var builder = Host.CreateDefaultBuilder(args);

        builder.ConfigureAppConfiguration((hostingContext, config) =>
        {
            config.SetBasePath(AppContext.BaseDirectory);
            config.AddJsonFile("appsettings.json", optional: true, reloadOnChange: true);
            config.AddEnvironmentVariables(prefix: "DASK_");
            config.AddCommandLine(args);
        });

        builder.ConfigureLogging((context, logging) =>
        {
            logging.ClearProviders();
            logging.AddConfiguration(context.Configuration.GetSection("Logging"));
            logging.AddSimpleConsole(options =>
            {
                options.TimestampFormat = "[yyyy-MM-dd HH:mm:ss.fff] ";
                options.SingleLine = true;
            });
        });

        builder.ConfigureServices((context, services) =>
        {
            // Configuration POCOs
            services.Configure<DaemonOptions>(context.Configuration.GetSection(DaemonOptions.SectionName));
            services.Configure<ResourceManagerOptions>(context.Configuration.GetSection(ResourceManagerOptions.SectionName));

            // Core Telemetry & GPU Monitor
            services.AddSingleton<IntelGpuMonitor>();
            services.AddSingleton<ISystemMonitor, WindowsSystemMonitor>();

            // Computer-Use Screen Observation & UI Automation
            services.AddSingleton<ObservationBufferManager>();
            services.AddSingleton<IUiAutomationService, WindowsUiAutomationService>();
            services.AddSingleton<IScreenObservationService, Win32ScreenObservationService>();

            // State & Resource Management
            services.AddSingleton<IStateManager, StateManager>();
            services.AddSingleton<IResourceManager, ResourceManager>();

            // Research Evidence Persistence (SQLite)
            string dbPath = Path.Combine(AppContext.BaseDirectory, ".d-ask-memory.db");
            services.AddSingleton<IEvidenceRecorder>(sp =>
            {
                var logger = sp.GetRequiredService<ILogger<SqliteEvidenceRecorder>>();
                return new SqliteEvidenceRecorder(logger, dbPath);
            });

            // Operational Safety & Policy Engines
            services.AddSingleton<ActionPolicyEngine>(sp =>
            {
                var logger = sp.GetRequiredService<ILogger<ActionPolicyEngine>>();
                var evidence = sp.GetService<IEvidenceRecorder>();
                return new ActionPolicyEngine(logger, evidence);
            });
            services.AddSingleton<ActionExecutionEngine>(sp =>
            {
                var logger = sp.GetRequiredService<ILogger<ActionExecutionEngine>>();
                var stateMgr = sp.GetRequiredService<IStateManager>();
                var policy = sp.GetRequiredService<ActionPolicyEngine>();
                var evidence = sp.GetService<IEvidenceRecorder>();
                return new ActionExecutionEngine(logger, stateMgr, policy, evidence);
            });

            // Local Intelligence Model Runtime
            string defaultModelPath = FindModelPath("qwen2.5-0.5b-instruct-q4_k_m.gguf");

            var manifest = new ModelManifest
            {
                Id = "qwen2.5-0.5b-instruct",
                Name = "Qwen2.5 0.5B Instruct",
                FilePath = defaultModelPath,
                PreferredBackend = InferenceBackend.Vulkan_IrisXe,
                RecommendedGpuLayers = 24,
                Threads = 4,
                ContextSize = 1024
            };

            services.AddSingleton<IModelRuntime>(sp =>
            {
                var logger = sp.GetRequiredService<ILogger<LlamaModelRuntime>>();
                var resMgr = sp.GetRequiredService<IResourceManager>();
                var sysMon = sp.GetRequiredService<ISystemMonitor>();
                var evidence = sp.GetService<IEvidenceRecorder>();
                return new LlamaModelRuntime(logger, resMgr, sysMon, evidence, manifest);
            });

            // IPC Named Pipe Hosted Service
            services.AddHostedService<NamedPipeServer>();
        });

        var host = builder.Build();

        var logger = host.Services.GetRequiredService<ILogger<Program>>();
        logger.LogInformation("Initializing D-ASK Native Assistant Daemon on Windows x64...");

        // Log initial hardware & environment state
        var sysMonitor = host.Services.GetRequiredService<ISystemMonitor>();
        var ram = await sysMonitor.GetRamMetricsAsync();
        var cpu = await sysMonitor.GetCpuMetricsAsync();
        var gpu = await sysMonitor.GetGpuMetricsAsync();

        logger.LogInformation("Host Physical RAM: Total={TotalGB:F2} GB, Available={AvailGB:F2} GB ({LoadPct:F1}% load)",
            ram.TotalBytes / (1024.0 * 1024 * 1024),
            ram.AvailableBytes / (1024.0 * 1024 * 1024),
            ram.LoadPercentage);

        logger.LogInformation("Host GPU Detected: {GpuName} (Shared Memory Architecture: {IsShared})",
            gpu.AdapterName, gpu.IsSharedMemoryArchitecture);

        logger.LogInformation("Daemon process PID: {Pid}", Environment.ProcessId);

        await host.RunAsync();
    }

    private static string FindModelPath(string fileName)
    {
        string candidate = Path.Combine(AppContext.BaseDirectory, "models", fileName);
        if (File.Exists(candidate)) return candidate;

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 7 && dir != null; i++)
        {
            candidate = Path.Combine(dir.FullName, "models", fileName);
            if (File.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, fileName);
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }

        dir = new DirectoryInfo(Directory.GetCurrentDirectory());
        for (int i = 0; i < 7 && dir != null; i++)
        {
            candidate = Path.Combine(dir.FullName, "models", fileName);
            if (File.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, fileName);
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }

        return Path.Combine(AppContext.BaseDirectory, "models", fileName);
    }
}
