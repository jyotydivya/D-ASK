using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Dev;

/// <summary>A build or test command the DAEMON chose for a project (never agent text): program, its arguments, and what it is.</summary>
public sealed record DevCommand(string Kind, string Program, IReadOnlyList<string> Arguments, string Display);

/// <summary>What a finished build/test produced, with the errors and test summary picked out of the output.</summary>
public sealed record DevRunResult(int? ExitCode, bool TimedOut, bool Cancelled, long DurationMs, string OutputTail, IReadOnlyList<string> Errors, IReadOnlyList<string> Summary);

public interface IDevProcessRunner
{
    Task<DevRunResult> RunAsync(DevCommand command, string workingDirectory, TimeSpan timeout, CancellationToken ct);
}

/// <summary>
/// Runs ONE program with fixed arguments (no shell), output captured through pipes D-ASK owns, bounded in time; cancellation or Emergency
/// Stop kills the whole process tree. The child gets the user's environment without the launching host's private variables.
/// </summary>
public sealed class DevProcessRunner : IDevProcessRunner
{
    private const int MaxOutputChars = 200_000;

    public async Task<DevRunResult> RunAsync(DevCommand command, string workingDirectory, TimeSpan timeout, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(command.Program)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in command.Arguments) psi.ArgumentList.Add(a);
        psi.Environment.Clear();
        foreach (var (k, v) in NativeLaunch.ChildEnvironment()) psi.Environment[k] = v;
        psi.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        psi.Environment["CI"] = "1";   // non-interactive tools; nothing waits for a keypress

        var output = new StringBuilder();
        void Add(string? line) { if (line == null) return; lock (output) { if (output.Length < MaxOutputChars * 2) output.AppendLine(line); } }
        var sw = Stopwatch.StartNew();
        using var p = new Process { StartInfo = psi };
        p.OutputDataReceived += (_, e) => Add(e.Data);
        p.ErrorDataReceived += (_, e) => Add(e.Data);
        // Every process of the run lives in ONE job object: whatever it starts (npm → cmd → node, MSBuild nodes, test hosts) joins the job,
        // and terminating the job ends all of them. Process.Kill(entireProcessTree) was observed to miss npm's grandchild (2026-11-14).
        // Kill-on-close: nothing can outlive the run, even if D-ASK itself stops.
        using var job = new KillOnCloseJob();
        p.Start();
        job.Assign(p);
        p.StandardInput.Close();   // nothing is ever typed into it
        p.BeginOutputReadLine(); p.BeginErrorReadLine();
        bool timedOut = false, cancelled = false;
        using var timeoutCts = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);
        try { await p.WaitForExitAsync(linked.Token); }
        catch (OperationCanceledException)
        {
            timedOut = timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested;
            cancelled = ct.IsCancellationRequested;
            job.TerminateAll();
            try { p.Kill(entireProcessTree: true); } catch { }   // belt and braces if the job could not be assigned
            try { await p.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)); } catch { }
        }
        try { p.WaitForExit(2000); } catch { }   // flush the asynchronous readers
        string all; lock (output) all = output.ToString();
        int? code = p.HasExited && !timedOut && !cancelled ? p.ExitCode : null;
        job.TerminateAll();   // anything the build left running in the background ends with the run
        return new DevRunResult(code, timedOut, cancelled, sw.ElapsedMilliseconds, Tail(all, 6000), DevTaskService.ErrorsIn(all), DevTaskService.SummaryIn(all));
    }

    private static string Tail(string s, int n) => s.Length <= n ? s : "…" + s[^n..];
}

/// <summary>A Windows job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: every process in it ends when it is terminated or closed.</summary>
public sealed class KillOnCloseJob : IDisposable
{
    private IntPtr _handle;
    public bool Assigned { get; private set; }

