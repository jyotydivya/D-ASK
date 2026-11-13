using System.Diagnostics;
using System.Text.Json;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Desktop;

/// <summary>An application the daemon is willing to open. The list is FIXED in code: the agent names one of these, never a path.</summary>
public sealed record KnownApp(string Key, string DisplayName, string FileName, string[] WindowImages, string TitleContains);

public static class KnownApps
{
    /// <summary>
    /// Notepad is the only entry that can also be TYPED into: its launch, window and editor have been observed end to end on Windows 11
    /// (notepad.exe in System32 is a stub that starts the packaged Notepad and exits; the window belongs to another process).
    /// </summary>
    public static readonly KnownApp Notepad = new("notepad", "Notepad", "notepad.exe", new[] { "notepad.exe" }, "Notepad");
    /// <summary>
    /// Observed on Windows 11 (2026-11-13): calc.exe in System32 starts the packaged Calculator, whose top-level window is an
    /// ApplicationFrameWindow owned by ApplicationFrameHost.exe, titled "Calculator". Open only (no typing target is defined for it).
    /// </summary>
    public static readonly KnownApp Calculator = new("calculator", "Calculator", "calc.exe", new[] { "ApplicationFrameHost.exe" }, "Calculator");
    /// <summary>Observed: charmap.exe owns its own dialog window (#32770) titled "Character Map". Open only.</summary>
    public static readonly KnownApp CharacterMap = new("charmap", "Character Map", "charmap.exe", new[] { "charmap.exe" }, "Character Map");
    public static readonly IReadOnlyList<KnownApp> All = new[] { Notepad, Calculator, CharacterMap };
    public static KnownApp? Find(string? key) => All.FirstOrDefault(a => string.Equals(a.Key, key?.Trim(), StringComparison.OrdinalIgnoreCase));
}

public interface IAppProcessStarter
{
    /// <summary>Starts exactly this executable with no arguments and no shell. Throws if it cannot be started.</summary>
    void Start(string exePath, string workingDirectory);
}

/// <summary>CreateProcess through Process.Start with UseShellExecute=false: no shell, no verb, no arguments, no environment changes.</summary>
public sealed class Win32AppProcessStarter : IAppProcessStarter
{
    public void Start(string exePath, string workingDirectory)
    {
        // No handle inheritance and no host-private environment (NativeLaunch): the program never holds the daemon's handles.
        NativeLaunch.Start(exePath, null, workingDirectory);
    }
}

public sealed class AppLaunchOptions
{
    public bool Enabled { get; init; }
    public TimeSpan ApprovalTtl { get; init; } = TimeSpan.FromSeconds(45);
    /// <summary>How long to wait for the new window (a cold start of the packaged Notepad can take a few seconds).</summary>
    public int WaitForWindowMs { get; init; } = 10_000;
    public int PollMs { get; init; } = 150;
    /// <summary>Tests only: the directory the executables are resolved in. Null: the Windows system directory.</summary>
    public string? SystemDirectoryOverride { get; init; }
    public IAppProcessStarter Starter { get; init; } = new Win32AppProcessStarter();
    /// <summary>
    /// The installed applications Windows registers (Start menu, App Paths, packaged apps, Windows tools). When set, any installed
    /// application can be opened by name (after approval), and Windows Settings pages can be opened. Null: only the fixed list.
    /// </summary>
    public InstalledAppCatalog? Catalog { get; init; }
    public IAppActivator Activator { get; init; } = new Win32AppActivator();
    /// <summary>How long to wait for a discovered application's window (Office and IDEs can take long on a cold start).</summary>
    public int WaitForAppWindowMs { get; init; } = 30_000;
    /// <summary>
    /// Offline-first: whether D-ASK may ask a browser to search the WEB (AgentHost:WebSearch). Off by default: a web search is refused
    /// before anything is looked up, asked or started. A configuration rule, not a connectivity probe; opening a browser itself, or a
    /// local folder/file, is unaffected.
    /// </summary>
    public bool WebSearchAllowed { get; init; }
}

public sealed record LaunchedWindow(long Hwnd, int ProcessId, long ProcessCreationFileTime, string ImageName);

/// <summary>
/// The windows this daemon opened, per task. The typing tools prefer such a window (the same handle, process id and process
/// creation time, still matching the request's selector) over resolving the selector from scratch, so a second, unrelated Notepad
/// the user already had open can never receive the text. Nothing here grants anything: input still needs its own approval.
/// </summary>
public sealed class LaunchedWindowRegistry
{
    private const int MaxTasks = 128;
    private readonly object _gate = new();
    private readonly Dictionary<string, LaunchedWindow> _byTask = new(StringComparer.Ordinal);
    private readonly Queue<string> _order = new();

    public void Record(string taskId, LaunchedWindow w)
    {
        lock (_gate)
        {
            if (!_byTask.ContainsKey(taskId)) { _order.Enqueue(taskId); while (_order.Count > MaxTasks) _byTask.Remove(_order.Dequeue()); }
            _byTask[taskId] = w;
        }
    }

    public LaunchedWindow? For(string taskId) { lock (_gate) return _byTask.TryGetValue(taskId, out var w) ? w : null; }
}

