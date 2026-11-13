using DAsk.Daemon.AgentHost;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Workflows;

/// <summary>
/// Runs approved workflow schedules. Every tick, each due schedule is either run — submitted as the ordinary task
/// "Run the workflow \"name\"" on behalf of a LIVE HUD session (the first in order) — or skipped and recorded: no live HUD,
/// Emergency Stop active, the agent host refused it, or more than <see cref="MaxLateness"/> late (missed runs are never
/// caught up). Nothing here can approve anything: each step's actions still need the user's approval at that time.
/// </summary>
public sealed class WorkflowScheduler : BackgroundService
{
    public static readonly TimeSpan MaxLateness = TimeSpan.FromMinutes(5);
    private readonly WorkflowService _workflows;
    private readonly Func<string, string, CancellationToken, Task<(bool ok, string? note)>> _submit;
    private readonly Func<IReadOnlyList<string>> _liveSessions;
    private readonly Func<bool> _isStopped;
    private readonly Func<DateTime> _now;
    private readonly TimeSpan _tick;
    private readonly ILogger? _logger;

    public WorkflowScheduler(WorkflowService workflows, Func<string, string, CancellationToken, Task<(bool ok, string? note)>> submit,
        Func<IReadOnlyList<string>> liveSessions, Func<bool> isStopped, ILogger? logger = null, Func<DateTime>? now = null, TimeSpan? tick = null)
    {
        _workflows = workflows; _submit = submit; _liveSessions = liveSessions; _isStopped = isStopped; _logger = logger;
        _now = now ?? (() => DateTime.Now); _tick = tick ?? TimeSpan.FromSeconds(20);
    }

    public static WorkflowScheduler ForAgentHost(WorkflowService workflows, AgentHostManager host, Func<IReadOnlyList<string>> liveSessions, Func<bool> isStopped, ILogger? logger) =>
        new(workflows, async (objective, session, ct) =>
        {
            var r = await host.SubmitAsync(objective, session, ct);
            return (r.Accepted, r.Accepted ? $"submitted as task {r.TaskId}" : $"not started: {r.RejectionCode}");
        }, liveSessions, isStopped, logger);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await TickAsync(stoppingToken); }
            catch (Exception ex) when (ex is not OperationCanceledException) { _logger?.LogWarning(ex, "[Workflows] Scheduler tick failed."); }
            try { await Task.Delay(_tick, stoppingToken); } catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>One pass over the due schedules. Public for tests.</summary>
    public async Task<List<(string name, string outcome)>> TickAsync(CancellationToken ct)
    {
        var done = new List<(string, string)>();
        if (!_workflows.Enabled) return done;   // disabled: stored schedules never fire
        var now = _now();
        foreach (var w in _workflows.Due(now))
        {
            var s = w.Schedule!;
            var dueAt = WorkflowService.NextDue(s, (s.LastRunUtc ?? s.ApprovedUtc).ToLocalTime())!.Value;
            string note;
            if (now - dueAt > MaxLateness) note = $"missed ({dueAt:yyyy-MM-dd HH:mm}; not caught up)";
            else if (_isStopped()) note = "skipped: Emergency Stop was active";
            else if (_liveSessions() is not { Count: > 0 } live) note = "skipped: the HUD was not connected";
            else
            {
                var (ok, n) = await _submit($"Run the workflow \"{w.Name}\"", live[0], ct);
                note = ok ? n ?? "submitted" : $"skipped: {n}";
            }
            _workflows.MarkRun(w.Name, note);
            _logger?.LogInformation("[Workflows] \"{Name}\" due {Due:yyyy-MM-dd HH:mm}: {Note}.", w.Name, dueAt, note);
            done.Add((w.Name, note));
        }
        return done;
    }
}
