using DAsk.Daemon.AgentHost;
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
            services.Configure<AgentHostOptions>(context.Configuration.GetSection(AgentHostOptions.SectionName));

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
                // Phase 4B-2A: window-bound approvals are re-verified against the live OS window when consumed.
                return new ActionPolicyEngine(logger, evidence, sp.GetRequiredService<IWindowSource>());
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

            // Phase 7B.1b: read-only desktop intelligence for the agent (list and inspect windows). No input of any kind.
            services.AddSingleton<IWindowSource, Win32WindowSource>();
            services.AddSingleton<DAsk.Daemon.Automation.Desktop.IDesktopReadService>(sp => sp.GetRequiredService<DAsk.Daemon.Automation.Desktop.DesktopReadService>());
            services.AddSingleton(sp =>
            {
                var hostOpts = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<AgentHostOptions>>().Value;
                return new DAsk.Daemon.Automation.Desktop.DesktopReadService(
                    sp.GetRequiredService<IWindowSource>(),
                    sp.GetRequiredService<IUiAutomationService>(),
                    new DAsk.Daemon.Automation.Desktop.DesktopReadOptions
                    {
                        AllowedProcessIds = new HashSet<int>(hostOpts.DesktopReadAllowedProcessIds),
                        // Resolved per call: the agent host's pid changes when it restarts.
                        OwnProcessIds = () => sp.GetService<AgentHostManager>()?.HostPid is int pid ? new[] { pid } : Array.Empty<int>(),
                    },
                    logger: sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Desktop.DesktopReadService>>());
            });

            // Phase 7B.2/7B.3: approval-gated window operations. Executed only when AgentHost:DesktopActionExecution is true.
            services.AddSingleton<DAsk.Daemon.Automation.Desktop.IDesktopActionRequestService>(sp =>
            {
                var engine = sp.GetRequiredService<ActionExecutionEngine>();
                var hostOpts = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<AgentHostOptions>>().Value;
                // Windows this daemon opened for a task: the typing tools prefer them (same handle, pid and creation time).
                var launchedWindows = new DAsk.Daemon.Automation.Desktop.LaunchedWindowRegistry();
                // P1/P2: guarded element-bound input beside the window operations. Mouse and keyboard are separate policies.
                var input = new DAsk.Daemon.Automation.Input.GuardedInputRequestService(
                    sp.GetRequiredService<DAsk.Daemon.Automation.Desktop.DesktopReadService>(),
                    sp.GetRequiredService<IUiAutomationService>(),
                    sp.GetRequiredService<ActionPolicyEngine>(),
                    () => engine.IsEmergencyStopped,
                    () => engine.CurrentStopGeneration,
                    sp.GetService<IEvidenceRecorder>(),
                    sessionId => sp.GetRequiredService<HudLivenessMonitor>().IsLive(sessionId),
                    new DAsk.Daemon.Automation.Input.Win32DesktopInputPlatform(),
                    new DAsk.Daemon.Automation.Input.GuardedInputOptions { MouseEnabled = hostOpts.DesktopMouseInput, KeyboardEnabled = hostOpts.DesktopKeyboardInput },
                    sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Input.GuardedInputRequestService>>(),
                    launchedWindows);
                // desktop.launch_app: open one application from the daemon's fixed list after approval; success only on a NEW window.
                var appLaunch = new DAsk.Daemon.Automation.Desktop.AppLaunchRequestService(
                    sp.GetRequiredService<DAsk.Daemon.Automation.Desktop.DesktopReadService>(),
                    sp.GetRequiredService<ActionPolicyEngine>(),
                    () => engine.IsEmergencyStopped,
                    () => engine.CurrentStopGeneration,
                    sp.GetService<IEvidenceRecorder>(),
                    sessionId => sp.GetRequiredService<HudLivenessMonitor>().IsLive(sessionId),
                    new DAsk.Daemon.Automation.Desktop.AppLaunchOptions
                    {
                        Enabled = hostOpts.DesktopAppLaunch,
                        // Any installed application (Start menu, App Paths, packaged apps, Windows tools), resolved by name; Settings pages.
                        Catalog = new DAsk.Daemon.Automation.Desktop.InstalledAppCatalog(new DAsk.Daemon.Automation.Desktop.Win32InstalledAppSource()),
                        WebSearchAllowed = hostOpts.WebSearch,   // offline-first: off unless explicitly enabled
                    },
                    launchedWindows,
                    sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Desktop.AppLaunchRequestService>>());
                // Browser stage 2: approval authority for D-ASK's private browser (the agent host performs, then verifies).
                var browserActions = new DAsk.Daemon.Automation.Browser.BrowserActionRequestService(
                    sp.GetRequiredService<ActionPolicyEngine>(),
                    () => engine.IsEmergencyStopped,
                    () => engine.CurrentStopGeneration,
                    sp.GetService<IEvidenceRecorder>(),
                    hostOpts.BrowserActions,
                    logger: sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Browser.BrowserActionRequestService>>());
                // File organisation: the daemon validates, asks for approval of the exact moves, performs them and keeps an undo journal.
                var fileOrganize = new DAsk.Daemon.Automation.Files.FileOrganizeRequestService(
                    sp.GetRequiredService<ActionPolicyEngine>(),
                    () => engine.IsEmergencyStopped,
                    () => engine.CurrentStopGeneration,
                    sp.GetService<IEvidenceRecorder>(),
                    new DAsk.Daemon.Automation.Files.FileOrganizeOptions
                    {
                        Enabled = hostOpts.FileOrganize,
                        Roots = hostOpts.FileOrganizeRoots,
                        JournalDir = string.IsNullOrWhiteSpace(hostOpts.FileOrganizeJournalDir)
                            ? new DAsk.Daemon.Automation.Files.FileOrganizeOptions().JournalDir : hostOpts.FileOrganizeJournalDir!,
                    },
                    logger: sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Files.FileOrganizeRequestService>>());
                var workflows = sp.GetRequiredService<DAsk.Daemon.Automation.Workflows.WorkflowService>();
                // Plugins: the daemon validates and approves plugin folders; the agent host runs approved ones in its sandbox.
                var pluginDefaults = new DAsk.Daemon.Automation.Plugins.PluginOptions();
                var plugins = new DAsk.Daemon.Automation.Plugins.PluginService(
                    sp.GetRequiredService<ActionPolicyEngine>(), () => engine.IsEmergencyStopped, () => engine.CurrentStopGeneration, sp.GetService<IEvidenceRecorder>(),
                    new DAsk.Daemon.Automation.Plugins.PluginOptions
                    {
                        Enabled = hostOpts.Plugins,
                        PluginsDir = string.IsNullOrWhiteSpace(hostOpts.PluginsDir) ? pluginDefaults.PluginsDir : hostOpts.PluginsDir!,
                        ApprovedPath = string.IsNullOrWhiteSpace(hostOpts.PluginsApprovedPath) ? pluginDefaults.ApprovedPath : hostOpts.PluginsApprovedPath!,
                    },
                    logger: sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Plugins.PluginService>>());
                // Vision: read-only, offline text recognition of one named window (Windows OCR via dask-ocr).
                var windowText = new DAsk.Daemon.Automation.Desktop.WindowTextReadService(
                    sp.GetRequiredService<DAsk.Daemon.Automation.Desktop.DesktopReadService>(),
                    new DAsk.Daemon.Automation.Desktop.WindowTextReadOptions { Enabled = hostOpts.DesktopOcr, HelperPath = hostOpts.DesktopOcrHelperPath },
                    sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Desktop.WindowTextReadService>>());
                // Notes: the daemon validates the title and exact text, asks for approval, writes ONE new file in the notes folder and verifies it.
                var notes = new DAsk.Daemon.Automation.Files.NoteCreateRequestService(
                    sp.GetRequiredService<ActionPolicyEngine>(), () => engine.IsEmergencyStopped, () => engine.CurrentStopGeneration, sp.GetService<IEvidenceRecorder>(),
                    new DAsk.Daemon.Automation.Files.NoteOptions
                    {
                        Enabled = hostOpts.Notes,
                        NotesDir = string.IsNullOrWhiteSpace(hostOpts.NotesDir) ? new DAsk.Daemon.Automation.Files.NoteOptions().NotesDir : hostOpts.NotesDir!,
                    },
                    logger: sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Files.NoteCreateRequestService>>());
                // Office: a new Word document / Excel workbook with exactly the approved content, verified by reading the saved file back.
                var office = new DAsk.Daemon.Automation.Office.OfficeDocumentService(
                    sp.GetRequiredService<ActionPolicyEngine>(),
                    () => engine.IsEmergencyStopped,
                    () => engine.CurrentStopGeneration,
                    sp.GetService<IEvidenceRecorder>(),
                    sessionId => sp.GetRequiredService<HudLivenessMonitor>().IsLive(sessionId),
                    new DAsk.Daemon.Automation.Office.OfficeDocumentOptions { Enabled = hostOpts.OfficeDocuments },
                    sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Office.OfficeDocumentService>>());
                // Developer tasks: build or test ONE project in an allowed folder with the daemon's fixed command, after approval.
                var devTasks = new DAsk.Daemon.Automation.Dev.DevTaskService(
                    sp.GetRequiredService<ActionPolicyEngine>(),
                    () => engine.IsEmergencyStopped,
                    () => engine.CurrentStopGeneration,
                    sp.GetService<IEvidenceRecorder>(),
                    sessionId => sp.GetRequiredService<HudLivenessMonitor>().IsLive(sessionId),
                    new DAsk.Daemon.Automation.Dev.DevTaskOptions { Enabled = hostOpts.DevProjectRoots.Length > 0, Roots = hostOpts.DevProjectRoots },
                    sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Dev.DevTaskService>>());
                // Shared approval pathway for the 2026-11-14 services (clipboard, Windows administration, the user's Chrome, code edits).
                DAsk.Daemon.Automation.Policy.ApprovalGate Gate(string source) => new(
                    sp.GetRequiredService<ActionPolicyEngine>(), () => engine.IsEmergencyStopped, () => engine.CurrentStopGeneration, sp.GetService<IEvidenceRecorder>(),
                    sessionId => sp.GetRequiredService<HudLivenessMonitor>().IsLive(sessionId), source, sp.GetRequiredService<ILoggerFactory>().CreateLogger(source));
                var clipboard = new DAsk.Daemon.Automation.Input.ClipboardService(Gate("Clipboard"), new DAsk.Daemon.Automation.Input.Win32ClipboardPlatform(),
                    new DAsk.Daemon.Automation.Input.ClipboardOptions { Enabled = hostOpts.Clipboard }, sp.GetRequiredService<ILoggerFactory>().CreateLogger("Clipboard"));
                var extra = new List<DAsk.Daemon.Automation.Desktop.IDesktopActionRequestService> { clipboard };
                extra.AddRange(DAsk.Daemon.Automation.ExtraServices.Create(sp, hostOpts, Gate, engine));
                return new DAsk.Daemon.Automation.Input.CompositeDesktopActionRequestService(new DAsk.Daemon.Automation.Desktop.IDesktopActionRequestService[] { input, appLaunch, browserActions, fileOrganize, notes, workflows, plugins, windowText, office, devTasks }.Concat(extra).Append(new DAsk.Daemon.Automation.Desktop.DesktopActionRequestService(
                    sp.GetRequiredService<DAsk.Daemon.Automation.Desktop.DesktopReadService>(),
                    sp.GetRequiredService<ActionPolicyEngine>(),
                    () => engine.IsEmergencyStopped,
                    () => engine.CurrentStopGeneration,
                    sp.GetService<IEvidenceRecorder>(),
                    // Phase 7B.3: execution only when configured; the executor makes one Win32 call per approved action.
                    new DAsk.Daemon.Automation.Desktop.DesktopActionOptions { ExecutionEnabled = hostOpts.DesktopActionExecution },
                    sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Desktop.DesktopActionRequestService>>(),
                    new DAsk.Daemon.Automation.Desktop.Win32WindowOperationExecutor(),
                    // The owner's HUD lease, checked immediately before acting (resolved per call).
                    sessionId => sp.GetRequiredService<HudLivenessMonitor>().IsLive(sessionId))).ToArray());
            });

            // Workflows: one daemon-owned store, shared by the agent's tools and the scheduler (which only submits ordinary tasks).
            services.AddSingleton(sp =>
            {
                var engine = sp.GetRequiredService<ActionExecutionEngine>();
                var hostOpts = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<AgentHostOptions>>().Value;
                return new DAsk.Daemon.Automation.Workflows.WorkflowService(
                    sp.GetRequiredService<ActionPolicyEngine>(), () => engine.IsEmergencyStopped, () => engine.CurrentStopGeneration,
                    sp.GetService<IEvidenceRecorder>(),
                    new DAsk.Daemon.Automation.Workflows.WorkflowOptions
                    {
                        Enabled = hostOpts.Workflows,
                        StorePath = string.IsNullOrWhiteSpace(hostOpts.WorkflowStorePath) ? new DAsk.Daemon.Automation.Workflows.WorkflowOptions().StorePath : hostOpts.WorkflowStorePath!,
                    },
                    logger: sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Workflows.WorkflowService>>());
            });
            services.AddHostedService(sp => DAsk.Daemon.Automation.Workflows.WorkflowScheduler.ForAgentHost(
                sp.GetRequiredService<DAsk.Daemon.Automation.Workflows.WorkflowService>(),
                sp.GetRequiredService<AgentHostManager>(),
                () => sp.GetRequiredService<HudLivenessMonitor>().LiveSessions,
                () => sp.GetRequiredService<ActionExecutionEngine>().IsEmergencyStopped,
                sp.GetRequiredService<ILogger<DAsk.Daemon.Automation.Workflows.WorkflowScheduler>>()));

            // Stdio agent host: owns the local TypeScript agent runtime process. Hosted so it stops with the daemon.
            services.AddSingleton<AgentHostManager>();
            services.AddHostedService(sp => sp.GetRequiredService<AgentHostManager>());

            // HUD liveness (Phase 7B.1a): derives panic-hotkey availability from live, heartbeating HUD sessions.
            services.AddSingleton(sp =>
            {
                var opts = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<DaemonOptions>>().Value;
                return new HudLivenessMonitor(
                    sp.GetRequiredService<ILogger<HudLivenessMonitor>>(),
                    sp.GetRequiredService<ActionExecutionEngine>(),
                    sp.GetRequiredService<ActionPolicyEngine>(),
                    sp.GetService<IEvidenceRecorder>(),
                    opts.HeartbeatLeaseMs,
                    opts.HeartbeatMaxSkewMs);
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