/// <summary>
/// desktop.launch_app: open ONE application from the daemon's fixed list, after the user approves exactly that.
///   strict arguments { app } → feature on → owner session → Emergency Stop → the executable is resolved by the daemon
///   (system directory only; the agent never supplies a path, arguments or a command line) → policy (Elevated) → approval of the
///   exact application and path in the HUD (same policy engine, digest, owner session, liveness, expiry and Stop generation as every
///   other action) → approval consumed once → write-ahead audit → the windows that exist are recorded → ONE CreateProcess,
///   no shell, no arguments → a fresh OS enumeration must show exactly one NEW visible window of that application.
/// Success is reported only on that observation (the child process id is not used: on Windows 11 notepad.exe hands over to the
/// packaged app and exits). Off unless AgentHost:DesktopAppLaunch is true AND an audit journal exists.
/// </summary>
public sealed class AppLaunchRequestService : IDesktopActionRequestService
{
    public const string Launch = "desktop.launch_app";
    /// <summary>Opens one Windows Settings page from the fixed table (low risk: audited and gated, no approval card).</summary>
    public const string OpenSettings = "desktop.open_settings";
    /// <summary>Read-only: the installed applications D-ASK can open, optionally filtered by words.</summary>
    public const string ListApps = "desktop.list_apps";
    public const string Performed = "Performed once, right after your approval: the application is started with no arguments, then a fresh look at the desktop must show its new window before this is reported as done.";

    private readonly DesktopReadService _reader;
    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly Func<string, bool>? _isSessionLive;
    private readonly AppLaunchOptions _opts;
    private readonly LaunchedWindowRegistry _registry;
    private readonly ILogger? _logger;

    public AppLaunchRequestService(DesktopReadService reader, ActionPolicyEngine policy, Func<bool> isStopped, Func<ulong> generation,
        IEvidenceRecorder? evidence, Func<string, bool>? isSessionLive, AppLaunchOptions options, LaunchedWindowRegistry registry, ILogger? logger = null)
    {
        _reader = reader; _policy = policy; _isStopped = isStopped; _generation = generation; _evidence = evidence;
        _isSessionLive = isSessionLive; _opts = options; _registry = registry; _logger = logger;
    }

    public IReadOnlyList<string> Tools => !(_opts.Enabled && _evidence != null && _isSessionLive != null) ? Array.Empty<string>()
        : _opts.Catalog != null ? new[] { Launch, OpenSettings, ListApps } : new[] { Launch };
    public int MaxCallMs => (int)Math.Min(_opts.ApprovalTtl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + Math.Max(_opts.WaitForWindowMs, _opts.WaitForAppWindowMs) + 15_000;

    /// <summary>
    /// Pure: { "app": "&lt;application NAME&gt;" } and nothing else. A name, never a path, a file, arguments, a verb or a command line.
    /// </summary>
    public static string? ParseName(JsonElement args, out string? name)
    {
        name = null;
        if (args.ValueKind != JsonValueKind.Object) return "arguments must be an object";
        foreach (var p in args.EnumerateObject())
        {
            if (p.Name is "search" or "folder") continue;   // ParseTarget validates these
            if (p.Name != "app") return $"unknown argument '{(p.Name.Length > 40 ? p.Name[..40] : p.Name)}'";   // never a path, arguments, a verb or a command line
            if (p.Value.ValueKind != JsonValueKind.String) return "app must be text";
            name = p.Value.GetString();
        }
        if (string.IsNullOrWhiteSpace(name)) return "app is required";
        name = name.Trim();
        if (name.Length > 80) return "app must be an application name of at most 80 characters";
        if (name.IndexOfAny(new[] { '\\', '/', ':', '"', '<', '>', '|', '*', '?' }) >= 0 || name.Any(char.IsControl) ||
            name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))
            return "app must be the application's name, never a path, a file or a command";
        return null;
    }

    /// <summary>What to open in the application: a web search (browsers only) or an existing folder (VS Code, File Explorer).</summary>
    public sealed record OpenTarget(string Kind, string Value);

    private static readonly string[] Browsers = { "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe" };
    private static readonly string[] FolderApps = { "Code.exe", "explorer.exe" };

    /// <summary>Pure: at most one of { "search": "&lt;words&gt;" } or { "folder": "&lt;existing folder&gt;" }; null when neither is given.</summary>
    public static string? ParseTarget(JsonElement args, out OpenTarget? target)
    {
        target = null;
        if (args.ValueKind != JsonValueKind.Object) return null;
        foreach (var p in args.EnumerateObject())
        {
            if (p.Name is not ("search" or "folder")) continue;
            if (target != null) return "give either a search or a folder, not both";
            if (p.Value.ValueKind != JsonValueKind.String) return $"{p.Name} must be text";
            string v = p.Value.GetString()!.Trim();
            if (v.Length is 0 or > 200 || v.Any(char.IsControl) || v.Contains('"')) return $"{p.Name} must be 1-200 characters of plain text";
            if (p.Name == "folder")
            {
                string full;
                try { full = Path.GetFullPath(v); } catch { return "folder must be a folder path"; }
                if (!Path.IsPathFullyQualified(v) || !Directory.Exists(full)) return $"the folder \"{v}\" does not exist";
                v = Path.TrimEndingDirectorySeparator(full);
            }
            target = new OpenTarget(p.Name, v);
        }
        return null;
    }