    public KillOnCloseJob()
    {
        _handle = CreateJobObject(IntPtr.Zero, null);
        if (_handle == IntPtr.Zero) return;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION { BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = 0x2000 /* KILL_ON_JOB_CLOSE */ } };
        int size = System.Runtime.InteropServices.Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        IntPtr ptr = System.Runtime.InteropServices.Marshal.AllocHGlobal(size);
        try
        {
            System.Runtime.InteropServices.Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(_handle, 9 /* JobObjectExtendedLimitInformation */, ptr, (uint)size)) { CloseHandle(_handle); _handle = IntPtr.Zero; }
        }
        finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(ptr); }
    }

    public void Assign(Process p) { if (_handle != IntPtr.Zero) Assigned = AssignProcessToJobObject(_handle, p.Handle); }
    public void TerminateAll() { if (_handle != IntPtr.Zero) TerminateJobObject(_handle, 1); }
    public void Dispose() { if (_handle != IntPtr.Zero) { CloseHandle(_handle); _handle = IntPtr.Zero; } }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr a, string? name);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr h);
}

public sealed class DevTaskOptions
{
    public bool Enabled { get; init; }
    /// <summary>The folders whose projects may be built or tested (AgentHost:DevProjectRoots). Empty: off.</summary>
    public string[] Roots { get; init; } = Array.Empty<string>();
    public TimeSpan Timeout { get; init; } = TimeSpan.FromMinutes(10);
    public TimeSpan ApprovalTtl { get; init; } = TimeSpan.FromSeconds(60);
    public IDevProcessRunner Runner { get; init; } = new DevProcessRunner();
    /// <summary>Tests: where programs are looked up (null: PATH).</summary>
    public Func<string, string?>? FindProgram { get; init; }
}

/// <summary>
/// dev.run_task: build or test ONE project in an allowed folder. The daemon recognises the project (dotnet, npm, cargo) and picks the
/// command from a fixed table; the user approves exactly that command, folder and time limit (it runs the project's own code); then one
/// run with captured output, a time limit, and Emergency Stop / cancellation killing the whole process tree. The result is the exit code,
/// the error lines and test summary found in the output, and its tail: what is needed to explain a failure.
/// </summary>
public sealed class DevTaskService : IDesktopActionRequestService
{
    public const string RunTask = "dev.run_task";

    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly Func<string, bool>? _isSessionLive;
    private readonly DevTaskOptions _opts;
    private readonly ILogger? _logger;
    private readonly string[] _roots;

    public DevTaskService(ActionPolicyEngine policy, Func<bool> isStopped, Func<ulong> generation, IEvidenceRecorder? evidence, Func<string, bool>? isSessionLive,
        DevTaskOptions options, ILogger? logger = null)
    {
        _policy = policy; _isStopped = isStopped; _generation = generation; _evidence = evidence; _isSessionLive = isSessionLive; _opts = options; _logger = logger;
        _roots = options.Roots.Where(r => !string.IsNullOrWhiteSpace(r) && Path.IsPathFullyQualified(r) && !r.StartsWith(@"\\", StringComparison.Ordinal))
            .Select(r => Path.TrimEndingDirectorySeparator(Path.GetFullPath(r))).Where(Directory.Exists).ToArray();
    }

