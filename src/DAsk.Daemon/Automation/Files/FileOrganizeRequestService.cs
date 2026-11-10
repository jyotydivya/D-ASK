using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Files;

public sealed class FileOrganizeOptions
{
    public bool Enabled { get; init; }
    /// <summary>The only folders whose files may be organised (and their subfolders).</summary>
    public IReadOnlyList<string> Roots { get; init; } = Array.Empty<string>();
    public string JournalDir { get; init; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D-ASK", "file-undo");
}

/// <summary>
/// File organisation: the daemon is the authority. The agent may only ASK to move named files of ONE folder into
/// subfolders of that same folder (no renames, no other destinations, no deletes). The daemon validates every name and
/// path itself (allowed roots, no links or reparse points, no hidden or system files, nothing overwritten), shows the
/// EXACT list of moves in the HUD for approval (same policy engine, digest, owner session, liveness, expiry and Emergency
/// Stop generation as every other action), and on approval re-validates, writes an undo journal BEFORE moving, performs
/// each move once (never retried, never overwriting), verifies it, and stops at the first problem. Undo is a separate
/// request that is approved the same way and only moves back files that are still exactly as they were left.
/// Off unless AgentHost:FileOrganize is true AND roots are configured AND an audit journal exists.
/// </summary>
public sealed class FileOrganizeRequestService : IDesktopActionRequestService
{
    public const string Organize = "files.organize";
    public const string Undo = "files.undo_organize";
    public const string OrganizeType = "Files.Organize";
    public const string UndoType = "Files.UndoOrganize";
    public const int MaxMoves = 40;
    public const int MaxMovesText = 1900;
    public const string Arrow = " → ";

    private static readonly Regex SafeName = new(@"^[\p{L}\p{N}][\p{L}\p{N} _.,'()&+@#!$%=~\[\]{}-]{0,119}$");
    private static readonly Regex SafeFolderName = new(@"^[\p{L}\p{N}][\p{L}\p{N} _.()&+-]{0,59}$");
    private static readonly Regex Reserved = new(@"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", RegexOptions.IgnoreCase);

    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly FileOrganizeOptions _opts;
    private readonly TimeSpan _ttl;
    private readonly ILogger? _logger;
    private readonly string[] _roots;

    public FileOrganizeRequestService(ActionPolicyEngine policy, Func<bool> isStopped, Func<ulong> generation, IEvidenceRecorder? evidence,
        FileOrganizeOptions options, TimeSpan? approvalTtl = null, ILogger? logger = null)
    {
        _policy = policy; _isStopped = isStopped; _generation = generation; _evidence = evidence; _opts = options;
        _ttl = approvalTtl ?? TimeSpan.FromSeconds(60); _logger = logger;
        _roots = options.Roots.Where(r => !string.IsNullOrWhiteSpace(r) && Path.IsPathFullyQualified(r) && !r.StartsWith(@"\\", StringComparison.Ordinal))
            .Select(r => Path.TrimEndingDirectorySeparator(Path.GetFullPath(r))).Where(Directory.Exists).ToArray();
    }