    /// <summary>
    /// The single argument the DAEMON builds for a target (never agent text on a command line): a quoted search URL with the words
    /// URL-encoded, or a quoted existing folder path. A reason instead when the application cannot open that kind of target.
    /// </summary>
    public static (string? Argument, string? Opens, string? Problem) TargetArgument(InstalledApp app, OpenTarget t)
    {
        if (t.Kind == "search")
        {
            if (app.ExeName == null || !Browsers.Contains(app.ExeName, StringComparer.OrdinalIgnoreCase)) return (null, null, $"{app.Name} is not a web browser D-ASK can search with");
            string url = "https://www.google.com/search?q=" + Uri.EscapeDataString(t.Value);
            return ("\"" + url + "\"", url, null);
        }
        if (app.ExeName == null || !FolderApps.Contains(app.ExeName, StringComparer.OrdinalIgnoreCase)) return (null, null, $"{app.Name} cannot be asked to open a folder");
        return ("\"" + t.Value + "\"", t.Value, null);
    }

    /// <summary>Whether a window shows the target: a search's words, or the folder's name, in its title.</summary>
    public static bool ShowsTarget(OpenTarget t, WindowIdentity w) =>
        w.Title.Contains(t.Kind == "search" ? t.Value : Path.GetFileName(t.Value), StringComparison.OrdinalIgnoreCase);

    /// <summary>Pure: { "app": "&lt;known application&gt;" } from the fixed list (used when no catalog of installed applications is configured).</summary>
    public static string? Parse(JsonElement args, out KnownApp? app)
    {
        app = null;
        if (ParseName(args, out var key) is { } bad) return bad;
        app = KnownApps.Find(key);
        return app == null ? $"'{(key!.Length > 40 ? key[..40] : key)}' is not an application D-ASK can open (known: {string.Join(", ", KnownApps.All.Select(a => a.Key))})" : null;
    }

