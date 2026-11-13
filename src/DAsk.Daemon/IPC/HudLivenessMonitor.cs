using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.IPC;

public enum HudLivenessState
{
    /// <summary>Connected and authenticated, but no valid heartbeat yet.</summary>
    Unknown,
    /// <summary>A valid heartbeat renewed the lease and the panic hotkey is confirmed.</summary>
    Live,
    /// <summary>The lease lapsed, or a heartbeat proved a loop unresponsive. Recovery needs a fresh, valid heartbeat.</summary>
    Expired,
    /// <summary>The session is gone. Nothing can revive it; a reconnect is a new session that starts at Unknown.</summary>
    Ended,
}

public readonly record struct HeartbeatVerdict(bool Accepted, string? Reason);

/// <summary>
/// Phase 7B.1a, F1: the daemon's view of whether each HUD can still stop things.
///
/// Pipe connectivity is not liveness. A session is <see cref="HudLivenessState.Live"/> only while all hold:
/// <list type="number">
/// <item>its most recent <c>PanicHotkeyStatusNotification</c> said the hotkey is available;</item>
/// <item>a heartbeat accepted within <see cref="DaemonOptions.HeartbeatLeaseMs"/> renewed its lease.</item>
/// </list>
/// A heartbeat is accepted only if its sequence is strictly greater than any seen on this session (no replay or
/// reordering), its timestamp is within <see cref="DaemonOptions.HeartbeatMaxSkewMs"/> of the daemon clock (a ping
/// delayed in a buffer cannot revive a lease), it reports the hotkey registered, and both of its loop
/// acknowledgements cover the previous ping (the HUD UI event loop and the panic-hotkey message loop answered the probe
/// posted one interval earlier). A heartbeat that proves a loop unresponsive or the hotkey unregistered expires the
/// lease at once rather than waiting for it to lapse. After any expiry the session's hotkey confirmation is cleared,
/// so recovery requires both a new <c>PanicHotkeyStatusNotification</c> (available) and a fresh valid heartbeat.
///
/// Panic-hotkey availability published to <see cref="ActionExecutionEngine"/> is derived: true only while at least
/// one session is Live. Losing the lease (lapse, failed proof, hotkey withdrawn, disconnect) also invalidates that
/// session's approvals and cancels its actions. The Emergency Stop latch is never touched here.
/// </summary>
public sealed class HudLivenessMonitor : IDisposable
{
    private sealed class Entry
    {
        public HudLivenessState State = HudLivenessState.Unknown;
        public long LastSequence;
        public DateTimeOffset LeaseExpiresAt = DateTimeOffset.MinValue;
        public bool HotkeyReportedAvailable;
        public string? LastReason;
    }

    private readonly object _lock = new();
    private readonly Dictionary<string, Entry> _sessions = new(StringComparer.Ordinal);
    private readonly ILogger _logger;
    private readonly ActionExecutionEngine? _engine;
    private readonly ActionPolicyEngine? _policy;
    private readonly IEvidenceRecorder? _evidence;
    private readonly Func<DateTimeOffset> _clock;
    private readonly TimeSpan _lease;
    private readonly TimeSpan _maxSkew;
    private readonly Timer? _sweepTimer;
    private bool _publishedAvailable;

    public HudLivenessMonitor(
        ILogger logger,
        ActionExecutionEngine? engine,
        ActionPolicyEngine? policy,
        IEvidenceRecorder? evidence,
        int leaseMs = 12_000,
        int maxSkewMs = 3_000,
        Func<DateTimeOffset>? clock = null,
        bool startSweepTimer = true)
    {
        _logger = logger;
        _engine = engine;
        _policy = policy;
        _evidence = evidence;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        _lease = TimeSpan.FromMilliseconds(leaseMs > 0 ? leaseMs : 12_000);
        _maxSkew = TimeSpan.FromMilliseconds(maxSkewMs > 0 ? maxSkewMs : 3_000);
        if (startSweepTimer) _sweepTimer = new Timer(_ => Sweep(), null, 500, 500);
    }

    public TimeSpan Lease => _lease;