    public IReadOnlyList<string> Tools => _opts.Enabled && _evidence != null && _roots.Length > 0 ? new[] { Organize, Undo } : Array.Empty<string>();
    public int MaxCallMs => (int)Math.Min(_ttl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + 30_000;

    public sealed record Move(string Name, string Into);
    public sealed record JournalMove(string Name, string Into, long Size, DateTime MtimeUtc, bool Done, bool Undone);
    public sealed record Journal(string Id, string Folder, DateTime CreatedUtc, List<JournalMove> Moves, List<string> CreatedDirs, bool Undone);

    // ── Validation (pure where possible; used before approval AND again right before acting) ─────────────────────────

    public static bool IsSafeName(string n) => SafeName.IsMatch(n) && !Reserved.IsMatch(n) && !n.EndsWith('.') && !n.EndsWith(' ') && n != "." && n != "..";
    public static bool IsSafeFolderName(string n) => SafeFolderName.IsMatch(n) && !Reserved.IsMatch(n) && !n.EndsWith('.') && !n.EndsWith(' ');

    public static string MovesText(IEnumerable<Move> moves) => string.Join("\n", moves.Select(m => $"{m.Name}{Arrow}{m.Into}\\"));

    /// <summary>Strict argument parsing: { folder, moves:[{name, into}] }. Nothing unknown, nothing unbounded.</summary>
    public static string? ParseOrganize(JsonElement args, out string folder, out List<Move> moves)
    {
        folder = ""; moves = new();
        if (args.ValueKind != JsonValueKind.Object) return "arguments must be an object";
        foreach (var p in args.EnumerateObject()) if (p.Name is not ("folder" or "moves")) return "unknown argument";
        if (!args.TryGetProperty("folder", out var f) || f.ValueKind != JsonValueKind.String || f.GetString() is not { Length: > 2 and <= 400 } fs) return "folder is required";
        folder = fs;
        if (!args.TryGetProperty("moves", out var ms) || ms.ValueKind != JsonValueKind.Array) return "moves must be a list";
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var m in ms.EnumerateArray())
        {
            if (m.ValueKind != JsonValueKind.Object) return "each move must be an object";
            foreach (var p in m.EnumerateObject()) if (p.Name is not ("name" or "into")) return "unknown move field";
            string? name = m.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
            string? into = m.TryGetProperty("into", out var i) && i.ValueKind == JsonValueKind.String ? i.GetString() : null;
            if (name == null || !IsSafeName(name)) return "a file name is not allowed (plain file names only)";
            if (into == null || !IsSafeFolderName(into)) return "a subfolder name is not allowed (a plain folder name only)";
            if (!seen.Add(name)) return "a file is listed twice";
            moves.Add(new Move(name, into));
        }
        if (moves.Count is 0 or > MaxMoves) return $"between 1 and {MaxMoves} moves per request";
        if (MovesText(moves).Length > MaxMovesText) return "the list of moves is too long to show for approval; ask for fewer at a time";
        return null;
    }

    private static bool IsLinkOrHidden(FileSystemInfo fi) =>
        (fi.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Hidden | FileAttributes.System)) != 0;

