using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Files;

public sealed class NoteOptions
{
    public bool Enabled { get; init; }
    /// <summary>The ONLY folder notes are written to. The agent never names a path: only a title and the text.</summary>
    public string NotesDir { get; init; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "D-ASK Notes");
    /// <summary>Tests only: replaces the file write (to simulate a failing or corrupting disk). Null: the real write.</summary>
    public Func<string, byte[], Task>? WriteOverride { get; init; }
}

/// <summary>
/// notes.create: the daemon is the authority. The agent may only ASK to create ONE new plain-text note from a title and
/// the exact text. The daemon:
///   - validates both (a plain title that is also a safe file name; text bounded, displayable, no control characters),
///   - derives the ONLY possible path itself: &lt;NotesDir&gt;\&lt;title&gt;.txt (no link or junction, not hidden or system),
///   - shows the exact title, file and text in the HUD for approval (same policy engine, digest, owner session, liveness,
///     expiry and Emergency Stop generation as every other action),
///   - on approval re-validates, creates the file with CreateNew (never overwriting anything), writes UTF-8 without BOM,
///   - verifies by reading the file back byte for byte, and removes its own file if that fails (never reported as done).
/// Off unless AgentHost:Notes is true AND an audit journal exists.
/// </summary>
public sealed class NoteCreateRequestService : IDesktopActionRequestService
{
    public const string Create = "notes.create";
    public const string CreateType = DesktopActionTypes.FilesCreateNote;
    public const int MaxTextChars = 2000;          // the HUD shows every parameter in full, up to 2000 characters
    public const string Extension = ".txt";

    private static readonly Regex SafeTitle = new(@"^[\p{L}\p{N}][\p{L}\p{N} _.,'()&+-]{0,59}$");
    private static readonly Regex Reserved = new(@"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", RegexOptions.IgnoreCase);

    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly NoteOptions _opts;
    private readonly TimeSpan _ttl;
    private readonly ILogger? _logger;
    private readonly string? _dir;

    public NoteCreateRequestService(ActionPolicyEngine policy, Func<bool> isStopped, Func<ulong> generation, IEvidenceRecorder? evidence,
        NoteOptions options, TimeSpan? approvalTtl = null, ILogger? logger = null)
    {
        _policy = policy; _isStopped = isStopped; _generation = generation; _evidence = evidence; _opts = options;
        _ttl = approvalTtl ?? TimeSpan.FromSeconds(60); _logger = logger;
        string d = options.NotesDir ?? "";
        _dir = !string.IsNullOrWhiteSpace(d) && Path.IsPathFullyQualified(d) && !d.StartsWith(@"\\", StringComparison.Ordinal) && d.IndexOf(':', 2) < 0
            ? Path.TrimEndingDirectorySeparator(Path.GetFullPath(d)) : null;
    }

