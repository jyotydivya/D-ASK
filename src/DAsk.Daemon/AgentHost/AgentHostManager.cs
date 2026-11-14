using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.ModelRuntime;
using DAsk.Protocol.IPC.Messages;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace DAsk.Daemon.AgentHost;

public class AgentHostOptions
{
    public const string SectionName = "AgentHost";

    public bool Enabled { get; set; } = true;
    /// <summary>Start the host with the daemon. By default it starts on the first task, so it costs nothing until used.</summary>
    public bool AutoStart { get; set; } = false;
    public string NodePath { get; set; } = "node";
    /// <summary>Relative to the repository root.</summary>
    public string EntryPath { get; set; } = "dist/agent-host/agent/host/stdioHost.js";
    /// <summary>Found by walking up from the daemon when unset.</summary>
    public string? RepoRoot { get; set; }
    /// <summary>Set in a packaged install: the host never starts unless the package manifest check passes.</summary>
    public bool RequireVerifiedPackage { get; set; } = false;
    /// <summary>Relative to the root. See PackageVerifier.</summary>
    public string? ManifestPath { get; set; }
    public string? ManifestSha256 { get; set; }
    public int ReadyTimeoutMs { get; set; } = 15_000;
    public int RequestTimeoutMs { get; set; } = 5_000;
    /// <summary>Must exceed the runtime's own 300 s limit, so the runtime normally ends the task first.</summary>
    public int TaskTimeoutMs { get; set; } = 330_000;
    public int CancelGraceMs { get; set; } = 5_000;
    public int HealthIntervalMs { get; set; } = 5_000;
    public int MaxMissedHealth { get; set; } = 2;
    public int MaxRestarts { get; set; } = 3;
    public int RestartWindowMs { get; set; } = 300_000;
    public int RestartBackoffMs { get; set; } = 1_000;
    public bool AutoRestart { get; set; } = true;
    public int ShutdownTimeoutMs { get; set; } = 5_000;
    /// <summary>The host must acknowledge Emergency Stop within this time or its process tree is killed.</summary>
    public int StopAckTimeoutMs { get; set; } = 1_000;
    public string? ModelId { get; set; }
    public string? Backend { get; set; }
    /// <summary>EXPERIMENTAL, off by default: refuse clearly unsupported requests before planning.</summary>
    public bool ExperimentalCapabilityCheck { get; set; } = false;
    /// <summary>EXPERIMENTAL, off by default: prefer 3B only when the memory guard admits it, else 0.5B.</summary>
    public bool ExperimentalModelTiers { get; set; } = false;
    /// <summary>Added last to the host's environment. Tests only (the checked-in configuration sets none).</summary>
    public Dictionary<string, string> ExtraEnvironment { get; set; } = new();

    /// <summary>
    /// Phase 7B.1b: offer the agent the read-only desktop tools (list and inspect windows) over protocol v2.
    /// Read-only by construction; set false to withhold them entirely.
    /// </summary>
    public bool DesktopRead { get; set; } = true;

    /// <summary>Tests only: when non-empty, the desktop tools observe only these process ids (keeps personal windows out of test runs).</summary>
    public List<int> DesktopReadAllowedProcessIds { get; set; } = new();

    /// <summary>
    /// Phase 7B.2: offer the window-operation requests (focus, minimize/maximize/restore). Each needs the user's explicit
    /// approval in the HUD; there is no executor in this version, so an approved request is consumed and not performed.
    /// </summary>
    public bool DesktopActionRequests { get; set; } = true;

    /// <summary>
    /// Phase 7B.3: actually perform approved window operations (one Win32 call each) and verify them. Off unless configured
    /// (safety contracts: executor behind a disabled-by-default switch). When off, approvals are consumed and nothing is done.
    /// </summary>
    public bool DesktopActionExecution { get; set; } = false;
    /// <summary>P1: perform approved element clicks. Separate policy from keyboard input; off by default.</summary>
    public bool DesktopMouseInput { get; set; } = false;
    /// <summary>P2: perform approved text entry and key chords. Separate policy from mouse input; off by default.</summary>
    public bool DesktopKeyboardInput { get; set; } = false;
    /// <summary>Offer desktop.launch_app: open one application from the daemon's fixed list (Notepad), after the user approves it. Off by default.</summary>
    public bool DesktopAppLaunch { get; set; } = false;
    /// <summary>Offer office.create_word_document / office.create_excel_workbook: a new document in Documents with exactly the approved content. Off by default.</summary>
    public bool OfficeDocuments { get; set; } = false;
    /// <summary>Allow "open &lt;browser&gt; and search for …" (a web search needs internet access). Off by default (offline-first).</summary>
    public bool WebSearch { get; set; } = false;
    /// <summary>desktop.clipboard_read / desktop.clipboard_write, each approved separately in the HUD. Off by default.</summary>
    public bool Clipboard { get; set; } = false;
    /// <summary>Windows administration (processes, services, network, audio, display, startup apps, power), reads free, changes approved. Off by default.</summary>
    public bool SystemAdmin { get; set; } = false;
    /// <summary>Service names D-ASK may start or stop (each after approval). Empty: services can only be listed and inspected.</summary>
    public string[] SystemAdminServices { get; set; } = Array.Empty<string>();
    /// <summary>The user's own Google Chrome through the D-ASK extension and Chrome Native Messaging (no debugging port). Off by default.</summary>
    public bool ChromeControl { get; set; } = false;
    /// <summary>dask-chrome-host.exe (the only process allowed on the broker pipe); default: the DAsk.ChromeHost Release build beside this repo.</summary>
    public string? ChromeHostPath { get; set; }
    /// <summary>The D-ASK extension id (from the key in extensions/dask-chrome/manifest.json).</summary>
    public string ChromeExtensionId { get; set; } = "lkiheaganheamabgecpnafiefeiadlpi";
    /// <summary>The broker pipe the native-messaging host connects to; default derived from the user SID.</summary>
    public string? ChromeBrokerPipe { get; set; }
    /// <summary>Folders inside which D-ASK may apply approved code edits (dev.edit_file). Empty: off.</summary>
    public string[] DevEditRoots { get; set; } = Array.Empty<string>();
    /// <summary>Folders whose projects D-ASK may build or test (dev.run_task), each run after approval. Empty (default): off.</summary>
    public string[] DevProjectRoots { get; set; } = Array.Empty<string>();
    /// <summary>Browser stage 1: the agent may read web pages the user names (local Chromium, network locked to that site). Off by default.</summary>
    public bool BrowserRead { get; set; } = false;
    /// <summary>Browser stage 2: approval-gated clicks and field fills in D-ASK's private browser. Off by default.</summary>
    public bool BrowserActions { get; set; } = false;
    /// <summary>Browser profile: false = a fresh in-memory profile per task (default); true = D-ASK's own persistent profile
    /// (never the user's everyday browser profile), so a manual sign-in can be kept. Opt-in.</summary>
    public bool BrowserPersistentProfile { get; set; } = false;
    /// <summary>Local persistent memory (SQLite in %LOCALAPPDATA%\D-ASK, no cloud embeddings): remember / recall / forget on request. Off by default.</summary>
    public bool Memory { get; set; } = false;
    /// <summary>File organisation: the agent may ASK to move files of ONE folder into subfolders of that folder; the daemon
    /// validates, shows the exact moves for approval, performs them (never overwriting) and keeps an undo journal. Off by default.</summary>
    public bool FileOrganize { get; set; } = false;
    /// <summary>The only folders whose files may be organised (and their subfolders). Empty: nothing may be organised.</summary>
    public List<string> FileOrganizeRoots { get; set; } = new();
    /// <summary>Undo journals; default %LOCALAPPDATA%\D-ASK\file-undo.</summary>
    public string? FileOrganizeJournalDir { get; set; }
    /// <summary>Reusable workflows and approved schedules (daemon-owned store and clock). Off by default.</summary>
    public bool Workflows { get; set; } = false;
    /// <summary>Workflow store; default %LOCALAPPDATA%\D-ASK\workflows.json.</summary>
    public string? WorkflowStorePath { get; set; }
    /// <summary>
    /// Where the last finished task results are kept (outcome + response, at most 40, local only), so a HUD that was closed or killed right
    /// after a task finished can recover the real result instead of "result unknown". Null: %LOCALAPPDATA%\D-ASK\task-results.json.
    /// </summary>
    public string? TaskResultsPath { get; set; }
    /// <summary>Dynamic plugins: approved, compute-only, sandboxed tools. Off by default.</summary>
    public bool Plugins { get; set; } = false;
    /// <summary>Plugin folders; default %LOCALAPPDATA%\D-ASK\plugins.</summary>
    public string? PluginsDir { get; set; }
    /// <summary>The approved list (daemon-written, host-read); default %LOCALAPPDATA%\D-ASK\plugins-approved.json.</summary>
    public string? PluginsApprovedPath { get; set; }
    /// <summary>desktop.read_text: offline text recognition of ONE window the user names (read-only). Off by default.</summary>
    public bool DesktopOcr { get; set; } = false;
    /// <summary>dask-ocr.exe; default: beside the HUD build.</summary>
    public string? DesktopOcrHelperPath { get; set; }
    /// <summary>notes.create: the agent may ASK to create ONE new text note (title + exact text) in the notes folder; the
    /// daemon shows the exact title and text for approval, writes it (never overwriting) and verifies it. Off by default.</summary>
    public bool Notes { get; set; } = false;
    /// <summary>The only folder notes are written to; default %USERPROFILE%\Documents\D-ASK Notes.</summary>
    public string? NotesDir { get; set; }
}

