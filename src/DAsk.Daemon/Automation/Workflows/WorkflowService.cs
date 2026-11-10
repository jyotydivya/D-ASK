using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Workflows;

public sealed class WorkflowOptions
{
    public bool Enabled { get; init; }
    public string StorePath { get; init; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D-ASK", "workflows.json");
}

public sealed record WorkflowSchedule(string Kind, string Time, string? Day, string? Date, DateTime ApprovedUtc, DateTime? LastRunUtc, string? LastNote);
public sealed record Workflow(string Name, List<string> Steps, DateTime CreatedUtc, WorkflowSchedule? Schedule);

/// <summary>
/// Reusable workflows and scheduled runs. The daemon owns the store and the clock.
///   workflows.save / list / get / delete / unschedule: D-ASK's own data only; nothing runs.
///   workflows.schedule: approval-gated (Workflow.Schedule, Elevated). The card shows every step and the timing. A due run is
///   submitted as an ordinary task ("Run the workflow …") on behalf of a LIVE HUD session, never without one, never during
///   Emergency Stop; each step is then an ordinary task whose actions still ask for approval at that time. Missed runs are not
///   caught up.
/// Off unless AgentHost:Workflows is true AND an audit journal exists.
/// </summary>
public sealed class WorkflowService : IDesktopActionRequestService
{
    public const string Save = "workflows.save", List = "workflows.list", Get = "workflows.get", Delete = "workflows.delete",
        ScheduleTool = "workflows.schedule", Unschedule = "workflows.unschedule";
    public const string ScheduleType = "Workflow.Schedule";
    /// <summary>Read-only calls: not counted against the task's action budget (a running workflow reads its steps).</summary>
    public static bool IsUnmetered(string tool) => tool is Get or List;
    public const int MaxSteps = 8, MaxStepChars = 300, MaxWorkflows = 50;

    private static readonly Regex NamePattern = new(@"^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$");
    private static readonly Regex TimePattern = new(@"^([01][0-9]|2[0-3]):[0-5][0-9]$");
    private static readonly Regex DatePattern = new(@"^20[0-9]{2}-[01][0-9]-[0-3][0-9]$");
    private static readonly string[] Days = { "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday" };
    private static readonly Regex RunWorkflow = new(@"\b(run|start|execute)\b.*\bworkflow\b|\bschedul|\bworkflow\s+(called|named)\b", RegexOptions.IgnoreCase);

    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly WorkflowOptions _opts;
    private readonly TimeSpan _ttl;
    private readonly ILogger? _logger;
    private readonly object _lock = new();

    public WorkflowService(ActionPolicyEngine policy, Func<bool> isStopped, Func<ulong> generation, IEvidenceRecorder? evidence,
        WorkflowOptions options, TimeSpan? approvalTtl = null, ILogger? logger = null)
    {
        _policy = policy; _isStopped = isStopped; _generation = generation; _evidence = evidence; _opts = options;
        _ttl = approvalTtl ?? TimeSpan.FromSeconds(60); _logger = logger;
    }

