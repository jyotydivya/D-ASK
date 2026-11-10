using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Desktop;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.AgentHost;

/// <summary>
/// Phase 7B.1b: agent-host protocol v2, read-only. The host may send
/// <c>{"v":2,"kind":"call","callId":"c&lt;n&gt;","taskId":…,"tool":…,"args":{…},"deadlineMs":…}</c> and
/// <c>{"v":2,"kind":"call.cancel","callId":…}</c>; the daemon answers each call exactly once with
/// <c>{"v":2,"kind":"reply","callId":…,"status":"ok|error|cancelled","result"|"error":…}</c>.
///
/// The daemon is the authority. It derives the session from the task record (never from the message), accepts only
/// tools negotiated in hello, validates every field strictly, refuses duplicates, rate-limits, enforces a deadline,
/// and cancels calls when the task ends, the task is cancelled, or the host exits. Malformed lines and calls before
/// negotiation are protocol violations (the host is killed, as for any other violation). Only read-only tools exist.
/// </summary>
public sealed partial class AgentHostManager
{
    public const int MaxCallLineChars = 16 * 1024;
    public const int MaxReplyChars = 48 * 1024;      // the host accepts lines up to 64 KiB
    public const int MaxCallsPerMinute = 30;
    public const int MaxActionRequestsPerTask = 1;
    /// <summary>P1/P2: element-bound input actions get their OWN per-task budget (each still needs its own approval), so a
    /// workflow such as "type, then press Enter" is possible. Window operations keep exactly one request per task.</summary>
    public const int MaxInputRequestsPerTask = 6;
    // Browser stage 2 shares the input budget: each browser action is one step of a request, each separately approved.
    private static bool IsInputTool(string tool) => DAsk.Daemon.Automation.Input.GuardedInputTools.All.Contains(tool) ||
        tool == DAsk.Daemon.Automation.Browser.BrowserActionRequestService.RequestAction;
    public const int DefaultCallDeadlineMs = 6_000;
    private static readonly Regex CallIdPattern = new(@"^c([0-9]{1,9})$");
    private static readonly HashSet<string> CallFields = new(StringComparer.Ordinal) { "v", "kind", "callId", "taskId", "tool", "args", "deadlineMs" };
    private static readonly JsonSerializerOptions ReplyJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly IDesktopReadService? _desktop;
    private readonly IDesktopActionRequestService? _actions;

    private bool ActionsEnabled => DesktopEnabled && _options.DesktopActionRequests && _actions != null;
    private bool IsActionTool(string tool) => ActionsEnabled && _actions!.Tools.Contains(tool);

    /// <summary>Every tool offered to the host: the read-only tools, plus the approval-gated action requests when enabled.</summary>
    private IReadOnlyList<string> OfferedDesktopTools =>
        ActionsEnabled ? _desktop!.Tools.Concat(_actions!.Tools).ToList() : _desktop!.Tools;

    /// <summary>Whether the read-only desktop tools are offered to the host at all.</summary>
    public bool DesktopEnabled => _options.DesktopRead && _desktop != null;