public enum AgentHostState { Stopped, Starting, Ready, Restarting, Failed }

public sealed class AgentHostProtocolException : Exception
{
    public string Code { get; }
    public AgentHostProtocolException(string code, string message) : base(message) => Code = code;
}

public sealed record AgentSubmitResult(bool Accepted, string? TaskId, string? RejectionCode, string? ErrorMessage);

public sealed class AgentTaskRecord
{
    public required string TaskId { get; init; }
    public required string OwnerSessionId { get; init; }
    public required long InstanceEpoch { get; init; }
    public DateTime SubmittedAtUtc { get; } = DateTime.UtcNow;
    public volatile string State = "running";
    public AgentTaskResultNotification? Result;
    internal CancellationTokenSource? Watchdog;
    /// <summary>Phase 7B.1b: cancelled when the task ends or is cancelled, so no daemon call outlives its task.</summary>
    internal readonly CancellationTokenSource CallsCts = new();
    internal string? ActiveCallId;
    /// <summary>Phase 7B.2: approval-gated requests made by this task. At most one: the user is never asked twice per task.</summary>
    internal int ActionRequests;
    /// <summary>P1/P2: element-bound input requests by this task (a separate budget; each needs its own approval).</summary>
    internal int InputRequests;
}

/// <summary>
/// Owns the stdio agent host: one process at a time, in a Job Object. The trusted integration boundary:
/// it decides who may submit (authenticated pipe sessions only, owner-bound tasks), pushes Emergency
/// Stop state to the host on every start, and never re-submits a task. A task in flight when the host
/// dies ends as interrupted; because the host holds no approval capability and tasks are never replayed,
/// a restart can neither repeat an action nor bypass an approval.
/// </summary>
public sealed partial class AgentHostManager : IHostedService, IAsyncDisposable
{
    private const int MaxOutputLineChars = 2 * 1024 * 1024;
    private const int MaxRetainedTasks = 128;
    private const int MaxObjectiveChars = 4_000;
    private static readonly Regex CloudEnv = new(@"(_API_KEY|_API_TOKEN|_AUTH_TOKEN)$|^(OPENAI|GROQ|OPENROUTER|GEMINI|ANTHROPIC|GOOGLE_API)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly AgentHostOptions _options;
    private readonly ILogger<AgentHostManager> _logger;
    private readonly ActionExecutionEngine? _engine;
    private readonly IModelRuntime? _modelRuntime;
    private readonly SemaphoreSlim _lifecycle = new(1, 1);
    private readonly ConcurrentDictionary<string, AgentTaskRecord> _tasks = new();
    private readonly List<DateTime> _crashes = new();
    private readonly object _crashLock = new();

    private HostInstance? _instance;
    private long _epoch;
    private volatile AgentHostState _state = AgentHostState.Stopped;
    private int _restarts;
    private int _processesStarted;
    private int? _lastHostPid;
    private string? _lastError;
    private volatile string? _modelState;
    private volatile string? _modelId;
    private volatile bool _disposing;
    private Task _control = Task.CompletedTask;
    private readonly object _controlLock = new();

    public event EventHandler<AgentTaskProgressEventArgs>? TaskProgress;
    public event EventHandler<AgentTaskRecord>? TaskFinished;

    public AgentHostManager(IOptions<AgentHostOptions> options, ILogger<AgentHostManager> logger, ActionExecutionEngine? engine = null, IModelRuntime? modelRuntime = null,
        Automation.Desktop.IDesktopReadService? desktop = null, Automation.Desktop.IDesktopActionRequestService? actions = null)
    {
        _desktop = desktop;
        _actions = actions;
        _options = options.Value;
        _logger = logger;
        _engine = engine;
        _modelRuntime = modelRuntime;
        if (_engine != null)
        {
            _engine.EmergencyStopActivated += (_, gen) => Enqueue(() => PushStopAsync(gen));
            _engine.ExecutionResumed += (_, gen) => Enqueue(() => PushResumeAsync(gen));
        }
    }

    public AgentHostState State => _state;
    public int? HostPid => _instance?.Pid;
    public int Restarts => _restarts;
    /// <summary>How many host processes this manager has ever launched.</summary>
    public int ProcessesStarted => _processesStarted;
    /// <summary>The most recently launched host process, even if it has since been discarded.</summary>
    public int? LastHostPid => _lastHostPid;
    public bool Enabled => _options.Enabled;
    private bool EmergencyStopped => _engine?.IsEmergencyStopped ?? false;
    private ulong StopGeneration => _engine?.CurrentStopGeneration ?? 0;

    /// <summary>
    /// True while the host holds, or is about to load, the local model. The daemon's own direct inference
    /// path refuses during this time so two model copies are never loaded together.
    /// </summary>
    public bool OwnsLocalModel =>
        _tasks.Values.Any(t => t.State != "finished") ||
        _modelState is "loading" or "ready" or "degraded";

    public AgentHostHealthResponse Health() => new()
    {
        Enabled = _options.Enabled,
        State = _state.ToString().ToLowerInvariant(),
        Pid = HostPid,
        Restarts = _restarts,
        ActiveTaskId = _tasks.Values.FirstOrDefault(t => t.State != "finished")?.TaskId,
        EmergencyStopped = EmergencyStopped,
        LastError = _lastError,
        ModelState = _modelState,
        ModelId = _modelId,
    };

    // ── IHostedService ───────────────────────────────────────────────────────

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (_options.Enabled && _options.AutoStart)
        {
            _ = Task.Run(async () =>
            {
                try { await EnsureStartedAsync(CancellationToken.None); }
                catch (Exception ex) { _logger.LogWarning("[AgentHost] Auto-start failed: {Error}", ex.Message); }
            }, CancellationToken.None);
        }
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => ShutdownAsync("daemon stopping");

    public async ValueTask DisposeAsync()
    {
        await ShutdownAsync("disposed");
    }

    // ── Public operations ────────────────────────────────────────────────────

    /// <summary>Starts the host if needed and resolves once it has proved readiness. Never starts a second one.</summary>
    public async Task EnsureStartedAsync(CancellationToken cancellationToken)
    {
        if (!_options.Enabled) throw new AgentHostProtocolException("agent_host_disabled", "The agent host is disabled by configuration.");
        await _lifecycle.WaitAsync(cancellationToken);
        try
        {
            if (_disposing) throw new AgentHostProtocolException("host_unavailable", "The daemon is shutting down.");
            if (_instance is { IsAlive: true }) return;
            await StartInstanceLockedAsync(cancellationToken);
        }
        finally
        {
            _lifecycle.Release();
        }
    }

    public async Task<AgentSubmitResult> SubmitAsync(string objective, string ownerSessionId, CancellationToken cancellationToken = default)
    {
        if (!_options.Enabled) return new(false, null, "agent_host_disabled", "The agent host is disabled by configuration.");
        if (string.IsNullOrWhiteSpace(objective) || objective.Length > MaxObjectiveChars)
            return new(false, null, "invalid_request", $"The objective must be 1 to {MaxObjectiveChars} characters.");
        // Daemon-side check: the host enforces this too, but a stop must hold even if the host is wrong.
        if (EmergencyStopped) return new(false, null, "emergency_stopped", "Emergency Stop is active; new tasks are refused.");

        // One model owner: release the daemon's own model first, and do not interrupt a running generation.
        if (_modelRuntime != null)
        {
            if (_modelRuntime.State is ModelRuntimeState.Generating or ModelRuntimeState.Loading)
                return new(false, null, "daemon_model_busy", "The daemon's own model is in use; try again when it finishes.");
            if (_modelRuntime.State == ModelRuntimeState.Ready)
            {
                _logger.LogInformation("[AgentHost] Unloading the daemon's model: llama-server is the model owner in agent mode.");
                await _modelRuntime.UnloadModelAsync("agent mode", cancellationToken);
            }
        }

        try
        {
            await EnsureStartedAsync(cancellationToken);
        }
        catch (AgentHostProtocolException ex) { return new(false, null, ex.Code, ex.Message); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError("[AgentHost] Host unavailable: {Error}", ex.Message);
            return new(false, null, "host_unavailable", ex.Message);
        }

        var inst = _instance;
        if (inst is not { IsAlive: true }) return new(false, null, "host_unavailable", "The agent host is not running.");

        string taskId = "t" + Guid.NewGuid().ToString("N");
        // Registered before sending, so an immediate finish cannot race past the record.
        var rec = new AgentTaskRecord { TaskId = taskId, OwnerSessionId = ownerSessionId, InstanceEpoch = inst.Epoch };
        NoteOwner(ownerSessionId);
        _tasks[taskId] = rec;
        try
        {
            await inst.RequestAsync("submit", new { taskId, objective }, _options.RequestTimeoutMs);
        }
        catch (AgentHostProtocolException ex)
        {
            _tasks.TryRemove(taskId, out _);
            return new(false, null, ex.Code, ex.Message);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Unknown whether the host accepted it. It is NEVER sent again: report it as interrupted.
            if (rec.State != "finished") FinishInterrupted(rec, "host_unavailable", $"The agent host did not confirm the task: {ex.Message}");
            return new(false, null, "host_unavailable", ex.Message);
        }
        ArmTaskWatchdog(rec, inst);
        PruneTasks();
        return new(true, taskId, null, null);
    }

    public AgentTaskRecord? GetTask(string taskId, string sessionId) =>
        _tasks.TryGetValue(taskId, out var r) && r.OwnerSessionId == sessionId ? r : null;

    // ── Finished results that survive a HUD (or daemon) restart ──────────────────────────────────────────────
    private readonly object _resultsGate = new();
    private const int MaxKeptResults = 40;
    private string ResultsPath => string.IsNullOrWhiteSpace(_options.TaskResultsPath)
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D-ASK", "task-results.json") : _options.TaskResultsPath!;
    public sealed record KeptResult(string TaskId, string Outcome, string Response, bool Interrupted, DateTime FinishedUtc, string? Owner = null);
    /// <summary>Sessions that submitted tasks and are still connected: their results are never given to another session (recovery is only after the owner is gone).</summary>
    private readonly HashSet<string> _openSessions = new(StringComparer.Ordinal);
    private void NoteOwner(string sessionId) { lock (_resultsGate) _openSessions.Add(sessionId); }

    private void KeepResult(AgentTaskResultNotification r, string owner)
    {
        try
        {
            lock (_resultsGate)
            {
                var all = ReadKept();
                all.RemoveAll(k => k.TaskId == r.TaskId);
                all.Add(new KeptResult(r.TaskId, r.Outcome, r.Response.Length > 4000 ? r.Response[..4000] : r.Response, r.Interrupted, DateTime.UtcNow, owner));
                if (all.Count > MaxKeptResults) all.RemoveRange(0, all.Count - MaxKeptResults);
                Directory.CreateDirectory(Path.GetDirectoryName(ResultsPath)!);
                string tmp = ResultsPath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(all), new UTF8Encoding(false));
                File.Move(tmp, ResultsPath, overwrite: true);
            }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "[AgentHost] Could not keep the finished result for recovery."); }
    }

    private List<KeptResult> ReadKept()
    {
        try { return File.Exists(ResultsPath) ? JsonSerializer.Deserialize<List<KeptResult>>(File.ReadAllText(ResultsPath)) ?? new() : new(); }
        catch { return new(); }
    }

    /// <summary>
    /// The FINISHED result of a task by id, for recovery after a HUD restart. Only when the task is finished AND its owning session is no longer
    /// connected (a closed or killed HUD, or a previous daemon run): a session that is still connected keeps its results to itself, exactly as status
    /// and notifications do. The 128-bit random task id is required as well. Null otherwise.
    /// </summary>
    public AgentTaskResultNotification? RecoverResult(string taskId)
    {
        if (string.IsNullOrWhiteSpace(taskId)) return null;
        if (_tasks.TryGetValue(taskId, out var r))
        {
            lock (_resultsGate) if (_openSessions.Contains(r.OwnerSessionId)) return null;
            return r.State == "finished" && r.Result != null ? r.Result : null;
        }
        KeptResult? k;
        lock (_resultsGate)
        {
            k = ReadKept().FirstOrDefault(x => x.TaskId == taskId);
            if (k?.Owner != null && _openSessions.Contains(k.Owner)) return null;
        }
        return k == null ? null : new AgentTaskResultNotification { TaskId = k.TaskId, Outcome = k.Outcome, Response = k.Response, Interrupted = k.Interrupted };
    }

    public async Task<AgentTaskCancelResponse> CancelAsync(string taskId, string sessionId)
    {
        // Another session's task is indistinguishable from a task that does not exist.
        var rec = GetTask(taskId, sessionId);
        if (rec == null) return new AgentTaskCancelResponse { TaskId = taskId, RejectionCode = "unknown_task" };
        if (rec.State == "finished") return new AgentTaskCancelResponse { TaskId = taskId, RejectionCode = "already_finished" };
        var inst = _instance;
        if (inst is not { IsAlive: true } || inst.Epoch != rec.InstanceEpoch)
            return new AgentTaskCancelResponse { TaskId = taskId, RejectionCode = "host_unavailable" };
        rec.State = "cancelling";
        // Phase 7B.1b: the daemon cancels the task's calls itself; it does not rely on the host relaying the cancel.
        try { rec.CallsCts.Cancel(); } catch (ObjectDisposedException) { }
        try
        {
            await inst.RequestAsync("cancel", new { taskId }, _options.RequestTimeoutMs);
            return new AgentTaskCancelResponse { TaskId = taskId, Cancelling = true };
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[AgentHost] Cancel of {TaskId} failed: {Error}", taskId, ex.Message);
            return new AgentTaskCancelResponse { TaskId = taskId, RejectionCode = "host_unavailable" };
        }
    }

    /// <summary>Fail-closed, like the execution engine: a session's tasks do not outlive it.</summary>
    public void CancelTasksForSession(string sessionId)
    {
        lock (_resultsGate) _openSessions.Remove(sessionId);   // the session is gone: its FINISHED results become recoverable by a later HUD
        foreach (var t in _tasks.Values.Where(t => t.OwnerSessionId == sessionId && t.State != "finished"))
            _ = CancelAsync(t.TaskId, sessionId);
    }

    public async Task ShutdownAsync(string reason)
    {
        _disposing = true;
        await _lifecycle.WaitAsync();
        try
        {
            var inst = _instance;
            _instance = null;
            if (inst is { IsAlive: true })
            {
                _logger.LogInformation("[AgentHost] Shutting down host pid {Pid}: {Reason}", inst.Pid, reason);
                inst.ExpectedExit = true;
                try { await inst.RequestAsync("shutdown", new { }, _options.RequestTimeoutMs); }
                catch (Exception ex) { _logger.LogWarning("[AgentHost] Shutdown request failed: {Error}", ex.Message); }
                if (!await inst.WaitForExitAsync(_options.ShutdownTimeoutMs))
                {
                    _logger.LogWarning("[AgentHost] Host did not exit in time; killing its process tree.");
                    inst.Kill();
                    await inst.WaitForExitAsync(2_000);
                }
                // Anything the host did not report before exiting ends as interrupted.
                FailInFlight(inst.Epoch, "daemon_shutdown", "The daemon shut down while this task was running.");
            }
            _state = AgentHostState.Stopped;
        }
        finally
        {
            _lifecycle.Release();
        }
    }

    // ── Start ────────────────────────────────────────────────────────────────

    private string ResolveRoot()
    {
        if (!string.IsNullOrWhiteSpace(_options.RepoRoot)) return Path.GetFullPath(_options.RepoRoot);
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "agent", "runtime", "inference", "artifacts.json"))) return dir.FullName;
            if (File.Exists(Path.Combine(dir.FullName, "package-manifest.json"))) return dir.FullName;
            dir = dir.Parent;
        }
        throw new AgentHostProtocolException("host_unavailable", "Cannot find the D-ASK repository root.");
    }

    private async Task StartInstanceLockedAsync(CancellationToken cancellationToken)
    {
        // Bounded restarts: a host that keeps dying stays down until the window passes.
        lock (_crashLock)
        {
            _crashes.RemoveAll(c => DateTime.UtcNow - c > TimeSpan.FromMilliseconds(_options.RestartWindowMs));
            if (_crashes.Count > _options.MaxRestarts)
            {
                _state = AgentHostState.Failed;
                throw new AgentHostProtocolException("host_unavailable", $"The agent host crashed {_crashes.Count} times recently; not restarting yet. Last error: {_lastError}");
            }
        }

        _state = AgentHostState.Starting;
        string root = ResolveRoot();
        string entry = Path.GetFullPath(Path.Combine(root, _options.EntryPath));
        if (!File.Exists(entry))
        {
            _state = AgentHostState.Failed;
            _lastError = $"Agent host entry not found: {entry} (run npm run build:agent-host)";
            throw new AgentHostProtocolException("host_unavailable", _lastError);
        }

        // A bare name is looked up on PATH; a relative path is the packaged runtime under the root.
        string nodePath = _options.NodePath;
        bool hasDirectory = nodePath.Contains('/') || nodePath.Contains('\\');
        if (hasDirectory && !Path.IsPathRooted(nodePath)) nodePath = Path.GetFullPath(Path.Combine(root, nodePath));

        if (_options.RequireVerifiedPackage || !string.IsNullOrWhiteSpace(_options.ManifestPath))
        {
            string? problem = string.IsNullOrWhiteSpace(_options.ManifestPath)
                ? "A verified package is required, but no manifest is configured."
                : PackageVerifier.Verify(root, _options.ManifestPath, _options.ManifestSha256, nodePath, _options.EntryPath);
            if (problem != null)
            {
                _state = AgentHostState.Failed;
                _lastError = $"Package check failed: {problem}";
                _logger.LogError("[AgentHost] {Error} The host was not started.", _lastError);
                throw new AgentHostProtocolException("host_unavailable", _lastError);
            }
            _logger.LogInformation("[AgentHost] Package check passed.");
        }

        string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var psi = new ProcessStartInfo
        {
            FileName = nodePath,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
            StandardInputEncoding = new UTF8Encoding(false),
        };
        psi.ArgumentList.Add(entry);

        // A clean environment: no cloud credentials, nothing that can inject code into Node, local only.
        foreach (var key in psi.Environment.Keys.ToList())
            if (CloudEnv.IsMatch(key) || key.Equals("NODE_OPTIONS", StringComparison.OrdinalIgnoreCase) || key.Equals("NODE_PATH", StringComparison.OrdinalIgnoreCase))
                psi.Environment.Remove(key);
        psi.Environment["DASK_INFERENCE"] = "local";
        psi.Environment["DASK_ROOT"] = root;
        psi.Environment["DASK_AGENT_HOST_TOKEN"] = token;
        if (!string.IsNullOrWhiteSpace(_options.ModelId)) psi.Environment["DASK_LOCAL_MODEL"] = _options.ModelId;
        if (!string.IsNullOrWhiteSpace(_options.Backend)) psi.Environment["DASK_LOCAL_BACKEND"] = _options.Backend;
        if (_options.ExperimentalCapabilityCheck) psi.Environment["DASK_EXPERIMENTAL_CAPABILITY_CHECK"] = "1";
        if (_options.ExperimentalModelTiers) psi.Environment["DASK_EXPERIMENTAL_MODEL_TIERS"] = "1";
        if (DesktopEnabled) psi.Environment["DASK_AGENT_DESKTOP"] = "1";
        if (_options.BrowserRead || _options.BrowserActions) psi.Environment["DASK_AGENT_BROWSER"] = "1";
        if (_options.BrowserPersistentProfile) psi.Environment["DASK_BROWSER_PROFILE"] = "persistent";
        if (_options.Memory) psi.Environment["DASK_AGENT_MEMORY"] = "1";
        if (_options.Plugins)
        {
            var defaults = new DAsk.Daemon.Automation.Plugins.PluginOptions();
            psi.Environment["DASK_AGENT_PLUGINS"] = "1";
            psi.Environment["DASK_PLUGINS_DIR"] = string.IsNullOrWhiteSpace(_options.PluginsDir) ? defaults.PluginsDir : _options.PluginsDir!;
            psi.Environment["DASK_PLUGINS_APPROVED"] = string.IsNullOrWhiteSpace(_options.PluginsApprovedPath) ? defaults.ApprovedPath : _options.PluginsApprovedPath!;
        }
        foreach (var (k, v) in _options.ExtraEnvironment) psi.Environment[k] = v;
        // Notes: the host re-reads the note the daemon wrote, to verify it independently; it only needs to know the folder.
        if (_options.Notes)
            psi.Environment["DASK_NOTES_DIR"] = string.IsNullOrWhiteSpace(_options.NotesDir) ? new DAsk.Daemon.Automation.Files.NoteOptions().NotesDir : _options.NotesDir!;
        // File organisation: the host must read the names of the files it plans to move, so the folders the user allowed to be
        // organised are also readable (read-only) for the host. The daemon still validates and performs every move itself.
        if (_options.FileOrganize && _options.FileOrganizeRoots.Count > 0)
        {
            string existing = psi.Environment.TryGetValue("DASK_FS_ROOTS", out var e) && !string.IsNullOrWhiteSpace(e) ? e! : "";
            psi.Environment["DASK_FS_ROOTS"] = string.Join(";", new[] { existing }.Concat(_options.FileOrganizeRoots).Where(s => !string.IsNullOrWhiteSpace(s)));
        }

        long epoch = Interlocked.Increment(ref _epoch);
        var sw = Stopwatch.StartNew();
        Process process;
        try
        {
            process = Process.Start(psi) ?? throw new InvalidOperationException("Process.Start returned null");
        }
        catch (Exception ex)
        {
            _state = AgentHostState.Failed;
            _lastError = $"Could not start '{_options.NodePath}': {ex.Message}";
            RecordCrash();
            throw new AgentHostProtocolException("host_unavailable", _lastError);
        }

        Interlocked.Increment(ref _processesStarted);
        _lastHostPid = process.Id;
        // One job per host process: closing it takes any surviving child (llama-server) down with the host,
        // and the OS closes it if the daemon dies.
        var job = new ProcessJob();
        try { job.Assign(process); }
        catch (Exception ex)
        {
            // Without the job an orphan is possible. Fail closed instead of running unprotected.
            try { process.Kill(entireProcessTree: true); } catch { }
            job.Dispose();
            _state = AgentHostState.Failed;
            _lastError = $"Could not place the agent host in a job object: {ex.Message}";
            throw new AgentHostProtocolException("host_unavailable", _lastError);
        }

        var inst = new HostInstance(process, job, epoch, _logger, OnInstanceEvent, OnInstanceViolation, OnInstanceExit, OnInstanceCall);
        _instance = inst;
        inst.Start();

        try
        {
            using var ready = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            object helloParams = DesktopEnabled
                ? new { token, emergencyStopped = EmergencyStopped, stopGeneration = (long)StopGeneration, desktop = new { proto = 2, tools = OfferedDesktopTools } }
                : new { token, emergencyStopped = EmergencyStopped, stopGeneration = (long)StopGeneration };
            var hello = await inst.RequestAsync("hello", helloParams, _options.ReadyTimeoutMs);
            UpdateModelState(hello);
            if (!hello.TryGetProperty("ready", out var r) || !r.GetBoolean())
                throw new AgentHostProtocolException("host_unavailable", "The host reported it is not ready.");
            NegotiateDesktop(inst, hello);
        }
        catch (Exception ex)
        {
            inst.ExpectedExit = true;
            inst.Kill();
            await inst.WaitForExitAsync(2_000);
            if (ReferenceEquals(_instance, inst)) _instance = null;
            _state = AgentHostState.Failed;
            _lastError = $"Agent host startup failed: {ex.Message}";
            RecordCrash();
            _logger.LogError("[AgentHost] {Error}", _lastError);
            throw new AgentHostProtocolException("host_unavailable", _lastError);
        }

        _state = AgentHostState.Ready;
        _lastError = null;
        _logger.LogInformation("[AgentHost] Host ready: pid {Pid}, epoch {Epoch}, {Ms} ms from process start.", inst.Pid, epoch, sw.ElapsedMilliseconds);
        _ = Task.Run(() => HealthLoopAsync(inst), CancellationToken.None);
    }

    // ── Health / hung detection ──────────────────────────────────────────────

    private async Task HealthLoopAsync(HostInstance inst)
    {
        int missed = 0;
        while (inst.IsAlive && !_disposing)
        {
            await Task.Delay(_options.HealthIntervalMs);
            if (!inst.IsAlive || _disposing) return;
            try
            {
                UpdateModelState(await inst.RequestAsync("health", new { }, _options.RequestTimeoutMs));
                missed = 0;
            }
            catch (TimeoutException)
            {
                missed++;
                _logger.LogWarning("[AgentHost] Host pid {Pid} missed a health check ({Missed}/{Max}).", inst.Pid, missed, _options.MaxMissedHealth);
                if (missed >= _options.MaxMissedHealth)
                {
                    KillForRecovery(inst, "host_unresponsive", "The agent host stopped responding.");
                    return;
                }
            }
            catch (Exception) { return; }
        }
    }

    private void UpdateModelState(JsonElement health)
    {
        if (health.TryGetProperty("model", out var m) && m.ValueKind == JsonValueKind.Object)
        {
            if (m.TryGetProperty("state", out var s) && s.ValueKind == JsonValueKind.String) _modelState = s.GetString();
            if (m.TryGetProperty("modelId", out var id) && id.ValueKind == JsonValueKind.String) _modelId = id.GetString();
        }
    }

    private void ArmTaskWatchdog(AgentTaskRecord rec, HostInstance inst)
    {
        var cts = new CancellationTokenSource();
        rec.Watchdog = cts;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(_options.TaskTimeoutMs, cts.Token);
                _logger.LogWarning("[AgentHost] Task {TaskId} exceeded {Ms} ms; cancelling.", rec.TaskId, _options.TaskTimeoutMs);
                rec.State = "cancelling";
                try { await inst.RequestAsync("cancel", new { taskId = rec.TaskId }, _options.RequestTimeoutMs); } catch { }
                await Task.Delay(_options.CancelGraceMs, cts.Token);
                KillForRecovery(inst, "task_timeout", "A task did not end after being cancelled.");
            }
            catch (OperationCanceledException) { /* the task finished */ }
        }, CancellationToken.None);
    }

    // ── Emergency Stop ───────────────────────────────────────────────────────

    private void Enqueue(Func<Task> work)
    {
        lock (_controlLock)
        {
            // Serialized, so a stop and a following resume reach the host in order.
            _control = _control.ContinueWith(_ => work(), CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default).Unwrap();
        }
    }

    private async Task PushStopAsync(ulong generation)
    {
        var inst = _instance;
        if (inst is not { IsAlive: true }) return; // the next start carries the stop in its hello
        try
        {
            var sw = Stopwatch.StartNew();
            await inst.RequestAsync("emergency_stop", new { generation = (long)generation }, _options.StopAckTimeoutMs);
            _logger.LogWarning("[AgentHost] Emergency Stop generation {Gen} acknowledged in {Ms} ms.", generation, sw.ElapsedMilliseconds);
        }
        catch (Exception ex)
        {
            // The daemon remains the authority: no acknowledgement means the process tree dies.
            _logger.LogError("[AgentHost] No Emergency Stop acknowledgement ({Error}); killing the host process tree.", ex.Message);
            KillForRecovery(inst, "emergency_stop", "Emergency Stop: the agent host did not acknowledge and was killed.");
        }
    }

    private async Task PushResumeAsync(ulong generation)
    {
        var inst = _instance;
        if (inst is not { IsAlive: true }) return;
        try { await inst.RequestAsync("resume", new { generation = (long)generation }, _options.RequestTimeoutMs); }
        catch (Exception ex) { _logger.LogWarning("[AgentHost] Resume was not applied by the host: {Error}", ex.Message); }
    }

    // ── Instance callbacks ───────────────────────────────────────────────────

    private void OnInstanceEvent(HostInstance inst, string evt, string taskId, long seq, JsonElement data)
    {
        if (!_tasks.TryGetValue(taskId, out var rec) || rec.InstanceEpoch != inst.Epoch)
        {
            // Not ours: the stream cannot be trusted to correlate correctly any more.
            OnInstanceViolation(inst, $"event for unknown task {taskId}");
            return;
        }
        if (evt == "task.progress")
        {
            TaskProgress?.Invoke(this, new AgentTaskProgressEventArgs(rec, seq, data));
            return;
        }
        Finish(rec, ToResult(taskId, data));
        // The task's end is also when the model state is most likely to have changed.
    }

    private static AgentTaskResultNotification ToResult(string taskId, JsonElement d)
    {
        string? S(string n) => d.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        int I(string n) => d.TryGetProperty(n, out var v) && v.TryGetInt32(out var x) ? x : 0;
        JsonElement? J(string n) => d.TryGetProperty(n, out var v) && v.ValueKind != JsonValueKind.Null ? v : null;
        return new AgentTaskResultNotification
        {
            TaskId = taskId,
            // A result without a recognisable outcome is a failure, never a success.
            Outcome = S("outcome") is { } o && o is "completed" or "unverified" or "partial" or "failed" or "refused" or "cancelled" or "answered" ? o : "failed",
            Response = S("response") ?? string.Empty,
            Error = S("error"),
            Steps = J("steps"),
            Verification = J("verification"),
            ToolCalls = I("toolCalls"),
            Iterations = I("iterations"),
        };
    }

    private void Finish(AgentTaskRecord rec, AgentTaskResultNotification result)
    {
        lock (rec)
        {
            if (rec.State == "finished") return;
            rec.Result = result;
            rec.State = "finished";
        }
        KeepResult(result, rec.OwnerSessionId);
        try { rec.Watchdog?.Cancel(); } catch { }
        try { rec.CallsCts.Cancel(); } catch { }
        try { TaskFinished?.Invoke(this, rec); }
        catch (Exception ex) { _logger.LogError(ex, "[AgentHost] TaskFinished handler failed."); }
    }

    private void FinishInterrupted(AgentTaskRecord rec, string code, string message) =>
        Finish(rec, new AgentTaskResultNotification
        {
            TaskId = rec.TaskId,
            Outcome = "failed",
            Interrupted = true,
            ErrorCode = code,
            Error = message,
            Response = "I couldn't finish this: the agent stopped while working on it. It will not be retried automatically, and any step already started may have taken effect.",
        });

    private void FailInFlight(long epoch, string code, string message)
    {
        foreach (var t in _tasks.Values.Where(t => t.InstanceEpoch == epoch && t.State != "finished"))
            FinishInterrupted(t, code, message);
    }

    private void OnInstanceViolation(HostInstance inst, string detail)
    {
        _logger.LogError("[AgentHost] Protocol violation from host pid {Pid}: {Detail}. Killing it.", inst.Pid, detail);
        KillForRecovery(inst, "protocol_violation", "The agent host sent an invalid protocol message.");
    }

    private void KillForRecovery(HostInstance inst, string code, string message)
    {
        if (!inst.BeginTermination(code, message)) return;
        _lastError = message; // visible in Health immediately, before the exit is processed
        inst.Kill(); // OnInstanceExit does the rest
    }

    private void OnInstanceExit(HostInstance inst, int? exitCode)
    {
        string code = inst.TerminationCode ?? "host_crashed";
        string message = inst.TerminationMessage ?? $"The agent host exited unexpectedly (exit code {exitCode}).";
        FailInFlight(inst.Epoch, code, message);
        _modelState = null;

        if (inst.ExpectedExit || _disposing) return;
        _lastError = message;
        _logger.LogError("[AgentHost] Host pid {Pid} ended: {Message}", inst.Pid, message);
        RecordCrash();
        if (ReferenceEquals(_instance, inst)) _instance = null;

        if (!_options.AutoRestart) { _state = AgentHostState.Stopped; return; }
        _state = AgentHostState.Restarting;
        _ = Task.Run(() => RestartAsync(), CancellationToken.None);
    }

    private void RecordCrash()
    {
        lock (_crashLock) _crashes.Add(DateTime.UtcNow);
    }

    /// <summary>Starts a fresh, idle host. It is told the current stop state and is given no tasks.</summary>
    private async Task RestartAsync()
    {
        int recent;
        lock (_crashLock) recent = _crashes.Count;
        await Task.Delay(_options.RestartBackoffMs * (1 << Math.Clamp(recent - 1, 0, 5)));
        if (_disposing) return;
        try
        {
            await EnsureStartedAsync(CancellationToken.None);
            Interlocked.Increment(ref _restarts);
        }
        catch (Exception ex)
        {
            _logger.LogError("[AgentHost] Restart failed: {Error}", ex.Message);
        }
    }

    private void PruneTasks()
    {
        if (_tasks.Count <= MaxRetainedTasks) return;
        foreach (var t in _tasks.Values.Where(t => t.State == "finished").OrderBy(t => t.SubmittedAtUtc).Take(_tasks.Count - MaxRetainedTasks))
            _tasks.TryRemove(t.TaskId, out _);
    }

    // ── One host process ─────────────────────────────────────────────────────

    private sealed class HostInstance
    {
        private readonly Process _process;
        private readonly ProcessJob _job;
        private readonly ILogger _logger;
        private readonly Action<HostInstance, string, string, long, JsonElement> _onEvent;
        private readonly Action<HostInstance, string> _onViolation;
        private readonly Action<HostInstance, int?> _onExit;
        private readonly Action<HostInstance, JsonElement, int>? _onCall;
        private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pending = new();

        // ── Phase 7B.1b: protocol v2 (host-originated read-only calls) ──
        /// <summary>The desktop tools negotiated in hello; empty means v2 calls are a protocol violation.</summary>
        public volatile IReadOnlySet<string> DesktopTools = new HashSet<string>();
        /// <summary>In-flight calls by id, cancelled on call.cancel, task end or host exit.</summary>
        public readonly ConcurrentDictionary<string, CancellationTokenSource> Calls = new();
        public readonly ConcurrentDictionary<string, byte> HostCancelled = new();
        /// <summary>Cancelled when the host exits: no call outlives the process that asked.</summary>
        public readonly CancellationTokenSource Lifetime = new();
        private long _lastCallSeq;
        private readonly object _callSeqLock = new();
        private readonly Queue<DateTime> _recentCalls = new();

        /// <summary>Call ids must strictly increase; a repeat or older id is a duplicate and is never executed.</summary>
        public bool TryAdvanceCallSeq(long n)
        {
            lock (_callSeqLock)
            {
                if (n <= _lastCallSeq) return false;
                _lastCallSeq = n;
                return true;
            }
        }

        /// <summary>At most <paramref name="perMinute"/> calls in any rolling minute.</summary>
        public bool TryRateLimit(int perMinute)
        {
            lock (_callSeqLock)
            {
                var now = DateTime.UtcNow;
                while (_recentCalls.Count > 0 && now - _recentCalls.Peek() > TimeSpan.FromMinutes(1)) _recentCalls.Dequeue();
                if (_recentCalls.Count >= perMinute) return false;
                _recentCalls.Enqueue(now);
                return true;
            }
        }

        public async Task SendLineAsync(string line)
        {
            if (_exited.Task.IsCompleted) return;
            await _writeLock.WaitAsync();
            try
            {
                await _process.StandardInput.WriteAsync(line + "\n");
                await _process.StandardInput.FlushAsync();
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException) { }
            finally { _writeLock.Release(); }
        }
        private readonly ConcurrentDictionary<string, byte> _timedOut = new();
        private readonly SemaphoreSlim _writeLock = new(1, 1);
        private readonly TaskCompletionSource _exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private long _nextId;
        private int _terminating;
        private int _exitHandled;

        public long Epoch { get; }
        public int Pid { get; }
        public volatile bool ExpectedExit;
        public string? TerminationCode { get; private set; }
        public string? TerminationMessage { get; private set; }
        public bool IsAlive => !_exited.Task.IsCompleted && Volatile.Read(ref _terminating) == 0;

        public HostInstance(Process process, ProcessJob job, long epoch, ILogger logger,
            Action<HostInstance, string, string, long, JsonElement> onEvent,
            Action<HostInstance, string> onViolation,
            Action<HostInstance, int?> onExit,
            Action<HostInstance, JsonElement, int>? onCall = null)
        {
            _onCall = onCall;
            _process = process;
            _job = job;
            Epoch = epoch;
            Pid = process.Id;
            _logger = logger;
            _onEvent = onEvent;
            _onViolation = onViolation;
            _onExit = onExit;
        }

        public void Start()
        {
            _ = Task.Run(ReadStdoutAsync);
            _ = Task.Run(ReadStderrAsync);
        }

        public bool BeginTermination(string code, string message)
        {
            if (Interlocked.Exchange(ref _terminating, 1) != 0) return false;
            TerminationCode = code;
            TerminationMessage = message;
            return true;
        }

        public void Kill()
        {
            try { _process.Kill(entireProcessTree: true); } catch { /* already gone */ }
        }

        public async Task<bool> WaitForExitAsync(int timeoutMs)
        {
            var t = await Task.WhenAny(_exited.Task, Task.Delay(timeoutMs));
            return t == _exited.Task;
        }

        public async Task<JsonElement> RequestAsync(string op, object parameters, int timeoutMs)
        {
            if (_exited.Task.IsCompleted) throw new AgentHostProtocolException("host_unavailable", "The agent host is not running.");
            string id = $"d{Epoch}-{Interlocked.Increment(ref _nextId)}";
            var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pending[id] = tcs;
            string line = JsonSerializer.Serialize(new { v = 1, id, op, @params = parameters });
            try
            {
                await _writeLock.WaitAsync();
                try
                {
                    await _process.StandardInput.WriteAsync(line + "\n");
                    await _process.StandardInput.FlushAsync();
                }
                finally { _writeLock.Release(); }
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
            {
                _pending.TryRemove(id, out _);
                throw new AgentHostProtocolException("host_unavailable", "The agent host pipe is closed.");
            }

            var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs));
            if (done != tcs.Task)
            {
                _pending.TryRemove(id, out _);
                // A late answer to this id is expected, not a violation.
                _timedOut[id] = 0;
                throw new TimeoutException($"No response to {op} within {timeoutMs} ms.");
            }
            return await tcs.Task;
        }

        private async Task ReadStdoutAsync()
        {
            try
            {
                var reader = _process.StandardOutput;
                var sb = new StringBuilder();
                var buf = new char[8192];
                for (;;)
                {
                    int n = await reader.ReadAsync(buf, 0, buf.Length);
                    if (n == 0) break;
                    int start = 0;
                    for (int i = 0; i < n; i++)
                    {
                        if (buf[i] != '\n') continue;
                        sb.Append(buf, start, i - start);
                        start = i + 1;
                        HandleLine(sb.ToString());
                        sb.Clear();
                    }
                    sb.Append(buf, start, n - start);
                    if (sb.Length > MaxOutputLineChars)
                    {
                        _onViolation(this, "output line too long");
                        sb.Clear();
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
            {
                _logger.LogDebug("[AgentHost] stdout closed: {Error}", ex.Message);
            }
            await HandleExitAsync();
        }

        private void HandleLine(string line)
        {
            line = line.TrimEnd('\r');
            if (line.Length == 0) return;
            JsonElement m;
            try
            {
                using var doc = JsonDocument.Parse(line);
                m = doc.RootElement.Clone();
            }
            catch (JsonException)
            {
                // Length only: a stray line may contain anything, including user data.
                _onViolation(this, $"non-JSON line of {line.Length} chars on stdout");
                return;
            }
            if (m.ValueKind != JsonValueKind.Object || !m.TryGetProperty("v", out var v) || !v.TryGetInt32(out var ver) || !m.TryGetProperty("kind", out var kindEl))
            {
                _onViolation(this, "message without a valid v/kind");
                return;
            }
            string? kind = kindEl.ValueKind == JsonValueKind.String ? kindEl.GetString() : null;
            // v1 for the original kinds; v2 only for the Phase 7B.1b read-only call kinds. Anything else is a violation.
            bool v2Kind = kind is "call" or "call.cancel";
            if (ver != (v2Kind ? 2 : 1))
            {
                _onViolation(this, $"protocol version {ver} is not valid for message kind '{kind}'");
                return;
            }
            switch (kind)
            {
                case "response": HandleResponse(m); break;
                case "event": HandleEvent(m); break;
                case "call" or "call.cancel" when _onCall != null: _onCall(this, m, line.Length); break;
                default: _onViolation(this, "unknown message kind"); break;
            }
        }

        private void HandleResponse(JsonElement m)
        {
            string? id = m.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : null;
            if (id == null)
            {
                // The host could not read something we sent. We only send valid JSON, so this should not happen.
                _logger.LogError("[AgentHost] Host rejected an unreadable request: {Error}", m.TryGetProperty("error", out var e) ? e.GetRawText() : "?");
                return;
            }
            if (!_pending.TryRemove(id, out var tcs))
            {
                if (_timedOut.TryRemove(id, out _)) return;
                _onViolation(this, "response to a request that was never sent");
                return;
            }
            bool ok = m.TryGetProperty("ok", out var okEl) && okEl.ValueKind == JsonValueKind.True;
            if (ok && m.TryGetProperty("result", out var result))
            {
                tcs.TrySetResult(result);
                return;
            }
            string code = "internal_error", message = "The agent host returned an error.";
            if (m.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.Object)
            {
                if (err.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String) code = c.GetString()!;
                if (err.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.String) message = msg.GetString()!;
            }
            tcs.TrySetException(new AgentHostProtocolException(code, message));
        }

        private void HandleEvent(JsonElement m)
        {
            if (!m.TryGetProperty("event", out var e) || !m.TryGetProperty("taskId", out var t) || t.ValueKind != JsonValueKind.String ||
                !m.TryGetProperty("seq", out var s) || !s.TryGetInt64(out var seq) || !m.TryGetProperty("data", out var data) ||
                e.GetString() is not ("task.progress" or "task.finished"))
            {
                _onViolation(this, "malformed event");
                return;
            }
            _onEvent(this, e.GetString()!, t.GetString()!, seq, data);
        }

        private async Task ReadStderrAsync()
        {
            try
            {
                string? line;
                while ((line = await _process.StandardError.ReadLineAsync()) != null)
                    _logger.LogDebug("[AgentHost stderr] {Line}", line.Length > 500 ? line[..500] : line);
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException) { }
        }

        private async Task HandleExitAsync()
        {
            if (Interlocked.Exchange(ref _exitHandled, 1) != 0) return;
            int? code = null;
            try
            {
                // stdout closes when the host exits; if it closed while the process lives, end it.
                if (!_process.WaitForExit(1_000)) Kill();
                await _process.WaitForExitAsync();
                code = _process.ExitCode;
            }
            catch { }
            // The host is gone: closing its job kills anything it left behind, so a crash cannot leave a
            // model server holding memory until the next start.
            try { _job.Dispose(); } catch { }
            _exited.TrySetResult();
            try { Lifetime.Cancel(); } catch { }
            foreach (var kv in _pending)
                if (_pending.TryRemove(kv.Key, out var tcs))
                    tcs.TrySetException(new AgentHostProtocolException("host_unavailable", "The agent host exited before answering."));
            try { _onExit(this, code); }
            catch (Exception ex) { _logger.LogError(ex, "[AgentHost] Exit handler failed."); }
            try { _process.Dispose(); } catch { }
        }
    }
}

public sealed class AgentTaskProgressEventArgs : EventArgs
{
    public AgentTaskRecord Task { get; }
    public long Seq { get; }
    public JsonElement Data { get; }

    public AgentTaskProgressEventArgs(AgentTaskRecord task, long seq, JsonElement data)
    {
        Task = task;
        Seq = seq;
        Data = data;
    }
}