    public HudLivenessState GetState(string sessionId)
    {
        lock (_lock) return _sessions.TryGetValue(sessionId, out var e) ? Effective(e) : HudLivenessState.Ended;
    }

    /// <summary>True only for a session that is Live right now (lease not lapsed, even before the next sweep).</summary>
    public bool IsLive(string sessionId)
    {
        lock (_lock) return _sessions.TryGetValue(sessionId, out var e) && Effective(e) == HudLivenessState.Live;
    }

    public bool AnyLive
    {
        get { lock (_lock) return _sessions.Values.Any(e => Effective(e) == HudLivenessState.Live); }
    }

    /// <summary>The sessions that are Live right now (scheduled workflows run on behalf of one of these, or not at all).</summary>
    public IReadOnlyList<string> LiveSessions
    {
        get { lock (_lock) return _sessions.Where(kv => Effective(kv.Value) == HudLivenessState.Live).Select(kv => kv.Key).OrderBy(k => k, StringComparer.Ordinal).ToList(); }
    }

    private HudLivenessState Effective(Entry e) =>
        e.State == HudLivenessState.Live && _clock() >= e.LeaseExpiresAt ? HudLivenessState.Expired : e.State;

    public void OnSessionAuthenticated(string sessionId)
    {
        lock (_lock) _sessions[sessionId] = new Entry();
    }

    public void OnHotkeyStatus(string sessionId, bool available, string reason)
    {
        bool expire;
        lock (_lock)
        {
            if (!_sessions.TryGetValue(sessionId, out var e) || e.State == HudLivenessState.Ended) return;
            e.HotkeyReportedAvailable = available;
            // A withdrawn hotkey ends liveness now. Availability alone never establishes it: a heartbeat must follow.
            expire = !available && e.State == HudLivenessState.Live;
            if (!available) e.LastReason = "panic hotkey reported unavailable";
        }
        if (expire) Expire(sessionId, $"panic hotkey reported unavailable ({reason})");
        else Publish();
    }

    public HeartbeatVerdict OnHeartbeat(string sessionId, HeartbeatPing ping)
    {
        string? expireReason = null;
        HeartbeatVerdict verdict;
        bool becameLive = false;
        lock (_lock)
        {
            if (!_sessions.TryGetValue(sessionId, out var e) || e.State == HudLivenessState.Ended)
                return new HeartbeatVerdict(false, "unknown or ended session");

            var now = _clock();
            if (ping.Sequence <= 0 || ping.Sequence <= e.LastSequence)
                return new HeartbeatVerdict(false, "replayed or out-of-order heartbeat sequence");
            e.LastSequence = ping.Sequence;

            if ((now - ping.Timestamp).Duration() > _maxSkew)
                return new HeartbeatVerdict(false, "stale or delayed heartbeat (timestamp outside the allowed window)");

            long required = ping.Sequence - 1;
            if (!ping.HotkeyRegistered)
                verdict = new HeartbeatVerdict(false, "panic hotkey not registered");
            else if (ping.EventLoopAck < required || ping.EventLoopAck > ping.Sequence)
                verdict = new HeartbeatVerdict(false, "HUD event loop did not answer the liveness probe");
            else if (ping.HotkeyAck < required || ping.HotkeyAck > ping.Sequence)
                verdict = new HeartbeatVerdict(false, "panic-hotkey loop did not answer the liveness probe");
            else if (!e.HotkeyReportedAvailable)
                verdict = new HeartbeatVerdict(false, "no hotkey registration confirmation on this session");
            else
                verdict = new HeartbeatVerdict(true, null);

            if (verdict.Accepted)
            {
                becameLive = Effective(e) != HudLivenessState.Live;
                e.State = HudLivenessState.Live;
                e.LeaseExpiresAt = now + _lease;
                e.LastReason = null;
            }
            else if (Effective(e) == HudLivenessState.Live)
            {
                // A fresh, in-order ping that proves the HUD unresponsive ends the lease immediately.
                expireReason = verdict.Reason;
            }
            else
            {
                e.LastReason = verdict.Reason;
            }
        }

        if (expireReason != null) Expire(sessionId, expireReason);
        else if (becameLive)
        {
            _logger.LogInformation("[HUD LIVENESS] Session {SessionId} is live (heartbeat and panic hotkey confirmed).", sessionId);
            Audit("HudLivenessEstablished", sessionId, "Live", "Valid heartbeat with event-loop and hotkey-loop proof");
            Publish();
        }
        return verdict;
    }