    public IReadOnlyList<string> Tools => _opts.Enabled && _evidence != null && _isSessionLive != null && _roots.Length > 0 ? new[] { RunTask } : Array.Empty<string>();
    public int MaxCallMs => (int)Math.Min(_opts.ApprovalTtl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + (int)_opts.Timeout.TotalMilliseconds + 30_000;

    private static readonly Regex ErrorLine = new(@"(\berror\b\s*[A-Z]{1,4}\d{2,5}|\berror\[E\d+\]|^\s*(?:error|ERROR|FAIL|FAILED|Failed)\b|\bnot ok\b|AssertionError|Assert\.\w+\(\) Failure|^\s*✗|npm ERR!)", RegexOptions.Compiled);
    private static readonly Regex SummaryLine = new(@"(Passed!|Failed!|\bBuild succeeded\b|\bBuild FAILED\b|\d+ Warning\(s\)|\d+ Error\(s\)|test result:|Tests?:\s+\d+|\d+ passed|\d+ failed|# (?:pass|fail)\s+\d+)", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static IReadOnlyList<string> ErrorsIn(string output) =>
        output.Split('\n').Select(l => l.TrimEnd('\r')).Where(l => l.Length > 0 && ErrorLine.IsMatch(l)).Select(l => l.Length > 300 ? l[..300] + "…" : l).Distinct().Take(25).ToList();
    public static IReadOnlyList<string> SummaryIn(string output) =>
        output.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0 && SummaryLine.IsMatch(l)).Select(l => l.Length > 200 ? l[..200] + "…" : l).Distinct().TakeLast(10).ToList();

    private string? Find(string program) => _opts.FindProgram != null ? _opts.FindProgram(program)
        : (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator).Where(d => d.Length > 0)
            .Select(d => { try { return Path.Combine(d.Trim('"'), program); } catch { return null; } }).FirstOrDefault(p => p != null && File.Exists(p));

    /// <summary>The fixed command for this project and task, or why there is none. Order: .NET, then npm, then Cargo.</summary>
    public (DevCommand? Command, string? Problem) CommandFor(string folder, string task)
    {
        bool test = task == "test";
        if (Directory.EnumerateFiles(folder, "*.sln").Any() || Directory.EnumerateFiles(folder, "*.csproj").Any() || Directory.EnumerateFiles(folder, "*.fsproj").Any())
        {
            string? dotnet = Find("dotnet.exe");
            return dotnet == null ? (null, "this is a .NET project, but the .NET SDK (dotnet) was not found")
                : (new DevCommand(".NET", dotnet, new[] { test ? "test" : "build", "--nologo" }, $"dotnet {(test ? "test" : "build")} --nologo"), null);
        }
        string pkg = Path.Combine(folder, "package.json");
        if (File.Exists(pkg))
        {
            JsonElement scripts;
            try { using var doc = JsonDocument.Parse(File.ReadAllText(pkg)); scripts = doc.RootElement.TryGetProperty("scripts", out var s) ? s.Clone() : default; }
            catch { return (null, "package.json cannot be read"); }
            string script = test ? "test" : "build";
            if (scripts.ValueKind != JsonValueKind.Object || !scripts.TryGetProperty(script, out var cmd) || cmd.ValueKind != JsonValueKind.String)
                return (null, $"package.json has no \"{script}\" script");
            string? node = Find("node.exe");
            string? npmCli = node == null ? null : Path.Combine(Path.GetDirectoryName(node)!, "node_modules", "npm", "bin", "npm-cli.js");
            if (node == null || !File.Exists(npmCli)) return (null, "this is an npm project, but Node.js/npm was not found");
            return (new DevCommand("npm", node, test ? new[] { npmCli, "test" } : new[] { npmCli, "run", "build" },
                test ? $"npm test   (runs the project's own script: {cmd.GetString()})" : $"npm run build   (runs the project's own script: {cmd.GetString()})"), null);
        }
        if (File.Exists(Path.Combine(folder, "Cargo.toml")))
        {
            string? cargo = Find("cargo.exe");
            return cargo == null ? (null, "this is a Rust project, but cargo was not found")
                : (new DevCommand("Rust", cargo, new[] { test ? "test" : "build" }, $"cargo {(test ? "test" : "build")}"), null);
        }
        return (null, "no .NET solution/project, package.json or Cargo.toml was found in that folder");
    }

    private string? CheckFolder(string folder, out string canonical)
    {
        canonical = "";
        if (!Path.IsPathFullyQualified(folder) || folder.StartsWith(@"\\", StringComparison.Ordinal) || folder.IndexOf(':', 2) >= 0) return "the folder must be a plain absolute path";
        string full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder));
        if (!_roots.Any(r => full.Equals(r, StringComparison.OrdinalIgnoreCase) || full.StartsWith(r + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)))
            return "that folder is not one whose projects D-ASK may build or test (AgentHost:DevProjectRoots)";
        if (!Directory.Exists(full)) return "the folder does not exist";
        canonical = full;
        return null;
    }

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        try { return await RunAsync(tool, args, ctx, ct); }
        catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
    }

    private async Task<DesktopCallResult> RunAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (tool != RunTask) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        string? folder = null, task = null;
        if (args.ValueKind != JsonValueKind.Object) return DesktopCallResult.Fail("invalid_args", "arguments must be an object");
        foreach (var p in args.EnumerateObject())
        {
            if (p.Value.ValueKind != JsonValueKind.String) return DesktopCallResult.Fail("invalid_args", $"{p.Name} must be text");
            if (p.Name == "folder") folder = p.Value.GetString(); else if (p.Name == "task") task = p.Value.GetString();
            else return DesktopCallResult.Fail("invalid_args", "only { folder, task } are accepted (the command is chosen by D-ASK, never given)");
        }
        if (task is not ("build" or "test")) return DesktopCallResult.Fail("invalid_args", "task must be \"build\" or \"test\"");
        if (folder == null) return DesktopCallResult.Fail("invalid_args", "folder is required");
        if (!_opts.Enabled || _evidence == null || _isSessionLive == null || _roots.Length == 0) return DesktopCallResult.Fail("dev_disabled", "Building and testing projects is switched off in this installation (AgentHost:DevProjectRoots). Nothing was run.");
        if (CheckFolder(folder, out var dir) is { } badFolder) return DesktopCallResult.Fail("folder_refused", badFolder);
        if (string.IsNullOrWhiteSpace(ctx.OwnerSessionId)) return DesktopCallResult.Fail("no_owner", "The task has no owning HUD session, so nobody can approve this.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active; nothing was run.");
        var (command, why) = CommandFor(dir, task);
        if (command == null) return DesktopCallResult.Fail("no_project", $"Nothing to {task} in {dir}: {why}. Nothing was run.");
        var (allowed, risk, reason) = _policy.EvaluatePolicy(DesktopActionTypes.DevRunTask, new(), Path.GetFileName(command.Program));
        if (allowed || risk != ActionRiskLevel.Elevated) return DesktopCallResult.Fail("policy_denied", $"The policy does not permit this request ({reason}).");

        var parameters = new Dictionary<string, string>
        {
            ["operation"] = $"{(task == "test" ? "Run the tests of" : "Build")} the {command.Kind} project",
            ["folder"] = dir,
            ["command"] = command.Display,
            ["program"] = command.Program,
            ["timeLimit"] = $"{(int)_opts.Timeout.TotalMinutes} minutes",
            ["note"] = "This runs the project's own build/test code on this computer, with your user rights. Approve only projects you trust.",
            ["stop"] = "Emergency Stop, or cancelling the task, ends it and everything it started.",
            ["execution"] = "Run once, right after your approval; its output is captured and the result (exit code, errors, test summary) is reported as found, never guessed.",
        };
        using var self = Process.GetCurrentProcess();
        var started = new DateTimeOffset(self.StartTime.ToUniversalTime(), TimeSpan.Zero);
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"), ActionId = Guid.NewGuid().ToString("N"), ActionType = DesktopActionTypes.DevRunTask, ActionParameters = parameters,
            TargetProcessName = "D-ASK developer tasks", TargetWindowTitle = Path.GetFileName(dir), TargetHwnd = 0,
            TargetProcessId = self.Id, TargetProcessCreationTime = started, SessionId = ctx.OwnerSessionId, StopGeneration = _generation(),
            RiskLevel = risk.ToString(), CreatedAtUtc = DateTimeOffset.UtcNow, ExpiresAtUtc = DateTimeOffset.UtcNow + _opts.ApprovalTtl,
            Reason = $"D-ASK asks to {task} {Path.GetFileName(dir)}.",
        };
        await AuditAsync("DevTaskRequested", request, ctx, dir, command.Display);
        var decision = await _policy.RequestApprovalAsync(request, ct);
        if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
        if (!decision.Approved) { await AuditAsync("DevTaskNotApproved", request, ctx, dir, decision.DecisionSource ?? "denied"); return DesktopCallResult.Fail("approval_denied", "The request was not approved. Nothing was run."); }
        if (_isStopped() || _generation() != request.StopGeneration) return DesktopCallResult.Fail("emergency_stopped", "An Emergency Stop happened after the approval, so it no longer applies. Nothing was run.");
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters, request.TargetProcessName, 0, self.Id, started,
            ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid) { await AuditAsync("DevTaskApprovalInvalid", request, ctx, dir, error ?? "invalid"); return DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was run."); }
        if (!_isSessionLive(request.SessionId)) return DesktopCallResult.Fail("hud_unavailable", "The HUD that approved this is no longer live. Nothing was run.");
        if (CommandFor(dir, task).Command?.Display != command.Display) return DesktopCallResult.Fail("changed", "The project changed after your approval; nothing was run.");
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = "DevTaskAdmitted", Source = "DevTaskService", ActionId = request.ActionId, ApprovalId = request.ApprovalId, SessionId = request.SessionId,
                RiskLevel = request.RiskLevel, StopGeneration = request.StopGeneration, Decision = "Admitted", Reason = "approval consumed once",
                DetailsJson = AuditJson.Details(new { taskId = ctx.TaskId, folder = dir, command = command.Display }),
            });
        }
        catch (Exception ex) { _logger?.LogError(ex, "[Dev] Write-ahead audit failed; refusing to act."); return DesktopCallResult.Fail("journal_unavailable", "The action could not be recorded before acting, so nothing was run."); }

        // Emergency Stop during the run kills it: watched alongside the caller's cancellation.
        using var stopCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        using var watcher = new Timer(_ => { if (_isStopped() || _generation() != request.StopGeneration) try { stopCts.Cancel(); } catch { } }, null, 200, 200);
        var r = await _opts.Runner.RunAsync(command, dir, _opts.Timeout, stopCts.Token);
        bool stopped = r.Cancelled && !ct.IsCancellationRequested;
        await AuditAsync("DevTaskFinished", request, ctx, dir, r.ExitCode is int c ? $"exit {c}" : r.TimedOut ? "timed out (killed)" : stopped ? "stopped (killed)" : "cancelled (killed)");
        if (r.Cancelled) return stopped
            ? DesktopCallResult.Fail("emergency_stopped", $"Emergency Stop ended the {task} after {r.DurationMs / 1000} s; it and everything it started were killed.")
            : DesktopCallResult.Cancelled();
        bool succeeded = r.ExitCode == 0;
        return DesktopCallResult.Ok(new
        {
            executed = true, verified = r.ExitCode != null, succeeded, task, project = command.Kind, folder = dir, command = command.Display,
            exitCode = r.ExitCode, timedOut = r.TimedOut, durationMs = r.DurationMs, errors = r.Errors, summary = r.Summary, outputTail = r.OutputTail,
            observed = r.TimedOut ? $"the {task} did not finish within {(int)_opts.Timeout.TotalMinutes} minutes and was stopped"
                : succeeded ? $"the {task} finished successfully (exit code 0)" : $"the {task} FAILED (exit code {r.ExitCode}); {r.Errors.Count} error line(s) found",
        });
    }

    private async Task AuditAsync(string evt, ActionApprovalRequest q, DesktopActionContext ctx, string folder, string reason)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt, Source = "DevTaskService", ActionId = q.ActionId, ApprovalId = q.ApprovalId, SessionId = q.SessionId, RiskLevel = q.RiskLevel,
                StopGeneration = q.StopGeneration, Decision = evt, Reason = AuditJson.Bound(reason), DetailsJson = AuditJson.Details(new { taskId = ctx.TaskId, folder }),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[Dev] Audit record {Event} failed.", evt); }
    }
}