    /// <summary>The executable, resolved from the system directory only. Null if it is not there.</summary>
    public string? ResolveExecutable(KnownApp app)
    {
        string dir = _opts.SystemDirectoryOverride ?? Environment.SystemDirectory;
        string path = Path.GetFullPath(Path.Combine(dir, app.FileName));
        if (!path.StartsWith(Path.TrimEndingDirectorySeparator(Path.GetFullPath(dir)) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return null;
        return File.Exists(path) ? path : null;
    }

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        DesktopCallResult result;
        try { result = await RunAsync(tool, args, ctx, ct); }
        catch (OperationCanceledException) { result = DesktopCallResult.Cancelled(); }
        if (result.Status != "ok") _logger?.LogInformation("[AppLaunch] {Tool} for task {TaskId}: not performed ({Code}).", tool, ctx.TaskId, result.Error?.Code ?? result.Status);
        return result;
    }

    private async Task<DesktopCallResult> RunAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (tool == ListApps) return ListInstalled(args);
        if (tool == OpenSettings) return await OpenSettingsAsync(args, ctx, ct);
        if (tool != Launch) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (ParseName(args, out var name) is { } badName) return DesktopCallResult.Fail("invalid_args", badName);
        if (ParseTarget(args, out var target) is { } badTarget) return DesktopCallResult.Fail("invalid_args", badTarget);
        if (target != null && _opts.Catalog == null) return DesktopCallResult.Fail("invalid_args", "opening a search or a folder needs the catalog of installed applications");
        if (target?.Kind == "search" && !_opts.WebSearchAllowed)
            return DesktopCallResult.Fail("offline_mode",
                $"A web search needs internet access, and D-ASK is in offline mode (web searches are switched off: AgentHost:WebSearch). Nothing was opened or searched. You can still ask D-ASK to open {name} itself, or a local file or folder.");
        // Any installed application (when the catalog is configured); the fixed list keeps its own, observed path.
        if ((KnownApps.Find(name) == null || target != null) && _opts.Catalog != null) return await RunCatalogAsync(name!, target, ctx, ct);
        if (Parse(args, out var app) is { } bad) return DesktopCallResult.Fail("invalid_args", bad);
        if (!_opts.Enabled || _evidence == null || _isSessionLive == null)
            return DesktopCallResult.Fail("launch_disabled", "Opening applications is switched off in this installation (AgentHost:DesktopAppLaunch). Nothing was asked or done.");
        if (string.IsNullOrWhiteSpace(ctx.OwnerSessionId)) return DesktopCallResult.Fail("no_owner", "The task has no owning HUD session, so nobody can approve this.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active; no action can be requested.");
        string? exe = ResolveExecutable(app!);
        if (exe == null) return DesktopCallResult.Fail("app_unavailable", $"{app!.DisplayName} was not found in the Windows system folder, so it cannot be opened.");
        var (allowed, risk, policyReason) = _policy.EvaluatePolicy(DesktopActionTypes.AppLaunch, new Dictionary<string, string>(), app.FileName);
        if (allowed || risk != ActionRiskLevel.Elevated) return DesktopCallResult.Fail("policy_denied", $"The policy does not permit this request ({policyReason}).");

        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["operation"] = $"Open {app.DisplayName}",
            ["application"] = app.FileName,
            ["executable"] = exe,
            ["arguments"] = "none",
            ["result"] = $"A new {app.DisplayName} window opens. Nothing is typed, saved or changed by opening it.",
            ["reversible"] = "Yes: close the window.",
            ["execution"] = Performed,
        };
        using var self = Process.GetCurrentProcess();
        var started = new DateTimeOffset(self.StartTime.ToUniversalTime(), TimeSpan.Zero);
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"), ActionId = Guid.NewGuid().ToString("N"), ActionType = DesktopActionTypes.AppLaunch, ActionParameters = parameters,
            TargetProcessName = "D-ASK app launch", TargetWindowTitle = $"Open {app.DisplayName}", TargetHwnd = 0,
            TargetProcessId = self.Id, TargetProcessCreationTime = started, SessionId = ctx.OwnerSessionId, StopGeneration = _generation(),
            RiskLevel = risk.ToString(), CreatedAtUtc = DateTimeOffset.UtcNow, ExpiresAtUtc = DateTimeOffset.UtcNow + _opts.ApprovalTtl,
            Reason = $"D-ASK asks to open {app.DisplayName}.",
        };
        await AuditAsync("AppLaunchRequested", request, ctx, app, $"agent call {ctx.CallId}");
        ActionApprovalResponse decision = await _policy.RequestApprovalAsync(request, ct);
        if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
        if (!decision.Approved)
        {
            var (code, message) = decision.DecisionSource switch
            {
                "UserExplicitConfirmation" => ("approval_denied", "You declined. Nothing was opened."),
                "TimeoutDenied" => ("approval_expired", "The approval expired before a decision. Nothing was opened."),
                "EmergencyStopDenied" or "StaleGenerationDenied" => ("emergency_stopped", "Emergency Stop cancelled the request. Nothing was opened."),
                "SessionDisconnectedDenied" => ("hud_unavailable", "The HUD is not connected or not responding, so the request could not be approved. Nothing was opened."),
                "IntegrityMismatch" => ("approval_refused", "The request could not be offered for approval exactly as it would be performed. Nothing was opened."),
                _ => ("approval_denied", "The request was not approved. Nothing was opened."),
            };
            await AuditAsync("AppLaunchNotApproved", request, ctx, app, decision.DecisionSource ?? "denied");
            return DesktopCallResult.Fail(code, message);
        }
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters,
            request.TargetProcessName, 0, self.Id, started, ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid)
        {
            await AuditAsync("AppLaunchApprovalInvalid", request, ctx, app, error ?? "invalid");
            return DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was opened.");
        }
        // The gates immediately before acting: stop, the approving HUD still live, the executable still the one approved.
        if (_isStopped() || _generation() != request.StopGeneration) return DesktopCallResult.Fail("emergency_stopped", "An Emergency Stop happened after the approval, so it no longer applies. Nothing was opened.");
        if (!_isSessionLive(request.SessionId)) return DesktopCallResult.Fail("hud_unavailable", "The HUD that approved this is no longer live. Nothing was opened.");
        if (ResolveExecutable(app) != exe) return DesktopCallResult.Fail("target_changed", "You approved it, but the application file changed. Nothing was opened.");
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = "AppLaunchAdmitted", Source = "AppLaunchRequestService", ActionId = request.ActionId, ApprovalId = request.ApprovalId, SessionId = request.SessionId,
                RiskLevel = request.RiskLevel, StopGeneration = request.StopGeneration, Decision = "Admitted", Reason = "approval consumed once",
                DetailsJson = AuditJson.Details(Details(request, ctx, app)),
            });
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "[AppLaunch] Write-ahead audit failed; refusing to act.");
            return DesktopCallResult.Fail("journal_unavailable", "The action could not be recorded before acting, so it was not performed. Nothing was opened.");
        }

        // Observe, act once, observe again.
        var before = _reader.SnapshotNow().Select(w => w.Hwnd).ToHashSet();
        try { _opts.Starter.Start(exe, Path.GetDirectoryName(exe)!); }
        catch (Exception ex)
        {
            await AuditAsync("AppLaunchFailed", request, ctx, app, ex.GetType().Name);
            return DesktopCallResult.Fail("launch_failed", $"{app.DisplayName} could not be started ({ex.Message}).");
        }

        List<WindowIdentity> fresh = new();
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < _opts.WaitForWindowMs)
        {
            if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
            fresh = NewWindows(app, before);
            if (fresh.Count > 0) break;
            try { await Task.Delay(_opts.PollMs, ct); } catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
        }
        if (fresh.Count == 0)
        {
            await AuditAsync("AppLaunchUnverified", request, ctx, app, "no new window");
            return DesktopCallResult.Fail("launch_unverified",
                $"{app.DisplayName} was started, but no NEW {app.DisplayName} window appeared within {_opts.WaitForWindowMs / 1000} s, so the launch is not confirmed (if it opened a tab in a window that was already open, close that window and ask again).");
        }
        // Settle, then read again: the window must still be there, once, with the same identity.
        try { await Task.Delay(300, ct); } catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
        fresh = NewWindows(app, before);
        if (fresh.Count != 1)
        {
            await AuditAsync("AppLaunchUnverified", request, ctx, app, $"{fresh.Count} new windows");
            return DesktopCallResult.Fail("launch_ambiguous", fresh.Count == 0
                ? $"A {app.DisplayName} window appeared but was gone a moment later, so the launch is not confirmed."
                : $"{fresh.Count} new {app.DisplayName} windows appeared, so D-ASK cannot tell which one is the one it opened.");
        }
        var w = fresh[0];
        _registry.Record(ctx.TaskId, new LaunchedWindow(w.Hwnd, w.ProcessId, w.ProcessCreationFileTime, w.ImageName));
        await AuditAsync("AppLaunchPerformed", request, ctx, app, "new window observed");
        return DesktopCallResult.Ok(new
        {
            launched = true, verified = true, app = app.Key, executed = true,
            observed = $"a new {app.DisplayName} window titled \"{w.Title}\" ({w.ImageName}, process {w.ProcessId}) is open",
            window = new { process = w.ImageName, title = w.Title, pid = w.ProcessId },
        });
    }

    // ── Any installed application (catalog) ──────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// desktop.launch_app for an application discovered from Windows: the NAME is resolved by the daemon to exactly one installed
    /// application (ambiguity or absence is reported, never guessed); the approval card shows exactly what Windows will start (program and
    /// its own shortcut arguments, or the packaged app id); then the same consumed-once approval, gates and write-ahead audit as the fixed
    /// list; ONE start; success only when a fresh look at the desktop shows that application's window (new, or brought to the front).
    /// </summary>
    private async Task<DesktopCallResult> RunCatalogAsync(string name, OpenTarget? target, DesktopActionContext ctx, CancellationToken ct)
    {
        if (!_opts.Enabled || _evidence == null || _isSessionLive == null)
            return DesktopCallResult.Fail("launch_disabled", "Opening applications is switched off in this installation (AgentHost:DesktopAppLaunch). Nothing was asked or done.");
        if (string.IsNullOrWhiteSpace(ctx.OwnerSessionId)) return DesktopCallResult.Fail("no_owner", "The task has no owning HUD session, so nobody can approve this.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active; no action can be requested.");

        var res = _opts.Catalog!.Resolve(name);
        if (res.App == null)
            return res.Candidates.Count > 0
                ? DesktopCallResult.Fail("app_ambiguous", $"Several installed applications match \"{name}\": {string.Join("; ", res.Candidates)}. Say which one. Nothing was opened.")
                : DesktopCallResult.Fail("app_not_found", $"No installed application named \"{name}\" was found on this computer. Nothing was opened.");
        var app = res.App;
        // What exactly is started: the registered program with its own arguments, plus the ONE argument the daemon built for the target.
        var launch = app;
        string? opens = null;
        if (target != null)
        {
            var (arg, what, why) = TargetArgument(app, target);
            if (why != null) return DesktopCallResult.Fail("invalid_args", why + ". Nothing was opened.");
            launch = app with { Arguments = string.IsNullOrEmpty(app.Arguments) ? arg : app.Arguments + " " + arg };
            opens = what;
        }
        var (allowed, risk, policyReason) = _policy.EvaluatePolicy(DesktopActionTypes.AppLaunch, new Dictionary<string, string>(), app.ExeName ?? app.Name);
        if (allowed || risk != ActionRiskLevel.Elevated) return DesktopCallResult.Fail("policy_denied", $"The policy does not permit this request ({policyReason}).");

        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["operation"] = target == null ? $"Open {app.Name}" : target.Kind == "search" ? $"Search the web in {app.Name}" : $"Open a folder in {app.Name}",
            ["application"] = app.Name,
            ["kind"] = app.Kind == InstalledApp.KindPackaged ? "Store / packaged app" : "desktop program",
            ["target"] = app.Target,
            ["arguments"] = launch.Arguments ?? "none",
            ["opens"] = opens ?? "nothing else (the application only)",
            ["registeredBy"] = app.Source,
            ["result"] = $"Windows starts {app.Name} and its window opens. Nothing is typed, saved or changed by opening it.",
            ["administrator"] = "If Windows says this program needs administrator rights, Windows shows its own permission (UAC) prompt and you decide there; D-ASK never bypasses it.",
            ["reversible"] = "Yes: close the window.",
            ["execution"] = Performed,
        };
        using var self = Process.GetCurrentProcess();
        var started = new DateTimeOffset(self.StartTime.ToUniversalTime(), TimeSpan.Zero);
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"), ActionId = Guid.NewGuid().ToString("N"), ActionType = DesktopActionTypes.AppLaunch, ActionParameters = parameters,
            TargetProcessName = "D-ASK app launch", TargetWindowTitle = $"Open {app.Name}", TargetHwnd = 0,
            TargetProcessId = self.Id, TargetProcessCreationTime = started, SessionId = ctx.OwnerSessionId, StopGeneration = _generation(),
            RiskLevel = risk.ToString(), CreatedAtUtc = DateTimeOffset.UtcNow, ExpiresAtUtc = DateTimeOffset.UtcNow + _opts.ApprovalTtl,
            Reason = $"D-ASK asks to open {app.Name}.",
        };
        await AuditCatalogAsync("AppLaunchRequested", request, ctx, app, $"agent call {ctx.CallId}");
        ActionApprovalResponse decision = await _policy.RequestApprovalAsync(request, ct);
        if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
        if (!decision.Approved)
        {
            var (code, message) = decision.DecisionSource switch
            {
                "UserExplicitConfirmation" => ("approval_denied", "You declined. Nothing was opened."),
                "TimeoutDenied" => ("approval_expired", "The approval expired before a decision. Nothing was opened."),
                "EmergencyStopDenied" or "StaleGenerationDenied" => ("emergency_stopped", "Emergency Stop cancelled the request. Nothing was opened."),
                "SessionDisconnectedDenied" => ("hud_unavailable", "The HUD is not connected or not responding, so the request could not be approved. Nothing was opened."),
                "IntegrityMismatch" => ("approval_refused", "The request could not be offered for approval exactly as it would be performed. Nothing was opened."),
                _ => ("approval_denied", "The request was not approved. Nothing was opened."),
            };
            await AuditCatalogAsync("AppLaunchNotApproved", request, ctx, app, decision.DecisionSource ?? "denied");
            return DesktopCallResult.Fail(code, message);
        }
        // A stop after the approval: say so (the consumption below would refuse it too).
        if (_isStopped() || _generation() != request.StopGeneration) return DesktopCallResult.Fail("emergency_stopped", "An Emergency Stop happened after the approval, so it no longer applies. Nothing was opened.");
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters,
            request.TargetProcessName, 0, self.Id, started, ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid)
        {
            await AuditCatalogAsync("AppLaunchApprovalInvalid", request, ctx, app, error ?? "invalid");
            return DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was opened.");
        }
        if (_isStopped() || _generation() != request.StopGeneration) return DesktopCallResult.Fail("emergency_stopped", "An Emergency Stop happened after the approval, so it no longer applies. Nothing was opened.");
        if (!_isSessionLive(request.SessionId)) return DesktopCallResult.Fail("hud_unavailable", "The HUD that approved this is no longer live. Nothing was opened.");
        // What Windows registers must still be exactly what was approved.
        var again = _opts.Catalog.Resolve(name, fresh: true).App;
        if (again == null || again.Target != app.Target || again.Arguments != app.Arguments)
            return DesktopCallResult.Fail("target_changed", "You approved it, but the installed application changed. Nothing was opened.");
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = "AppLaunchAdmitted", Source = "AppLaunchRequestService", ActionId = request.ActionId, ApprovalId = request.ApprovalId, SessionId = request.SessionId,
                RiskLevel = request.RiskLevel, StopGeneration = request.StopGeneration, Decision = "Admitted", Reason = "approval consumed once",
                DetailsJson = AuditJson.Details(CatalogDetails(request, ctx, app)),
            });
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "[AppLaunch] Write-ahead audit failed; refusing to act.");
            return DesktopCallResult.Fail("journal_unavailable", "The action could not be recorded before acting, so it was not performed. Nothing was opened.");
        }

        var before = _reader.SnapshotNow().Select(w => w.Hwnd).ToHashSet();
        AppActivationResult act;
        try { act = _opts.Activator.Start(launch); }
        catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)   // ERROR_CANCELLED: the UAC prompt was declined
        {
            await AuditCatalogAsync("AppLaunchFailed", request, ctx, app, "UAC declined");
            return DesktopCallResult.Fail("elevation_declined", $"Windows asked for administrator permission to open {app.Name} and it was declined. Nothing was opened.");
        }
        catch (Exception ex)
        {
            await AuditCatalogAsync("AppLaunchFailed", request, ctx, app, ex.GetType().Name);
            return DesktopCallResult.Fail("launch_failed", $"{app.Name} could not be started ({ex.Message}).");
        }

        WindowIdentity? seen = null; bool isNew = false;
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < _opts.WaitForAppWindowMs)
        {
            if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
            var now = _reader.SnapshotNow();
            seen = now.Where(w => w.Visible && !before.Contains(w.Hwnd) && IsWindowOf(app, w, act.ProcessId) && (target == null || ShowsTarget(target, w)))
                .OrderByDescending(w => w.Foreground).FirstOrDefault();
            if (seen != null) { isNew = true; break; }
            // A single-instance application that was already open is brought to the front instead of opening a new window.
            if (sw.ElapsedMilliseconds > 2500)
            {
                seen = now.FirstOrDefault(w => w.Visible && w.Foreground && IsWindowOf(app, w, act.ProcessId) && (target == null || ShowsTarget(target, w)));
                if (seen != null) break;
            }
            try { await Task.Delay(_opts.PollMs, ct); } catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
        }
        if (seen == null)
        {
            await AuditCatalogAsync("AppLaunchUnverified", request, ctx, app, "no window");
            return DesktopCallResult.Fail("launch_unverified",
                $"{app.Name} was started{(act.Elevated ? " (with administrator permission)" : "")}, but no {app.Name} window{(target == null ? "" : target.Kind == "search" ? " showing the search \"" + target.Value + "\"" : " showing the folder " + Path.GetFileName(target.Value))} appeared within {_opts.WaitForAppWindowMs / 1000} s, so it is not confirmed.");
        }
        if (isNew) _registry.Record(ctx.TaskId, new LaunchedWindow(seen.Hwnd, seen.ProcessId, seen.ProcessCreationFileTime, seen.ImageName));
        await AuditCatalogAsync("AppLaunchPerformed", request, ctx, app, isNew ? "new window observed" : "existing window brought to the front");
        return DesktopCallResult.Ok(new
        {
            launched = true, verified = true, app = app.Name, executed = true, newWindow = isNew, elevated = act.Elevated,
            observed = isNew ? $"a new {app.Name} window titled \"{seen.Title}\" ({seen.ImageName}, process {seen.ProcessId}) is open"
                             : $"{app.Name} was already open; its window \"{seen.Title}\" ({seen.ImageName}) is now in front",
            window = new { process = seen.ImageName, title = seen.Title, pid = seen.ProcessId },
        });
    }

    /// <summary>Whether a window belongs to the application: its program, the process Windows reported, or its name in the title.</summary>
    public static bool IsWindowOf(InstalledApp app, WindowIdentity w, int? pid)
    {
        if (pid is int p && w.ProcessId == p) return true;
        if (app.ExeName != null && string.Equals(w.ImageName, app.ExeName, StringComparison.OrdinalIgnoreCase)) return true;
        if (app.ExeName != null && w.Title.Contains(app.ExeName, StringComparison.OrdinalIgnoreCase)) return true;   // e.g. a console hosted by Terminal
        if (IsInPackage(app, w.ImagePath)) return true;   // a packaged app's own program (e.g. Terminal, whatever its window title)
        return app.Name.Length >= 4 && w.Title.Contains(app.Name, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Whether a program file belongs to the packaged app: its install folder is "&lt;package name&gt;_&lt;version&gt;_&lt;arch&gt;_&lt;resource&gt;_&lt;publisher id&gt;"
    /// under WindowsApps, and the app id is "&lt;package name&gt;_&lt;publisher id&gt;!&lt;app&gt;". Both parts must match.
    /// </summary>
    public static bool IsInPackage(InstalledApp app, string? imagePath)
    {
        if (app.Kind != InstalledApp.KindPackaged || string.IsNullOrEmpty(imagePath) || app.AppUserModelId is not { } aumid) return false;
        string family = aumid.Split('!')[0];
        int us = family.LastIndexOf('_');
        if (us <= 0) return false;
        string name = family[..us], publisher = family[(us + 1)..];
        var parts = imagePath.Split('\\');
        int i = Array.FindIndex(parts, p => p.Equals("WindowsApps", StringComparison.OrdinalIgnoreCase));
        // Only where Windows installs packages: "<drive>:\Program Files\WindowsApps" or "<drive>:\WindowsApps".
        bool drive = parts.Length > 0 && parts[0].Length == 2 && parts[0][1] == ':';
        bool root = drive && (i == 1 || (i == 2 && parts[1].Equals("Program Files", StringComparison.OrdinalIgnoreCase)));
        if (!root || i + 1 >= parts.Length) return false;
        string folder = parts[i + 1];
        return folder.StartsWith(name + "_", StringComparison.OrdinalIgnoreCase) && folder.EndsWith("_" + publisher, StringComparison.OrdinalIgnoreCase);
    }

    private static object CatalogDetails(ActionApprovalRequest q, DesktopActionContext ctx, InstalledApp app) => new
    {
        actionType = q.ActionType, taskId = ctx.TaskId, callId = ctx.CallId, application = app.Name, kind = app.Kind, target = app.Target, source = app.Source,
    };

    private async Task AuditCatalogAsync(string evt, ActionApprovalRequest q, DesktopActionContext ctx, InstalledApp app, string reason)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt, Source = "AppLaunchRequestService", ActionId = q.ActionId, ApprovalId = q.ApprovalId, SessionId = q.SessionId,
                RiskLevel = q.RiskLevel, StopGeneration = q.StopGeneration, Decision = evt, Reason = AuditJson.Bound(reason),
                DetailsJson = AuditJson.Details(CatalogDetails(q, ctx, app)),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[AppLaunch] Audit record {Event} failed.", evt); }
    }

    // ── Windows Settings pages (low risk: no approval card; gated and audited) ─────────────────────────────────────────────────

    private async Task<DesktopCallResult> OpenSettingsAsync(JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (args.ValueKind != JsonValueKind.Object) return DesktopCallResult.Fail("invalid_args", "arguments must be an object");
        string? pageName = null;
        foreach (var p in args.EnumerateObject())
        {
            if (p.Name != "page" || p.Value.ValueKind != JsonValueKind.String) return DesktopCallResult.Fail("invalid_args", "only { \"page\": \"<settings page name>\" } is accepted");
            pageName = p.Value.GetString();
        }
        var page = SettingsPages.Find(pageName);
        if (page == null)
            return DesktopCallResult.Fail("invalid_args", $"\"{pageName}\" is not a Settings page D-ASK knows. Known: {string.Join(", ", SettingsPages.All.Keys)}.");
        if (!_opts.Enabled || _evidence == null || _isSessionLive == null || _opts.Catalog == null)
            return DesktopCallResult.Fail("launch_disabled", "Opening Windows Settings is switched off in this installation. Nothing was done.");
        if (string.IsNullOrWhiteSpace(ctx.OwnerSessionId) || !_isSessionLive(ctx.OwnerSessionId))
            return DesktopCallResult.Fail("hud_unavailable", "The HUD is not connected or not responding. Nothing was done.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active; nothing was done.");
        var (allowed, risk, reason) = _policy.EvaluatePolicy(DesktopActionTypes.OpenSettingsPage, new Dictionary<string, string> { ["page"] = page.Value.Key }, "SystemSettings.exe");
        if (!allowed) return DesktopCallResult.Fail("policy_denied", $"The policy does not permit this request ({reason}).");

        string actionId = Guid.NewGuid().ToString("N");
        ulong gen = _generation();
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = "SettingsPageAdmitted", Source = "AppLaunchRequestService", ActionId = actionId, SessionId = ctx.OwnerSessionId,
                RiskLevel = risk.ToString(), StopGeneration = gen, Decision = "AutoAllowed", Reason = AuditJson.Bound(reason ?? "low risk"),
                DetailsJson = AuditJson.Details(new { taskId = ctx.TaskId, callId = ctx.CallId, page = page.Value.Key, uri = page.Value.Uri }),
            });
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "[Settings] Write-ahead audit failed; refusing to act.");
            return DesktopCallResult.Fail("journal_unavailable", "The action could not be recorded before acting, so it was not performed.");
        }
        if (_isStopped() || _generation() != gen) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active; nothing was done.");

        try { _opts.Activator.OpenSettingsUri(page.Value.Uri); }
        catch (Exception ex) { return DesktopCallResult.Fail("launch_failed", $"Windows Settings could not be opened ({ex.Message})."); }

        // Postcondition: the Settings window is in front AND (for a named page) shows that page's heading.
        WindowIdentity? w = null; bool pageShown = page.Value.Key == "home"; string uiaDetail = "not inspected"; bool fronted = false;
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < 15_000 && !(w != null && pageShown))
        {
            if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
            w = _reader.SnapshotNow().FirstOrDefault(x => x.Visible && x.Title.Contains("Settings", StringComparison.OrdinalIgnoreCase) &&
                (string.Equals(x.ImageName, "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase) || string.Equals(x.ImageName, "SystemSettings.exe", StringComparison.OrdinalIgnoreCase)));
            // A Settings window that was already open stays behind other windows when opened from the background, and Windows then
            // shows no page content to UI Automation: put the window D-ASK just navigated in front (the purpose of the action), once.
            if (w != null && !fronted) { try { _opts.Activator.BringToFront(w.Hwnd); } catch { } fronted = true; }
            if (w != null && !pageShown) (pageShown, uiaDetail) = await _reader.WindowShowsDetailAsync(w.Hwnd, page.Value.Title, ct);
            if (w != null && pageShown) break;
            try { await Task.Delay(400, ct); } catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
        }
        if (w == null) return DesktopCallResult.Fail("launch_unverified", "Windows Settings was asked to open, but no Settings window appeared within 15 s.");
        if (!pageShown)
            return DesktopCallResult.Fail("page_unverified", $"Windows Settings is open, but D-ASK could not confirm that it shows the {page.Value.Title} page ({uiaDetail}).");
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = "SettingsPageOpened", Source = "AppLaunchRequestService", ActionId = actionId, SessionId = ctx.OwnerSessionId,
                RiskLevel = risk.ToString(), StopGeneration = gen, Decision = "Performed", Reason = "Settings window shows the page",
                DetailsJson = AuditJson.Details(new { taskId = ctx.TaskId, page = page.Value.Key, window = w.Title }),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[Settings] Audit record failed."); }
        return DesktopCallResult.Ok(new
        {
            opened = true, verified = true, executed = true, page = page.Value.Title, uri = page.Value.Uri,
            observed = $"the Settings window \"{w.Title}\" is open and shows \"{page.Value.Title}\"",
        });
    }

    // ── Installed applications (read-only) ─────────────────────────────────────────────────────────────────────────────────────

    private DesktopCallResult ListInstalled(JsonElement args)
    {
        if (_opts.Catalog == null) return DesktopCallResult.Fail("launch_disabled", "The list of installed applications is not available in this installation.");
        string? filter = null;
        if (args.ValueKind == JsonValueKind.Object)
            foreach (var p in args.EnumerateObject())
            {
                if (p.Name != "filter" || p.Value.ValueKind != JsonValueKind.String) return DesktopCallResult.Fail("invalid_args", "only { \"filter\": \"<words>\" } is accepted");
                filter = p.Value.GetString();
            }
        if (filter is { Length: > 60 }) return DesktopCallResult.Fail("invalid_args", "filter is at most 60 characters");
        var all = _opts.Catalog.All();
        string f = InstalledAppCatalog.Normalize(filter ?? "");
        var shown = (f.Length == 0 ? all : all.Where(a => InstalledAppCatalog.Normalize(a.Name).Contains(f))).Take(300)
            .Select(a => new { name = a.Name, kind = a.Kind, source = a.Source }).ToList();
        return DesktopCallResult.Ok(new { count = all.Count, shown = shown.Count, apps = shown });
    }

    private List<WindowIdentity> NewWindows(KnownApp app, HashSet<long> before) =>
        _reader.SnapshotNow().Where(w => !before.Contains(w.Hwnd) && w.Visible && !w.Minimized
            && app.WindowImages.Contains(w.ImageName, StringComparer.OrdinalIgnoreCase)
            && w.Title.Contains(app.TitleContains, StringComparison.OrdinalIgnoreCase)).ToList();

    private static object Details(ActionApprovalRequest q, DesktopActionContext ctx, KnownApp app) => new
    {
        actionType = q.ActionType, taskId = ctx.TaskId, callId = ctx.CallId, application = app.FileName,
    };

    private async Task AuditAsync(string evt, ActionApprovalRequest q, DesktopActionContext ctx, KnownApp app, string reason)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt, Source = "AppLaunchRequestService", ActionId = q.ActionId, ApprovalId = q.ApprovalId, SessionId = q.SessionId,
                RiskLevel = q.RiskLevel, StopGeneration = q.StopGeneration, Decision = evt, Reason = AuditJson.Bound(reason),
                DetailsJson = AuditJson.Details(Details(q, ctx, app)),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[AppLaunch] Audit record {Event} failed.", evt); }
    }
}