    public void OnSessionEnded(string sessionId)
    {
        bool wasLive;
        lock (_lock)
        {
            if (!_sessions.TryGetValue(sessionId, out var e)) return;
            wasLive = Effective(e) == HudLivenessState.Live;
            e.State = HudLivenessState.Ended;
            _sessions.Remove(sessionId);
        }
        if (wasLive)
        {
            _logger.LogWarning("[HUD LIVENESS] Session {SessionId} ended while live; panic-hotkey availability withdrawn.", sessionId);
            Audit("HudLivenessLost", sessionId, "Ended", "HUD session disconnected");
        }
        Publish();
    }

    /// <summary>Expires every Live session whose lease has lapsed. Runs on a timer; tests call it directly.</summary>
    public void Sweep()
    {
        List<string> lapsed;
        lock (_lock)
        {
            var now = _clock();
            lapsed = _sessions.Where(kv => kv.Value.State == HudLivenessState.Live && now >= kv.Value.LeaseExpiresAt)
                              .Select(kv => kv.Key).ToList();
        }
        foreach (var id in lapsed) Expire(id, "heartbeat lease expired");
        if (lapsed.Count == 0) Publish();
    }

    private void Expire(string sessionId, string reason)
    {
        lock (_lock)
        {
            if (!_sessions.TryGetValue(sessionId, out var e) || e.State == HudLivenessState.Ended) return;
            e.State = HudLivenessState.Expired;
            e.LeaseExpiresAt = DateTimeOffset.MinValue;
            e.LastReason = reason;
            // Recovery needs a NEW hotkey registration confirmation as well as a fresh heartbeat: the earlier
            // confirmation described a HUD that has since stopped answering.
            e.HotkeyReportedAvailable = false;
        }
        _logger.LogWarning("[HUD LIVENESS] Session {SessionId} lost liveness: {Reason}. Approvals invalidated, actions cancelled.", sessionId, reason);
        Publish();
        try { _policy?.InvalidateApprovalsForSession(sessionId, $"HUD liveness lost: {reason}"); }
        catch (Exception ex) { _logger.LogError(ex, "[HUD LIVENESS] Approval invalidation failed for {SessionId}.", sessionId); }
        try { _engine?.CancelActionsForSession(sessionId); }
        catch (Exception ex) { _logger.LogError(ex, "[HUD LIVENESS] Action cancellation failed for {SessionId}.", sessionId); }
        Audit("HudLivenessLost", sessionId, "Expired", reason);
    }

    /// <summary>Publishes derived panic-hotkey availability to the engine when it changes.</summary>
    private void Publish()
    {
        bool any;
        lock (_lock)
        {
            any = _sessions.Values.Any(e => Effective(e) == HudLivenessState.Live);
            if (any == _publishedAvailable) return;
            _publishedAvailable = any;
        }
        if (any) _engine?.SetPanicHotkeyStatus(true, "Panic hotkey confirmed by a live HUD (valid heartbeat lease)");
        else _engine?.SetPanicHotkeyStatus(false, "No live HUD: heartbeat lease lost or HUD disconnected", -2);
    }

    private void Audit(string eventType, string sessionId, string decision, string reason)
    {
        if (_evidence == null) return;
        try
        {
            _ = _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = eventType,
                Source = "HudLivenessMonitor",
                SessionId = sessionId,
                StopGeneration = _engine?.CurrentStopGeneration ?? 0,
                Decision = decision,
                Reason = AuditJson.Bound(reason),
            });
        }
        catch (Exception ex) { _logger.LogWarning(ex, "[HUD LIVENESS] Failed to record audit event."); }
    }

    public void Dispose() => _sweepTimer?.Dispose();
}