    /// <summary>The folder, canonical, inside an allowed root; no component a link or reparse point; not hidden or system.</summary>
    public string? CheckFolder(string folder, out string canonical)
    {
        canonical = "";
        if (!Path.IsPathFullyQualified(folder) || folder.StartsWith(@"\\", StringComparison.Ordinal) || folder.IndexOf(':', 2) >= 0) return "the folder must be a plain absolute path";
        string full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder));
        if (!string.Equals(full, Path.TrimEndingDirectorySeparator(folder), StringComparison.OrdinalIgnoreCase)) return "the folder path is not in canonical form";
        string? root = _roots.FirstOrDefault(r => full.Equals(r, StringComparison.OrdinalIgnoreCase) || full.StartsWith(r + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
        if (root == null) return "that folder is not one D-ASK may organise";
        var di = new DirectoryInfo(full);
        if (!di.Exists) return "the folder does not exist";
        for (var d = di; d != null && d.FullName.Length >= root.Length; d = d.Parent)
            if ((d.Attributes & FileAttributes.ReparsePoint) != 0) return "the folder is (or is inside) a link or junction";
        if ((di.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0) return "the folder is hidden or a system folder";
        canonical = full;
        return null;
    }

    /// <summary>Every move still possible exactly as listed: a regular file, not hidden or linked; its destination free.</summary>
    public static string? CheckMoves(string folder, IReadOnlyList<Move> moves, out List<(FileInfo src, string dst, bool newDir)> plan)
    {
        plan = new();
        foreach (var m in moves)
        {
            var src = new FileInfo(Path.Combine(folder, m.Name));
            if (!src.Exists) return $"{m.Name} is not a file in that folder";
            if (IsLinkOrHidden(src)) return $"{m.Name} is a link, hidden or system file and is not moved";
            if (string.Equals(m.Into, m.Name, StringComparison.OrdinalIgnoreCase)) return $"{m.Name} cannot be moved into a folder of the same name";
            var dir = new DirectoryInfo(Path.Combine(folder, m.Into));
            if (File.Exists(dir.FullName)) return $"{m.Into} is a file, not a folder";
            if (dir.Exists && IsLinkOrHidden(dir)) return $"{m.Into} is a link, hidden or system folder";
            string dst = Path.Combine(dir.FullName, m.Name);
            if (File.Exists(dst) || Directory.Exists(dst)) return $"{m.Into}\\{m.Name} already exists; nothing is overwritten";
            plan.Add((src, dst, !dir.Exists));
        }
        return null;
    }

    // ── Calls ──────────────────────────────────────────────────────────────────────────────────────────────────────

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (!Tools.Contains(tool)) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active. Nothing was done.");
        return tool == Organize ? await OrganizeAsync(args, ctx, ct) : await UndoAsync(args, ctx, ct);
    }

    private async Task<DesktopCallResult> OrganizeAsync(JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (ParseOrganize(args, out var folderArg, out var moves) is { } bad) return Refuse(ctx, "invalid_args", bad);
        if (CheckFolder(folderArg, out var folder) is { } badFolder) return Refuse(ctx, "folder_refused", badFolder);
        if (CheckMoves(folder, moves, out var plan) is { } badMove) return Refuse(ctx, "move_refused", badMove);
        var newDirs = plan.Where(p => p.newDir).Select(p => Path.GetFileName(Path.GetDirectoryName(p.dst)!)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var parameters = new Dictionary<string, string>
        {
            ["folder"] = folder,
            ["moveCount"] = moves.Count.ToString(),
            ["moves"] = MovesText(moves),
            ["newSubfolders"] = newDirs.Count == 0 ? "(none)" : string.Join(", ", newDirs),
            ["overwrite"] = "Never: if a file of that name already exists in the subfolder, nothing is moved.",
            ["reversible"] = "Yes: an undo record is kept. Say \"undo the last file organisation\" to move them back (asked for approval again).",
            ["execution"] = "Performed once, right after your approval, by the D-ASK daemon; each move is checked again first and verified after. It stops at the first problem; Emergency Stop stops it.",
        };
        var (approved, request, fail) = await ApproveAsync(OrganizeType, parameters, $"D-ASK asks to move {moves.Count} file(s) into subfolders of {Path.GetFileName(folder)}.", folder, ctx, ct);
        if (!approved) return fail!;

        // Re-validate right before acting (the folder may have changed while the card was shown).
        if (CheckFolder(folder, out _) is { } f2 || CheckMoves(folder, moves, out plan) is { } m2)
            return DesktopCallResult.Fail("changed", "The folder changed after your approval; nothing was moved.");
        var journal = new Journal(request!.ApprovalId, folder, DateTime.UtcNow,
            plan.Select((p, i) => new JournalMove(moves[i].Name, moves[i].Into, p.src.Length, p.src.LastWriteTimeUtc, false, false)).ToList(), new List<string>(), false);
        try { SaveJournal(journal); } catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Undo journal could not be written."); return DesktopCallResult.Fail("journal_failed", "The undo record could not be written, so nothing was moved."); }

        int done = 0; string? stopped = null;
        for (int i = 0; i < plan.Count; i++)
        {
            if (ct.IsCancellationRequested || _isStopped()) { stopped = "stopped (Emergency Stop or cancelled)"; break; }
            var (src, dst, newDir) = plan[i];
            try
            {
                string dir = Path.GetDirectoryName(dst)!;
                if (!Directory.Exists(dir)) { Directory.CreateDirectory(dir); if (!journal.CreatedDirs.Contains(dir)) journal.CreatedDirs.Add(dir); }
                long size = src.Length;
                File.Move(src.FullName, dst, overwrite: false);
                bool verified = !File.Exists(src.FullName) && File.Exists(dst) && new FileInfo(dst).Length == size;
                journal.Moves[i] = journal.Moves[i] with { Done = verified };
                SaveJournal(journal);
                if (!verified) { stopped = $"{moves[i].Name} could not be verified after the move"; break; }
                done++;
            }
            catch (Exception ex) { stopped = $"{moves[i].Name}: {ex.GetType().Name}"; break; }
        }
        await AuditAsync("FileOrganizePerformed", request, ctx, $"{done}/{plan.Count} moved{(stopped != null ? "; " + stopped : "")}");
        _logger?.LogInformation("[FileOrganize] files.organize for task {TaskId}: {Done}/{Total} moved, verified={Verified}{Stop}.", ctx.TaskId, done, plan.Count, stopped == null, stopped != null ? $" ({stopped})" : "");
        return DesktopCallResult.Ok(new
        {
            decision = "approved", consumed = true, executed = done > 0, verified = stopped == null && done == plan.Count,
            moved = done, total = plan.Count, folder, journalId = journal.Id, stopped,
            moves = moves.Select((m, i) => new { name = m.Name, into = m.Into, done = journal.Moves[i].Done }).ToArray(),
        });
    }

    private async Task<DesktopCallResult> UndoAsync(JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (args.ValueKind != JsonValueKind.Object || args.EnumerateObject().Any()) return Refuse(ctx, "invalid_args", "undo takes no arguments (it undoes the most recent organisation)");
        Journal? j = LatestJournal();
        if (j == null) return DesktopCallResult.Fail("nothing_to_undo", "There is no file organisation to undo.");
        if (CheckFolder(j.Folder, out _) is { } badFolder) return Refuse(ctx, "folder_refused", badFolder);
        // Only files still exactly as they were left: same size and modification time, and nothing back at the original name.
        var back = new List<JournalMove>();
        foreach (var m in j.Moves.Where(m => m.Done && !m.Undone))
        {
            var at = new FileInfo(Path.Combine(j.Folder, m.Into, m.Name));
            if (!at.Exists || IsLinkOrHidden(at) || at.Length != m.Size || at.LastWriteTimeUtc != m.MtimeUtc) continue;
            if (File.Exists(Path.Combine(j.Folder, m.Name)) || Directory.Exists(Path.Combine(j.Folder, m.Name))) continue;
            back.Add(m);
        }
        if (back.Count == 0) return DesktopCallResult.Fail("nothing_to_undo", "None of the moved files is still exactly where D-ASK left it, so nothing can be moved back.");
        string text = string.Join("\n", back.Select(m => $"{m.Into}\\{m.Name}{Arrow}(back to {Path.GetFileName(j.Folder)})"));
        if (text.Length > 2000) { back = back.Take(20).ToList(); text = string.Join("\n", back.Select(m => $"{m.Into}\\{m.Name}{Arrow}(back to {Path.GetFileName(j.Folder)})")); }
        var parameters = new Dictionary<string, string>
        {
            ["folder"] = j.Folder,
            ["moveCount"] = back.Count.ToString(),
            ["moves"] = text,
            ["organisedAtUtc"] = j.CreatedUtc.ToString("u"),
            ["overwrite"] = "Never: a file is moved back only if nothing now has its original name.",
            ["execution"] = "Performed once, right after your approval, by the D-ASK daemon; each file is checked again first. Empty subfolders D-ASK created are removed.",
        };
        var (approved, request, fail) = await ApproveAsync(UndoType, parameters, $"D-ASK asks to move {back.Count} file(s) back in {Path.GetFileName(j.Folder)}.", j.Folder, ctx, ct);
        if (!approved) return fail!;
        int done = 0; string? stopped = null;
        foreach (var m in back)
        {
            if (ct.IsCancellationRequested || _isStopped()) { stopped = "stopped (Emergency Stop or cancelled)"; break; }
            var from = Path.Combine(j.Folder, m.Into, m.Name); var to = Path.Combine(j.Folder, m.Name);
            var fi = new FileInfo(from);
            if (!fi.Exists || fi.Length != m.Size || fi.LastWriteTimeUtc != m.MtimeUtc || File.Exists(to)) { stopped = $"{m.Name} changed after your approval"; break; }
            try { File.Move(from, to, overwrite: false); } catch (Exception ex) { stopped = $"{m.Name}: {ex.GetType().Name}"; break; }
            if (File.Exists(from) || !File.Exists(to)) { stopped = $"{m.Name} could not be verified"; break; }
            int idx = j.Moves.FindIndex(x => x.Name == m.Name);
            j.Moves[idx] = j.Moves[idx] with { Undone = true };
            done++;
        }
        foreach (var d in j.CreatedDirs) { try { if (Directory.Exists(d) && !Directory.EnumerateFileSystemEntries(d).Any()) Directory.Delete(d); } catch { } }
        var final = j with { Undone = j.Moves.Where(x => x.Done).All(x => x.Undone) };
        try { SaveJournal(final); } catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Undo journal could not be updated."); }
        await AuditAsync("FileOrganizeUndone", request!, ctx, $"{done}/{back.Count} moved back{(stopped != null ? "; " + stopped : "")}");
        _logger?.LogInformation("[FileOrganize] files.undo_organize for task {TaskId}: {Done}/{Total} moved back, verified={Verified}.", ctx.TaskId, done, back.Count, stopped == null);
        return DesktopCallResult.Ok(new
        {
            decision = "approved", consumed = true, executed = done > 0, verified = stopped == null && done == back.Count,
            moved = done, total = back.Count, folder = j.Folder, journalId = j.Id, stopped,
            moves = back.Select(m => new { name = m.Name, from = m.Into, done = final.Moves.First(x => x.Name == m.Name).Undone }).ToArray(),
        });
    }

    // ── Approval, journal, audit ───────────────────────────────────────────────────────────────────────────────────

    private async Task<(bool ok, ActionApprovalRequest? request, DesktopCallResult? fail)> ApproveAsync(string type, Dictionary<string, string> parameters,
        string reason, string folder, DesktopActionContext ctx, CancellationToken ct)
    {
        var (_, risk, _) = _policy.EvaluatePolicy(type, new Dictionary<string, string>(), "D-ASK files");
        if (risk != ActionRiskLevel.Elevated) return (false, null, DesktopCallResult.Fail("approval_refused", "This file operation is not classified for approval. Nothing was done."));
        using var self = Process.GetCurrentProcess();
        var started = new DateTimeOffset(self.StartTime.ToUniversalTime(), TimeSpan.Zero);
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"), ActionId = Guid.NewGuid().ToString("N"), ActionType = type, ActionParameters = parameters,
            TargetProcessName = "D-ASK files", TargetWindowTitle = folder.Length > 500 ? folder[..500] : folder, TargetHwnd = 0,
            TargetProcessId = self.Id, TargetProcessCreationTime = started, SessionId = ctx.OwnerSessionId, StopGeneration = _generation(),
            RiskLevel = risk.ToString(), CreatedAtUtc = DateTimeOffset.UtcNow, ExpiresAtUtc = DateTimeOffset.UtcNow + _ttl, Reason = reason,
        };
        await AuditAsync(type == OrganizeType ? "FileOrganizeRequested" : "FileUndoRequested", request, ctx, $"agent call {ctx.CallId}");
        ActionApprovalResponse decision = await _policy.RequestApprovalAsync(request, ct);
        if (ct.IsCancellationRequested) return (false, request, DesktopCallResult.Cancelled());
        if (!decision.Approved)
        {
            var (code, message) = decision.DecisionSource switch
            {
                "UserExplicitConfirmation" => ("approval_denied", "You declined. Nothing was moved."),
                "TimeoutDenied" => ("approval_expired", "The approval expired before a decision. Nothing was moved."),
                "EmergencyStopDenied" or "StaleGenerationDenied" => ("emergency_stopped", "Emergency Stop cancelled the request. Nothing was moved."),
                "SessionDisconnectedDenied" => ("hud_unavailable", "The HUD is not connected, so the request could not be approved. Nothing was moved."),
                "IntegrityMismatch" => ("approval_refused", "The request could not be offered for approval exactly as it would be performed. Nothing was moved."),
                _ => ("approval_denied", "The request was not approved. Nothing was moved."),
            };
            await AuditAsync("FileOrganizeNotApproved", request, ctx, decision.DecisionSource ?? "denied");
            return (false, request, DesktopCallResult.Fail(code, message));
        }
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters,
            request.TargetProcessName, 0, self.Id, started, ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid || _evidence == null)
        {
            await AuditAsync("FileOrganizeApprovalInvalid", request, ctx, error ?? "invalid");
            return (false, request, DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was moved."));
        }
        // Required record: no audit, no action.
        await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
        {
            EventType = "FileOrganizeAdmitted", Source = "FileOrganizeRequestService", ActionId = request.ActionId, ApprovalId = request.ApprovalId,
            SessionId = request.SessionId, RiskLevel = request.RiskLevel, StopGeneration = request.StopGeneration, Decision = "Admitted",
            Reason = "approval consumed once", DetailsJson = AuditJson.Details(Details(request, ctx)),
        });
        return (true, request, null);
    }

    private void SaveJournal(Journal j)
    {
        Directory.CreateDirectory(_opts.JournalDir);
        string path = Path.Combine(_opts.JournalDir, j.Id + ".json");
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(j), new UTF8Encoding(false));
        File.Move(tmp, path, overwrite: true);
    }

    public Journal? LatestJournal()
    {
        if (!Directory.Exists(_opts.JournalDir)) return null;
        Journal? best = null;
        foreach (var f in Directory.EnumerateFiles(_opts.JournalDir, "*.json"))
        {
            try
            {
                var j = JsonSerializer.Deserialize<Journal>(File.ReadAllText(f));
                if (j == null || j.Undone || !j.Moves.Any(m => m.Done && !m.Undone)) continue;
                if (best == null || j.CreatedUtc > best.CreatedUtc) best = j;
            }
            catch { /* an unreadable journal is ignored, never acted on */ }
        }
        return best;
    }

    private DesktopCallResult Refuse(DesktopActionContext ctx, string code, string message)
    {
        _logger?.LogInformation("[FileOrganize] Refused for task {TaskId}: {Code}.", ctx.TaskId, code);
        return DesktopCallResult.Fail(code, message + " Nothing was moved.");
    }

    private static object Details(ActionApprovalRequest q, DesktopActionContext ctx) => new
    {
        actionType = q.ActionType, taskId = ctx.TaskId, callId = ctx.CallId, folder = q.ActionParameters.GetValueOrDefault("folder"),
        moveCount = q.ActionParameters.GetValueOrDefault("moveCount"),
    };

    private async Task AuditAsync(string evt, ActionApprovalRequest q, DesktopActionContext ctx, string reason)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt, Source = "FileOrganizeRequestService", ActionId = q.ActionId, ApprovalId = q.ApprovalId, SessionId = q.SessionId,
                RiskLevel = q.RiskLevel, StopGeneration = q.StopGeneration, Decision = evt, Reason = AuditJson.Bound(reason),
                DetailsJson = AuditJson.Details(Details(q, ctx)),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Audit record {Event} failed.", evt); }
    }
}