    private void NegotiateDesktop(HostInstance inst, JsonElement hello)
    {
        if (!DesktopEnabled) return;
        if (!hello.TryGetProperty("desktop", out var d) || d.ValueKind != JsonValueKind.Object ||
            !d.TryGetProperty("proto", out var p) || !p.TryGetInt32(out int proto) || proto != 2 ||
            !d.TryGetProperty("tools", out var t) || t.ValueKind != JsonValueKind.Array)
        {
            _logger.LogWarning("[AgentHost] Host did not negotiate protocol v2; desktop tools stay disabled for this host.");
            return;
        }
        var offered = new HashSet<string>(OfferedDesktopTools, StringComparer.Ordinal);
        var agreed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var e in t.EnumerateArray())
        {
            string? name = e.ValueKind == JsonValueKind.String ? e.GetString() : null;
            if (name == null || !offered.Contains(name))
            {
                OnInstanceViolation(inst, "host claimed a desktop tool the daemon did not offer");
                return;
            }
            agreed.Add(name);
        }
        inst.DesktopTools = agreed;
        _logger.LogInformation("[AgentHost] Protocol v2 negotiated: read-only desktop tools {Tools}.", string.Join(", ", agreed));
    }

    private void OnInstanceCall(HostInstance inst, JsonElement m, int lineChars)
    {
        if (inst.DesktopTools.Count == 0) { OnInstanceViolation(inst, "v2 call before protocol negotiation"); return; }
        string kind = m.GetProperty("kind").GetString()!;
        string? callId = m.TryGetProperty("callId", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
        var idMatch = callId == null ? null : CallIdPattern.Match(callId);
        if (idMatch is not { Success: true }) { OnInstanceViolation(inst, "v2 message without a valid callId"); return; }

        if (kind == "call.cancel")
        {
            if (m.EnumerateObject().Any(p => p.Name is not ("v" or "kind" or "callId"))) { OnInstanceViolation(inst, "unknown field in call.cancel"); return; }
            if (inst.Calls.TryGetValue(callId!, out var running))
            {
                inst.HostCancelled[callId!] = 0;
                try { running.Cancel(); } catch (ObjectDisposedException) { }
            }
            return;
        }

        foreach (var p in m.EnumerateObject())
            if (!CallFields.Contains(p.Name)) { OnInstanceViolation(inst, "unknown field in call"); return; }

        // From here on, problems are answered (the host may keep running); nothing is executed.
        if (lineChars > MaxCallLineChars) { _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("message_too_large", $"A call may not exceed {MaxCallLineChars} characters.")); return; }
        if (!inst.TryAdvanceCallSeq(long.Parse(idMatch.Groups[1].Value)))
        {
            _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("duplicate_call", "This call id was already used; the call was not executed again."));
            return;
        }

        string? taskId = m.TryGetProperty("taskId", out var tEl) && tEl.ValueKind == JsonValueKind.String ? tEl.GetString() : null;
        if (taskId == null || !_tasks.TryGetValue(taskId, out var rec) || rec.InstanceEpoch != inst.Epoch || rec.State != "running")
        {
            _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("task_not_running", "The call does not belong to a running task of this host."));
            return;
        }
        if (EmergencyStopped) { _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active.")); return; }

        string? tool = m.TryGetProperty("tool", out var toolEl) && toolEl.ValueKind == JsonValueKind.String ? toolEl.GetString() : null;
        if (tool == null || !inst.DesktopTools.Contains(tool))
        {
            _logger.LogWarning("[AgentHost] Refused call to unavailable operation '{Tool}' for task {TaskId}.", tool?.Length > 64 ? tool[..64] : tool, taskId);
            _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("unknown_tool", "This operation is not available to the agent."));
            return;
        }
        if (!m.TryGetProperty("args", out var args) || args.ValueKind != JsonValueKind.Object)
        {
            _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("invalid_args", "args must be an object."));
            return;
        }
        int deadline = DefaultCallDeadlineMs;
        if (m.TryGetProperty("deadlineMs", out var dl) && (!dl.TryGetInt32(out deadline) || deadline < 100))
        {
            _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("invalid_args", "deadlineMs must be an integer of at least 100."));
            return;
        }
        // Read-only calls are short; an approval-gated request may wait for the user (bounded by the approval's lifetime).
        deadline = Math.Min(deadline, IsActionTool(tool) ? _actions!.MaxCallMs : DefaultCallDeadlineMs);

        // The call's cancellation is registered synchronously, before the work is scheduled: lines are read in order,
        // so a call.cancel (or the task ending) that follows this call can never miss it.
        CancellationTokenSource linked;
        CancellationTokenSource deadlineCts;
        lock (rec)
        {
            if (rec.State != "running") { _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("task_not_running", "The task is no longer running.")); return; }
            if (rec.ActiveCallId != null) { _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("busy", "This task already has a call in progress.")); return; }
            if (!inst.TryRateLimit(MaxCallsPerMinute)) { _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("rate_limited", "Too many desktop calls; wait a moment.")); return; }
            if (IsActionTool(tool) && IsInputTool(tool))
            {
                if (rec.InputRequests >= MaxInputRequestsPerTask)
                {
                    _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("action_limit", $"This task already asked for {MaxInputRequestsPerTask} input approvals; it will not ask again."));
                    return;
                }
                rec.InputRequests++;
            }
            else if (IsActionTool(tool) && !DAsk.Daemon.Automation.Workflows.WorkflowService.IsUnmetered(tool) && !DAsk.Daemon.Automation.Plugins.PluginService.IsUnmetered(tool) && !DAsk.Daemon.Automation.Desktop.WindowTextReadService.IsUnmetered(tool))
            {
                if (rec.ActionRequests >= MaxActionRequestsPerTask)
                {
                    _ = ReplyAsync(inst, callId!, DesktopCallResult.Fail("action_limit", "This task already asked for an approval; it will not ask again."));
                    return;
                }
                rec.ActionRequests++;
            }
            deadlineCts = new CancellationTokenSource(deadline);
            try
            {
                linked = CancellationTokenSource.CreateLinkedTokenSource(inst.Lifetime.Token, rec.CallsCts.Token, deadlineCts.Token);
            }
            catch (ObjectDisposedException)
            {
                deadlineCts.Dispose();
                _ = ReplyAsync(inst, callId!, DesktopCallResult.Cancelled());
                return;
            }
            rec.ActiveCallId = callId;
            inst.Calls[callId!] = linked;
        }
        var cloned = args.Clone();
        _ = Task.Run(() => RunCallAsync(inst, rec, callId!, tool, cloned, deadline, linked, deadlineCts), CancellationToken.None);
    }

    private async Task RunCallAsync(HostInstance inst, AgentTaskRecord rec, string callId, string tool, JsonElement args, int deadlineMs,
        CancellationTokenSource linked, CancellationTokenSource deadline)
    {
        DesktopCallResult result;
        try
        {
            _logger.LogInformation("[AgentHost] Desktop call {CallId} {Tool} for task {TaskId} (session {Session}).", callId, tool, rec.TaskId, rec.OwnerSessionId);
            result = linked.IsCancellationRequested ? DesktopCallResult.Cancelled()
                : IsActionTool(tool)
                    // The owner is the daemon's record of who submitted the task; nothing in the call can name it.
                    ? await _actions!.ExecuteAsync(tool, args, new DesktopActionContext(rec.TaskId, callId, rec.OwnerSessionId), linked.Token)
                    : await _desktop!.ExecuteAsync(tool, args, linked.Token);
            if (result.Status == "cancelled" && deadline.IsCancellationRequested && !inst.HostCancelled.ContainsKey(callId) &&
                !rec.CallsCts.IsCancellationRequested && !inst.Lifetime.IsCancellationRequested)
                result = DesktopCallResult.Fail("deadline_exceeded", $"The operation did not finish within {deadlineMs} ms.");
            // A result produced after its call was cancelled is not delivered as a success.
            else if (result.Status == "ok" && (inst.HostCancelled.ContainsKey(callId) || rec.CallsCts.IsCancellationRequested))
                result = DesktopCallResult.Cancelled();
        }
        catch (ObjectDisposedException) { result = DesktopCallResult.Cancelled(); }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[AgentHost] Desktop call {CallId} failed.", callId);
            result = DesktopCallResult.Fail("internal_error", "The desktop operation failed.");
        }
        finally
        {
            lock (rec)
            {
                inst.Calls.TryRemove(callId, out _);
                if (rec.ActiveCallId == callId) rec.ActiveCallId = null;
            }
            inst.HostCancelled.TryRemove(callId, out _);
        }
        await ReplyAsync(inst, callId, result);
        // Disposed only after removal, so a late call.cancel finds nothing (or catches ObjectDisposedException).
        linked.Dispose();
        deadline.Dispose();
    }

    /// <summary>Exactly one reply per call. Oversized results are replaced by an error, never truncated into invalid JSON.</summary>
    private async Task ReplyAsync(HostInstance inst, string callId, DesktopCallResult r)
    {
        string line = JsonSerializer.Serialize(new
        {
            v = 2, kind = "reply", callId, status = r.Status, result = r.Result,
            error = r.Error == null ? null : new { code = r.Error.Code, message = r.Error.Message, candidates = r.Error.Candidates },
        }, ReplyJson);
        if (line.Length > MaxReplyChars)
        {
            line = JsonSerializer.Serialize(new
            {
                v = 2, kind = "reply", callId, status = "error",
                error = new { code = "result_too_large", message = "The result was too large to return; ask about a more specific window." },
            }, ReplyJson);
        }
        await inst.SendLineAsync(line);
    }
}