    public IReadOnlyList<string> Tools => _opts.Enabled && _evidence != null && _dir != null ? new[] { Create } : Array.Empty<string>();
    public int MaxCallMs => (int)Math.Min(_ttl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + 30_000;

    // ── Validation (pure; used before approval AND again right before acting) ───────────────────────────────────────

    public static bool IsSafeTitle(string t) => SafeTitle.IsMatch(t) && !Reserved.IsMatch(t) && !t.EndsWith('.') && !t.EndsWith(' ') && !t.Contains("..");

    /// <summary>Text the HUD can show exactly: no control characters except line feed and tab, no bidirectional overrides, no lone surrogates.</summary>
    public static string? CheckText(string text)
    {
        if (text.Length is 0 or > MaxTextChars) return $"the note text must be 1 to {MaxTextChars} characters";
        if (string.IsNullOrWhiteSpace(text)) return "the note text is empty";
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c is '\n' or '\t') continue;
            if (char.IsControl(c)) return "the note text contains control characters";
            if (c is >= '‪' and <= '‮' || c is >= '⁦' and <= '⁩') return "the note text contains direction-override characters";
            if (char.IsHighSurrogate(c)) { if (i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) { i++; continue; } return "the note text is not valid Unicode"; }
            if (char.IsLowSurrogate(c)) return "the note text is not valid Unicode";
        }
        return null;
    }

    /// <summary>Strict argument parsing: { title, text }. Nothing unknown, nothing unbounded, no path of any kind.</summary>
    public static string? Parse(JsonElement args, out string title, out string text)
    {
        title = ""; text = "";
        if (args.ValueKind != JsonValueKind.Object) return "arguments must be an object";
        foreach (var p in args.EnumerateObject()) if (p.Name is not ("title" or "text")) return "unknown argument (only title and text)";
        if (!args.TryGetProperty("title", out var t) || t.ValueKind != JsonValueKind.String || t.GetString() is not { } ts || !IsSafeTitle(ts))
            return "the title must be 1 to 60 letters, digits, spaces or simple punctuation (it becomes the file name)";
        if (!args.TryGetProperty("text", out var x) || x.ValueKind != JsonValueKind.String || x.GetString() is not { } xs) return "text is required";
        if (CheckText(xs) is { } bad) return bad;
        title = ts; text = xs;
        return null;
    }

    private static bool IsLinkOrHidden(FileSystemInfo fi) =>
        (fi.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Hidden | FileAttributes.System)) != 0;

    /// <summary>The notes folder (existing: not a link, junction, hidden or system folder; missing: its parent exists and is not a link) and the free file path.</summary>
    public string? CheckTarget(string title, out string file)
    {
        file = "";
        if (_dir == null) return "no notes folder is configured";
        var di = new DirectoryInfo(_dir);
        if (di.Exists)
        {
            if (IsLinkOrHidden(di)) return "the notes folder is a link, hidden or system folder";
        }
        else
        {
            if (File.Exists(_dir)) return "the notes folder path is a file";
            if (di.Parent is not { Exists: true } parent) return "the notes folder's parent does not exist";
            if ((parent.Attributes & FileAttributes.ReparsePoint) != 0) return "the notes folder's parent is a link or junction";
        }
        string path = Path.Combine(_dir, title + Extension);
        // The file must be directly inside the notes folder (no separators can reach here, but the decision is made on the full path).
        if (!string.Equals(Path.GetDirectoryName(Path.GetFullPath(path)), _dir, StringComparison.OrdinalIgnoreCase)) return "the note would not be inside the notes folder";
        if (File.Exists(path) || Directory.Exists(path)) return $"a note named {title}{Extension} already exists; nothing is overwritten";
        file = path;
        return null;
    }

    // ── Call ────────────────────────────────────────────────────────────────────────────────────────────────────────

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (!Tools.Contains(tool)) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active. Nothing was written.");
        if (Parse(args, out var title, out var text) is { } bad) return Refuse(ctx, "invalid_args", bad);
        if (CheckTarget(title, out var file) is { } badTarget) return Refuse(ctx, "target_refused", badTarget);

        byte[] bytes = new UTF8Encoding(false).GetBytes(text);
        var parameters = new Dictionary<string, string>
        {
            ["title"] = title,
            ["file"] = file,
            ["folder"] = _dir!,
            ["text"] = text,
            ["textLength"] = text.Length.ToString(),
            ["format"] = "Plain text (UTF-8), exactly the text shown, nothing added.",
            ["overwrite"] = "Never: if a note with this name already exists, nothing is written.",
            ["execution"] = "Written once, right after your approval, by the D-ASK daemon, then read back to verify it. Emergency Stop stops it.",
        };
        var (approved, request, fail) = await ApproveAsync(parameters, $"D-ASK asks to create the note \"{title}\" ({text.Length} characters).", ctx, ct);
        if (!approved) return fail!;

        // Re-validate right before acting (the folder may have changed while the card was shown).
        if (CheckTarget(title, out var file2) is not null || !string.Equals(file, file2, StringComparison.OrdinalIgnoreCase))
            return DesktopCallResult.Fail("changed", "The notes folder changed after your approval (or the note now exists); nothing was written.");
        if (ct.IsCancellationRequested || _isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Stopped before writing. Nothing was written.");

        bool created = false;
        string? problem = null;
        try
        {
            Directory.CreateDirectory(_dir!);
            if (IsLinkOrHidden(new DirectoryInfo(_dir!))) problem = "the notes folder is a link, hidden or system folder";
            // Test hook: the target was just checked to be free, so a file there now was made by this write.
            else if (_opts.WriteOverride != null) { try { await _opts.WriteOverride(file, bytes); } finally { created = File.Exists(file); } }
            else
            {
                // CreateNew: fails if anything has that name, so nothing is ever overwritten.
                using var fs = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
                created = true;
                await fs.WriteAsync(bytes, CancellationToken.None);
                fs.Flush(flushToDisk: true);
            }
        }
        catch (IOException ex) when (File.Exists(file) && !created) { problem = $"a file of that name appeared ({ex.GetType().Name}); nothing was overwritten"; }
        catch (Exception ex) { problem = $"the note could not be written ({ex.GetType().Name})"; }

        // Verify: the file exists where it should, is a plain file, and holds exactly the approved bytes.
        bool verified = false;
        string? sha = null;
        if (problem == null)
        {
            try
            {
                var fi = new FileInfo(file);
                byte[] back = fi.Exists && !IsLinkOrHidden(fi) ? await File.ReadAllBytesAsync(file, CancellationToken.None) : Array.Empty<byte>();
                verified = fi.Exists && back.AsSpan().SequenceEqual(bytes);
                if (verified) sha = Convert.ToHexString(SHA256.HashData(back)).ToLowerInvariant();
                else problem = "the note did not read back exactly as approved";
            }
            catch (Exception ex) { problem = $"the note could not be read back ({ex.GetType().Name})"; }
        }
        bool removed = false;
        if (!verified && created)
        {
            // Our own new file only (CreateNew): never leave a partial or wrong note behind as if it were done.
            try { File.Delete(file); removed = !File.Exists(file); } catch { }
        }

        await AuditAsync(verified ? "NoteCreated" : "NoteCreateFailed", request!, ctx, verified ? $"{bytes.Length} bytes; sha256 {sha}" : problem ?? "not verified");
        _logger?.LogInformation("[Notes] notes.create for task {TaskId}: \"{Title}\" verified={Verified}{Problem}.", ctx.TaskId, title, verified, problem != null ? $" ({problem})" : "");
        if (!verified)
            return DesktopCallResult.Fail("not_verified", $"The note was not created: {problem}.{(removed ? " The partial file was removed." : "")}");
        return DesktopCallResult.Ok(new
        {
            decision = "approved", consumed = true, executed = true, verified = true,
            title, file, folder = _dir, bytes = bytes.Length, chars = text.Length, sha256 = sha,
        });
    }

    // ── Approval and audit ─────────────────────────────────────────────────────────────────────────────────────────

    private async Task<(bool ok, ActionApprovalRequest? request, DesktopCallResult? fail)> ApproveAsync(Dictionary<string, string> parameters,
        string reason, DesktopActionContext ctx, CancellationToken ct)
    {
        var (_, risk, _) = _policy.EvaluatePolicy(CreateType, new Dictionary<string, string>(), "D-ASK notes");
        if (risk != ActionRiskLevel.Elevated) return (false, null, DesktopCallResult.Fail("approval_refused", "Creating a note is not classified for approval. Nothing was written."));
        using var self = Process.GetCurrentProcess();
        var started = new DateTimeOffset(self.StartTime.ToUniversalTime(), TimeSpan.Zero);
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"), ActionId = Guid.NewGuid().ToString("N"), ActionType = CreateType, ActionParameters = parameters,
            TargetProcessName = "D-ASK notes", TargetWindowTitle = parameters["file"].Length > 500 ? parameters["file"][..500] : parameters["file"], TargetHwnd = 0,
            TargetProcessId = self.Id, TargetProcessCreationTime = started, SessionId = ctx.OwnerSessionId, StopGeneration = _generation(),
            RiskLevel = risk.ToString(), CreatedAtUtc = DateTimeOffset.UtcNow, ExpiresAtUtc = DateTimeOffset.UtcNow + _ttl, Reason = reason,
        };
        await AuditAsync("NoteCreateRequested", request, ctx, $"agent call {ctx.CallId}");
        ActionApprovalResponse decision = await _policy.RequestApprovalAsync(request, ct);
        if (ct.IsCancellationRequested) return (false, request, DesktopCallResult.Cancelled());
        if (!decision.Approved)
        {
            var (code, message) = decision.DecisionSource switch
            {
                "UserExplicitConfirmation" => ("approval_denied", "You declined. Nothing was written."),
                "TimeoutDenied" => ("approval_expired", "The approval expired before a decision. Nothing was written."),
                "EmergencyStopDenied" or "StaleGenerationDenied" => ("emergency_stopped", "Emergency Stop cancelled the request. Nothing was written."),
                "SessionDisconnectedDenied" => ("hud_unavailable", "The HUD is not connected, so the request could not be approved. Nothing was written."),
                "IntegrityMismatch" => ("approval_refused", "The request could not be offered for approval exactly as it would be performed. Nothing was written."),
                _ => ("approval_denied", "The request was not approved. Nothing was written."),
            };
            await AuditAsync("NoteCreateNotApproved", request, ctx, decision.DecisionSource ?? "denied");
            return (false, request, DesktopCallResult.Fail(code, message));
        }
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters,
            request.TargetProcessName, 0, self.Id, started, ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid || _evidence == null)
        {
            await AuditAsync("NoteCreateApprovalInvalid", request, ctx, error ?? "invalid");
            return (false, request, DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was written."));
        }
        // Required record: no audit, no action.
        await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
        {
            EventType = "NoteCreateAdmitted", Source = "NoteCreateRequestService", ActionId = request.ActionId, ApprovalId = request.ApprovalId,
            SessionId = request.SessionId, RiskLevel = request.RiskLevel, StopGeneration = request.StopGeneration, Decision = "Admitted",
            Reason = "approval consumed once", DetailsJson = AuditJson.Details(Details(request, ctx)),
        });
        return (true, request, null);
    }

    private DesktopCallResult Refuse(DesktopActionContext ctx, string code, string message)
    {
        _logger?.LogInformation("[Notes] Refused for task {TaskId}: {Code}.", ctx.TaskId, code);
        return DesktopCallResult.Fail(code, message + ". Nothing was written.");
    }

    // The note's text is not copied into the audit record: only its length (the user's content stays in the note).
    private static object Details(ActionApprovalRequest q, DesktopActionContext ctx) => new
    {
        actionType = q.ActionType, taskId = ctx.TaskId, callId = ctx.CallId, file = q.ActionParameters.GetValueOrDefault("file"),
        textLength = q.ActionParameters.GetValueOrDefault("textLength"),
    };

    private async Task AuditAsync(string evt, ActionApprovalRequest q, DesktopActionContext ctx, string reason)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt, Source = "NoteCreateRequestService", ActionId = q.ActionId, ApprovalId = q.ApprovalId, SessionId = q.SessionId,
                RiskLevel = q.RiskLevel, StopGeneration = q.StopGeneration, Decision = evt, Reason = AuditJson.Bound(reason),
                DetailsJson = AuditJson.Details(Details(q, ctx)),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[Notes] Audit record {Event} failed.", evt); }
    }
}