    public bool Enabled => _opts.Enabled && _evidence != null;
    public IReadOnlyList<string> Tools => Enabled ? new[] { Save, List, Get, Delete, ScheduleTool, Unschedule } : Array.Empty<string>();
    public int MaxCallMs => (int)Math.Min(_ttl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + 10_000;

    // ── Store ──────────────────────────────────────────────────────────────────────────────────────────────────────

    public List<Workflow> Load()
    {
        lock (_lock)
        {
            try { return File.Exists(_opts.StorePath) ? JsonSerializer.Deserialize<List<Workflow>>(File.ReadAllText(_opts.StorePath)) ?? new() : new(); }
            catch (Exception ex) { _logger?.LogWarning(ex, "[Workflows] The store could not be read; treated as empty (not overwritten)."); throw new InvalidDataException("workflow store unreadable"); }
        }
    }

    private void Store(List<Workflow> all)
    {
        lock (_lock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_opts.StorePath)!);
            string tmp = _opts.StorePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(all), new UTF8Encoding(false));
            File.Move(tmp, _opts.StorePath, overwrite: true);
        }
    }

    private static bool Displayable(string s) => s.All(c => !char.IsControl(c)) && !s.Any(c => c is >= '‪' and <= '‮' or >= '⁦' and <= '⁩');
    public static bool IsValidName(string n) => NamePattern.IsMatch(n) && !n.EndsWith(' ') && !n.EndsWith('.');

    /// <summary>A step is one ordinary request in the user's words. A step may not run, save or schedule workflows (no recursion).</summary>
    public static string? ValidateSteps(IReadOnlyList<string> steps)
    {
        if (steps.Count is 0 or > MaxSteps) return $"a workflow has 1 to {MaxSteps} steps";
        foreach (var s in steps)
        {
            if (s.Trim().Length < 3 || s.Length > MaxStepChars || !Displayable(s)) return $"each step is 3 to {MaxStepChars} displayable characters";
            if (RunWorkflow.IsMatch(s)) return "a step may not run, name or schedule a workflow";
        }
        return null;
    }

    /// <summary>The next local time a schedule is due strictly after <paramref name="after"/> (local), or null (a past one-off).</summary>
    public static DateTime? NextDue(WorkflowSchedule s, DateTime after)
    {
        var t = TimeSpan.ParseExact(s.Time, "hh\\:mm", CultureInfo.InvariantCulture);
        if (s.Kind == "once")
        {
            var at = DateTime.ParseExact(s.Date!, "yyyy-MM-dd", CultureInfo.InvariantCulture) + t;
            return at > after ? at : null;
        }
        for (int i = 0; i <= 7; i++)
        {
            var at = after.Date.AddDays(i) + t;
            if (at <= after) continue;
            if (s.Kind == "daily") return at;
            if (s.Kind == "weekly" && string.Equals(at.DayOfWeek.ToString(), s.Day, StringComparison.OrdinalIgnoreCase)) return at;
        }
        return null;
    }

    public static string Describe(WorkflowSchedule s) => s.Kind switch
    {
        "daily" => $"every day at {s.Time}",
        "weekly" => $"every {CultureInfo.InvariantCulture.TextInfo.ToTitleCase(s.Day!)} at {s.Time}",
        _ => $"once, on {s.Date} at {s.Time}",
    };

    // ── Calls ──────────────────────────────────────────────────────────────────────────────────────────────────────

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (!Tools.Contains(tool)) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (args.ValueKind != JsonValueKind.Object) return DesktopCallResult.Fail("invalid_args", "arguments must be an object");
        string? S(string n, int max) => args.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 0 } x && x.Length <= max ? x : null;
        bool Only(params string[] allowed) => args.EnumerateObject().All(p => allowed.Contains(p.Name));
        List<Workflow> all;
        try { all = Load(); } catch { return DesktopCallResult.Fail("store_unreadable", "The workflow store could not be read; nothing was changed."); }
        Workflow? Find(string? n) => n == null ? null : all.FirstOrDefault(w => string.Equals(w.Name, n, StringComparison.OrdinalIgnoreCase));

        switch (tool)
        {
            case List:
                if (!Only()) return DesktopCallResult.Fail("invalid_args", "list takes no arguments");
                return DesktopCallResult.Ok(new { workflows = all.Select(w => new { name = w.Name, steps = w.Steps.Count, schedule = w.Schedule == null ? null : Describe(w.Schedule), lastRunUtc = w.Schedule?.LastRunUtc, lastNote = w.Schedule?.LastNote }).ToArray() });
            case Get:
            {
                if (!Only("name")) return DesktopCallResult.Fail("invalid_args", "get takes a name");
                var w = Find(S("name", 40));
                return w == null ? DesktopCallResult.Fail("not_found", "There is no workflow with that name.") : DesktopCallResult.Ok(new { name = w.Name, steps = w.Steps, schedule = w.Schedule == null ? null : Describe(w.Schedule) });
            }
            case Save:
            {
                if (!Only("name", "steps")) return DesktopCallResult.Fail("invalid_args", "save takes a name and steps");
                var name = S("name", 40);
                if (name == null || !IsValidName(name)) return DesktopCallResult.Fail("invalid_args", "a workflow name is 1 to 40 letters, digits, spaces, '.', '_' or '-'");
                if (!args.TryGetProperty("steps", out var st) || st.ValueKind != JsonValueKind.Array || st.EnumerateArray().Any(e => e.ValueKind != JsonValueKind.String))
                    return DesktopCallResult.Fail("invalid_args", "steps must be a list of requests");
                var steps = st.EnumerateArray().Select(e => e.GetString()!.Trim()).ToList();
                if (ValidateSteps(steps) is { } bad) return DesktopCallResult.Fail("invalid_args", bad);
                if (Find(name) != null) return DesktopCallResult.Fail("exists", $"A workflow called \"{name}\" already exists; delete it first to replace it.");
                if (all.Count >= MaxWorkflows) return DesktopCallResult.Fail("too_many", $"At most {MaxWorkflows} workflows can be saved.");
                all.Add(new Workflow(name, steps, DateTime.UtcNow, null));
                Store(all);
                await AuditAsync("WorkflowSaved", ctx, name, $"{steps.Count} step(s)");
                return DesktopCallResult.Ok(new { saved = true, name, steps });
            }
            case Delete:
            {
                if (!Only("name")) return DesktopCallResult.Fail("invalid_args", "delete takes a name");
                var w = Find(S("name", 40));
                if (w == null) return DesktopCallResult.Fail("not_found", "There is no workflow with that name.");
                all.Remove(w); Store(all);
                await AuditAsync("WorkflowDeleted", ctx, w.Name, "deleted (with its schedule)");
                return DesktopCallResult.Ok(new { deleted = true, name = w.Name, hadSchedule = w.Schedule != null });
            }
            case Unschedule:
            {
                if (!Only("name")) return DesktopCallResult.Fail("invalid_args", "unschedule takes a name");
                var w = Find(S("name", 40));
                if (w == null) return DesktopCallResult.Fail("not_found", "There is no workflow with that name.");
                if (w.Schedule == null) return DesktopCallResult.Fail("not_scheduled", $"\"{w.Name}\" is not scheduled.");
                all[all.IndexOf(w)] = w with { Schedule = null }; Store(all);
                await AuditAsync("WorkflowUnscheduled", ctx, w.Name, "schedule removed");
                return DesktopCallResult.Ok(new { unscheduled = true, name = w.Name });
            }
            default:
                return await ScheduleAsync(args, ctx, ct, all, Find, S, Only);
        }
    }

    private async Task<DesktopCallResult> ScheduleAsync(JsonElement args, DesktopActionContext ctx, CancellationToken ct, List<Workflow> all,
        Func<string?, Workflow?> find, Func<string, int, string?> s, Func<string[], bool> only)
    {
        if (!only(new[] { "name", "kind", "time", "day", "date" })) return DesktopCallResult.Fail("invalid_args", "schedule takes name, kind, time and day or date");
        var w = find(s("name", 40));
        if (w == null) return DesktopCallResult.Fail("not_found", "There is no workflow with that name.");
        var kind = s("kind", 8); var time = s("time", 5); var day = s("day", 10)?.ToLowerInvariant(); var date = s("date", 10);
        if (kind is not ("daily" or "weekly" or "once")) return DesktopCallResult.Fail("invalid_args", "kind is daily, weekly or once");
        if (time == null || !TimePattern.IsMatch(time)) return DesktopCallResult.Fail("invalid_args", "time is HH:mm (24-hour, local time)");
        if (kind == "weekly" != (day != null) || (day != null && !Days.Contains(day))) return DesktopCallResult.Fail("invalid_args", "a weekly schedule names exactly one day (monday … sunday)");
        if (kind == "once" != (date != null) || (date != null && (!DatePattern.IsMatch(date) || !DateTime.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))))
            return DesktopCallResult.Fail("invalid_args", "a one-off schedule names exactly one date (yyyy-MM-dd)");
        var schedule = new WorkflowSchedule(kind!, time, day, date, DateTime.UtcNow, null, null);
        var next = NextDue(schedule, DateTime.Now);
        if (next == null) return DesktopCallResult.Fail("in_the_past", "That time has already passed.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active. Nothing was scheduled.");

        var parameters = new Dictionary<string, string>
        {
            ["workflow"] = w.Name,
            ["when"] = Describe(schedule) + " (this computer's local time)",
            ["firstRun"] = next.Value.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture),
            ["stepCount"] = w.Steps.Count.ToString(),
            ["steps"] = string.Join("\n", w.Steps.Select((x, i) => $"{i + 1}. {x}")),
            ["conditions"] = "Runs only while the HUD is connected and Emergency Stop is off; a missed run is skipped, not caught up. Any step that would change something still asks for your approval at that time.",
            ["reversible"] = "Yes: say \"unschedule the workflow " + w.Name + "\" (no approval needed).",
            ["execution"] = "Only the schedule is stored now; nothing runs until it is due.",
        };
        using var self = Process.GetCurrentProcess();
        var started = new DateTimeOffset(self.StartTime.ToUniversalTime(), TimeSpan.Zero);
        var (_, risk, _) = _policy.EvaluatePolicy(ScheduleType, new Dictionary<string, string>(), "D-ASK workflows");
        if (risk != ActionRiskLevel.Elevated) return DesktopCallResult.Fail("approval_refused", "Scheduling is not classified for approval. Nothing was scheduled.");
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"), ActionId = Guid.NewGuid().ToString("N"), ActionType = ScheduleType, ActionParameters = parameters,
            TargetProcessName = "D-ASK workflows", TargetWindowTitle = w.Name, TargetHwnd = 0, TargetProcessId = self.Id, TargetProcessCreationTime = started,
            SessionId = ctx.OwnerSessionId, StopGeneration = _generation(), RiskLevel = risk.ToString(), CreatedAtUtc = DateTimeOffset.UtcNow,
            ExpiresAtUtc = DateTimeOffset.UtcNow + _ttl, Reason = $"D-ASK asks to run the workflow \"{w.Name}\" {Describe(schedule)}.",
        };
        await AuditAsync("WorkflowScheduleRequested", ctx, w.Name, Describe(schedule));
        var decision = await _policy.RequestApprovalAsync(request, ct);
        if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
        if (!decision.Approved)
        {
            await AuditAsync("WorkflowScheduleNotApproved", ctx, w.Name, decision.DecisionSource ?? "denied");
            return DesktopCallResult.Fail(decision.DecisionSource == "UserExplicitConfirmation" ? "approval_denied" : "approval_refused", "The schedule was not approved. Nothing was scheduled.");
        }
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters,
            request.TargetProcessName, 0, self.Id, started, ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid) { await AuditAsync("WorkflowScheduleApprovalInvalid", ctx, w.Name, error ?? "invalid"); return DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was scheduled."); }
        try { all = Load(); } catch { return DesktopCallResult.Fail("store_unreadable", "The workflow store could not be read; nothing was scheduled."); }
        var current = all.FirstOrDefault(x => string.Equals(x.Name, w.Name, StringComparison.OrdinalIgnoreCase));
        if (current == null || !current.Steps.SequenceEqual(w.Steps)) return DesktopCallResult.Fail("changed", "The workflow changed after your approval; nothing was scheduled.");
        all[all.IndexOf(current)] = current with { Schedule = schedule }; Store(all);
        await AuditAsync("WorkflowScheduled", ctx, w.Name, Describe(schedule));
        _logger?.LogInformation("[Workflows] \"{Name}\" scheduled {When} (approved by session {Session}).", w.Name, Describe(schedule), ctx.OwnerSessionId);
        return DesktopCallResult.Ok(new { decision = "approved", consumed = true, executed = true, verified = true, name = w.Name, when = Describe(schedule), firstRun = parameters["firstRun"] });
    }

    // ── Due runs (called by WorkflowScheduler) ─────────────────────────────────────────────────────────────────────

    /// <summary>Workflows due at <paramref name="now"/> (local): due when the next occurrence after the last run (or the approval) has arrived.</summary>
    public List<Workflow> Due(DateTime now)
    {
        List<Workflow> all;
        try { all = Load(); } catch { return new(); }
        return all.Where(w => w.Schedule is { } s && NextDue(s, (s.LastRunUtc ?? s.ApprovedUtc).ToLocalTime()) is { } at && at <= now).ToList();
    }

    public void MarkRun(string name, string note)
    {
        List<Workflow> all;
        try { all = Load(); } catch { return; }
        var w = all.FirstOrDefault(x => x.Name == name);
        if (w?.Schedule == null) return;
        // A one-off schedule ends after its time, whether it ran or was skipped.
        all[all.IndexOf(w)] = w with { Schedule = w.Schedule.Kind == "once" ? null : w.Schedule with { LastRunUtc = DateTime.UtcNow, LastNote = note } };
        Store(all);
    }

    private async Task AuditAsync(string evt, DesktopActionContext ctx, string name, string reason)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt, Source = "WorkflowService", ActionId = Guid.NewGuid().ToString("N"), SessionId = ctx.OwnerSessionId, RiskLevel = "Elevated",
                StopGeneration = _generation(), Decision = evt, Reason = AuditJson.Bound(reason), DetailsJson = AuditJson.Details(new { taskId = ctx.TaskId, workflow = name }),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[Workflows] Audit record {Event} failed.", evt); }
    }
}
