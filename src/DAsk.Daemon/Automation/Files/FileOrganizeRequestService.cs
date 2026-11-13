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
    public const string Copy = "files.copy";
    public const string Rename = "files.rename";
    public const string UndoCopyRename = "files.undo_copy_rename";
    public const string CopyType = "Files.Copy";
    public const string RenameType = "Files.Rename";
    public const string UndoCopyRenameType = "Files.UndoCopyRename";
    /// <summary>Moving ONE file or ONE folder to another allowed folder (never overwriting; undoable).</summary>
    public const string MoveTool = "files.move";
    public const string MoveType = DesktopActionTypes.FilesMove;
    /// <summary>Largest folder moved in one request (files counted; every file's hash is checked after the move).</summary>
    public const int MaxFolderFiles = 5000;
    /// <summary>Largest file copied in one request (a copy is verified by SHA-256 afterwards).</summary>
    public const long MaxCopyBytes = 512L * 1024 * 1024;
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

    public IReadOnlyList<string> Tools => _opts.Enabled && _evidence != null && _roots.Length > 0 ? new[] { Organize, Undo, Copy, Rename, UndoCopyRename, MoveTool } : Array.Empty<string>();
    public int MaxCallMs => (int)Math.Min(_ttl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + 30_000;

    public sealed record Move(string Name, string Into);
    /// <summary>For a copy: Name = source path, Into = the copy's path, Sha256 = the copy's hash. For a rename: Name = old name, Into = new name.</summary>
    public sealed record JournalMove(string Name, string Into, long Size, DateTime MtimeUtc, bool Done, bool Undone, string? Sha256 = null);
    /// <summary>Kind: "organize" (default; also every journal written before copy/rename existed), "copy" or "rename".</summary>
    public sealed record Journal(string Id, string Folder, DateTime CreatedUtc, List<JournalMove> Moves, List<string> CreatedDirs, bool Undone, string Kind = "organize");

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
        return tool switch
        {
            Organize => await OrganizeAsync(args, ctx, ct),
            Undo => await UndoAsync(args, ctx, ct),
            Copy => await CopyAsync(args, ctx, ct),
            Rename => await RenameAsync(args, ctx, ct),
            MoveTool => await MoveAsync(args, ctx, ct),
            _ => await UndoCopyRenameAsync(args, ctx, ct),
        };
    }

    // ── Copy and rename (one file per request) ─────────────────────────────────────────────────────────────────────

    /// <summary>Strict: an object with exactly the listed string properties (optional ones may be absent), each at most 400 characters.</summary>
    private static string? ParseStrings(JsonElement args, string[] required, string[] optional, out Dictionary<string, string> values)
    {
        values = new(StringComparer.Ordinal);
        if (args.ValueKind != JsonValueKind.Object) return "arguments must be an object";
        foreach (var p in args.EnumerateObject())
        {
            if (!required.Contains(p.Name) && !optional.Contains(p.Name)) return "unknown argument";
            if (p.Value.ValueKind != JsonValueKind.String || p.Value.GetString() is not { Length: > 0 and <= 400 } v) return $"{p.Name} must be text";
            values[p.Name] = v;
        }
        foreach (var r in required) if (!values.ContainsKey(r)) return $"{r} is required";
        return null;
    }

    /// <summary>An existing regular file inside an allowed folder: canonical folder + plain name; not hidden, system or a link.</summary>
    public string? CheckFile(string path, out string folder, out string name)
    {
        folder = ""; name = "";
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) || path.IndexOf(':', 2) >= 0) return "the file must be a plain absolute path";
        string? dir = Path.GetDirectoryName(path);
        name = Path.GetFileName(path);
        if (dir == null || !IsSafeName(name)) return "that file name is not one D-ASK works with (plain names only)";
        if (CheckFolder(dir, out folder) is { } bad) return bad;
        var fi = new FileInfo(Path.Combine(folder, name));
        if (!fi.Exists) return $"{name} is not a file in {folder}";
        if (IsLinkOrHidden(fi)) return $"{name} is a link, hidden or system file";
        return null;
    }

    /// <summary>The first free name for a copy: "name.ext", then "name (copy).ext", "name (copy 2).ext", … (at most 50 tries).</summary>
    public static string? FreeCopyName(string folder, string wanted)
    {
        string stem = Path.GetFileNameWithoutExtension(wanted), ext = Path.GetExtension(wanted);
        for (int i = 0; i <= 50; i++)
        {
            string n = i == 0 ? wanted : i == 1 ? $"{stem} (copy){ext}" : $"{stem} (copy {i}){ext}";
            if (!IsSafeName(n)) return null;
            string p = Path.Combine(folder, n);
            if (!File.Exists(p) && !Directory.Exists(p)) return n;
        }
        return null;
    }

    private static string Sha256Of(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(fs)).ToLowerInvariant();
    }

    private async Task<DesktopCallResult> CopyAsync(JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (ParseStrings(args, new[] { "path" }, new[] { "toFolder", "newName" }, out var a) is { } bad) return Refuse(ctx, "invalid_args", bad);
        if (CheckFile(a["path"], out var srcFolder, out var srcName) is { } badSrc) return Refuse(ctx, "file_refused", badSrc);
        string destFolder = srcFolder;
        if (a.TryGetValue("toFolder", out var tf) && CheckFolder(tf, out destFolder) is { } badDest) return Refuse(ctx, "folder_refused", badDest);
        string wanted = a.TryGetValue("newName", out var nn) ? nn : srcName;
        if (!IsSafeName(wanted)) return Refuse(ctx, "invalid_args", "the new name is not allowed (a plain file name only)");
        var src = new FileInfo(Path.Combine(srcFolder, srcName));
        if (src.Length > MaxCopyBytes) return Refuse(ctx, "too_large", $"{srcName} is larger than {MaxCopyBytes / 1048576} MB");
        string? finalName = FreeCopyName(destFolder, wanted);
        if (finalName == null) return Refuse(ctx, "name_taken", $"no free name for the copy of {wanted} in {destFolder}");
        string dst = Path.Combine(destFolder, finalName);
        var parameters = new Dictionary<string, string>
        {
            ["source"] = src.FullName,
            ["destination"] = dst,
            ["size"] = $"{src.Length} bytes",
            ["nameTaken"] = finalName == wanted ? "No" : $"Yes: {wanted} already exists, so the copy is named {finalName}",
            ["overwrite"] = "Never: an existing file is never replaced.",
            ["reversible"] = "Yes: say \"undo the last copy\" to remove this copy again (asked for approval again; only if it is unchanged).",
            ["execution"] = "Performed once, right after your approval, by the D-ASK daemon; the copy is verified byte for byte (SHA-256). Emergency Stop stops it.",
        };
        var (approved, request, fail) = await ApproveAsync(CopyType, parameters, $"D-ASK asks to copy {srcName} to {destFolder}.", destFolder, ctx, ct);
        if (!approved) return fail!;
        if (CheckFile(src.FullName, out _, out _) is not null || CheckFolder(destFolder, out _) is not null || File.Exists(dst) || Directory.Exists(dst))
            return DesktopCallResult.Fail("changed", "The file or folder changed after your approval; nothing was copied.");
        if (ct.IsCancellationRequested || _isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Stopped before copying; nothing was copied.");
        string srcHash = Sha256Of(src.FullName);
        var journal = new Journal(request!.ApprovalId, destFolder, DateTime.UtcNow, new List<JournalMove> { new(src.FullName, dst, src.Length, default, false, false, srcHash) }, new List<string>(), false, "copy");
        try { SaveJournal(journal); } catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Undo journal could not be written."); return DesktopCallResult.Fail("journal_failed", "The undo record could not be written, so nothing was copied."); }
        string? problem = null;
        try { File.Copy(src.FullName, dst, overwrite: false); } catch (Exception ex) { problem = ex.GetType().Name; }
        bool verified = problem == null && File.Exists(dst) && new FileInfo(dst).Length == src.Length && Sha256Of(dst) == srcHash;
        if (problem == null && File.Exists(dst)) journal = journal with { Moves = new List<JournalMove> { journal.Moves[0] with { Done = verified, MtimeUtc = new FileInfo(dst).LastWriteTimeUtc } } };
        try { SaveJournal(journal); } catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Undo journal could not be updated."); }
        await AuditAsync("FileCopyPerformed", request, ctx, verified ? "copied and verified (SHA-256)" : $"not verified{(problem != null ? ": " + problem : "")}");
        _logger?.LogInformation("[FileOrganize] files.copy for task {TaskId}: verified={Verified}.", ctx.TaskId, verified);
        return DesktopCallResult.Ok(new { decision = "approved", consumed = true, executed = problem == null, verified, source = src.FullName, destination = dst, renamedBecauseTaken = finalName != wanted, sha256 = srcHash, journalId = journal.Id, stopped = problem });
    }

    private async Task<DesktopCallResult> RenameAsync(JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (ParseStrings(args, new[] { "path", "newName" }, Array.Empty<string>(), out var a) is { } bad) return Refuse(ctx, "invalid_args", bad);
        if (CheckFile(a["path"], out var folder, out var oldName) is { } badSrc) return Refuse(ctx, "file_refused", badSrc);
        string newName = a["newName"];
        if (!IsSafeName(newName)) return Refuse(ctx, "invalid_args", "the new name is not allowed (a plain file name only, no folders)");
        if (string.Equals(newName, oldName, StringComparison.Ordinal)) return Refuse(ctx, "invalid_args", "the new name is the same as the old one");
        string to = Path.Combine(folder, newName);
        bool caseOnly = string.Equals(newName, oldName, StringComparison.OrdinalIgnoreCase);
        if (!caseOnly && (File.Exists(to) || Directory.Exists(to))) return Refuse(ctx, "name_taken", $"{newName} already exists in {folder}; nothing is overwritten");
        var fi = new FileInfo(Path.Combine(folder, oldName));
        string oldExt = Path.GetExtension(oldName), newExt = Path.GetExtension(newName);
        var parameters = new Dictionary<string, string>
        {
            ["folder"] = folder,
            ["from"] = oldName,
            ["to"] = newName,
            ["extensionChange"] = string.Equals(oldExt, newExt, StringComparison.OrdinalIgnoreCase) ? "No" : $"Yes: {(oldExt == "" ? "(none)" : oldExt)} becomes {(newExt == "" ? "(none)" : newExt)}; the file may open with a different program",
            ["overwrite"] = "Never: if a file of the new name exists, nothing is renamed.",
            ["reversible"] = "Yes: say \"undo the last rename\" to rename it back (asked for approval again).",
            ["execution"] = "Performed once, right after your approval, by the D-ASK daemon, and verified. Emergency Stop stops it.",
        };
        var (approved, request, fail) = await ApproveAsync(RenameType, parameters, $"D-ASK asks to rename {oldName} to {newName}.", folder, ctx, ct);
        if (!approved) return fail!;
        if (CheckFile(fi.FullName, out _, out _) is not null || (!caseOnly && (File.Exists(to) || Directory.Exists(to))))
            return DesktopCallResult.Fail("changed", "The file changed after your approval; nothing was renamed.");
        if (ct.IsCancellationRequested || _isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Stopped before renaming; nothing was renamed.");
        long size = fi.Length; DateTime mtime = fi.LastWriteTimeUtc;
        var journal = new Journal(request!.ApprovalId, folder, DateTime.UtcNow, new List<JournalMove> { new(oldName, newName, size, mtime, false, false) }, new List<string>(), false, "rename");
        try { SaveJournal(journal); } catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Undo journal could not be written."); return DesktopCallResult.Fail("journal_failed", "The undo record could not be written, so nothing was renamed."); }
        string? problem = null;
        try { File.Move(fi.FullName, to, overwrite: false); } catch (Exception ex) { problem = ex.GetType().Name; }
        bool verified = problem == null && File.Exists(to) && new FileInfo(to).Length == size
            && Directory.EnumerateFiles(folder).Select(Path.GetFileName).Contains(newName, StringComparer.Ordinal)
            && (caseOnly || !File.Exists(fi.FullName));
        journal = journal with { Moves = new List<JournalMove> { journal.Moves[0] with { Done = verified } } };
        try { SaveJournal(journal); } catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Undo journal could not be updated."); }
        await AuditAsync("FileRenamePerformed", request, ctx, verified ? "renamed and verified" : $"not verified{(problem != null ? ": " + problem : "")}");
        _logger?.LogInformation("[FileOrganize] files.rename for task {TaskId}: verified={Verified}.", ctx.TaskId, verified);
        return DesktopCallResult.Ok(new { decision = "approved", consumed = true, executed = problem == null, verified, folder, from = oldName, to = newName, journalId = journal.Id, stopped = problem });
    }

    // ── Move (one file, or one folder, to another allowed folder) ──────────────────────────────────────────────────

    /// <summary>
    /// A folder's content, for verifying a folder move: every file's path relative to the folder, its size and SHA-256, in order.
    /// Null with a reason when the folder is too large, holds links, hidden or system entries, or cannot be read.
    /// </summary>
    public static (string? Digest, int Files, long Bytes, string? Problem) FolderManifest(string folder)
    {
        var lines = new List<string>(); long bytes = 0;
        try
        {
            foreach (var e in new DirectoryInfo(folder).EnumerateFileSystemInfos("*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0, IgnoreInaccessible = false }))
            {
                if ((e.Attributes & FileAttributes.ReparsePoint) != 0) return (null, 0, 0, $"{e.Name} inside it is a link or junction; folders with links are not moved");
                if ((e.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0) return (null, 0, 0, $"{e.Name} inside it is hidden or a system file; such folders are not moved");
                if (e is not FileInfo f) continue;
                if (lines.Count >= MaxFolderFiles) return (null, 0, 0, $"it holds more than {MaxFolderFiles} files");
                bytes += f.Length;
                lines.Add($"{Path.GetRelativePath(folder, f.FullName)}|{f.Length}|{Sha256Of(f.FullName)}");
            }
        }
        catch (Exception ex) { return (null, 0, 0, $"it cannot be read completely ({ex.GetType().Name})"); }
        lines.Sort(StringComparer.Ordinal);
        string digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", lines)))).ToLowerInvariant();
        return (digest, lines.Count, bytes, null);
    }

    private async Task<DesktopCallResult> MoveAsync(JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (ParseStrings(args, new[] { "path", "toFolder" }, new[] { "newName" }, out var a) is { } bad) return Refuse(ctx, "invalid_args", bad);
        string path = a["path"];
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) || path.IndexOf(':', 2) >= 0) return Refuse(ctx, "invalid_args", "the path must be a plain absolute path");
        if (CheckFolder(a["toFolder"], out var destFolder) is { } badDest) return Refuse(ctx, "folder_refused", badDest);
        bool isFolder = Directory.Exists(Path.TrimEndingDirectorySeparator(path));
        string srcFull, srcName, srcParent;
        string? digest = null; int files = 0; long bytes; string? sha = null; DateTime mtime = default;
        if (isFolder)
        {
            if (CheckFolder(Path.TrimEndingDirectorySeparator(path), out srcFull) is { } badSrc) return Refuse(ctx, "folder_refused", badSrc);
            if (_roots.Any(r => r.Equals(srcFull, StringComparison.OrdinalIgnoreCase))) return Refuse(ctx, "folder_refused", "an allowed folder itself is never moved");
            srcName = Path.GetFileName(srcFull); srcParent = Path.GetDirectoryName(srcFull)!;
            if (!SafeFolderName.IsMatch(srcName) && !IsSafeName(srcName)) return Refuse(ctx, "folder_refused", "that folder name is not one D-ASK works with");
            if (destFolder.Equals(srcFull, StringComparison.OrdinalIgnoreCase) || destFolder.StartsWith(srcFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                return Refuse(ctx, "invalid_args", "a folder cannot be moved into itself");
            if (!string.Equals(Path.GetPathRoot(srcFull), Path.GetPathRoot(destFolder), StringComparison.OrdinalIgnoreCase))
                return Refuse(ctx, "invalid_args", "moving a folder to another drive is not supported (it would be a copy and a delete); copy it instead");
            (digest, files, bytes, var why) = FolderManifest(srcFull);
            if (why != null) return Refuse(ctx, "folder_refused", $"{srcName} is not moved: {why}");
        }
        else
        {
            if (CheckFile(path, out srcParent, out srcName) is { } badSrc) return Refuse(ctx, "file_refused", badSrc);
            srcFull = Path.Combine(srcParent, srcName);
            var fi = new FileInfo(srcFull);
            if (fi.Length > MaxCopyBytes) return Refuse(ctx, "too_large", $"{srcName} is larger than {MaxCopyBytes / 1048576} MB");
            bytes = fi.Length; mtime = fi.LastWriteTimeUtc; sha = Sha256Of(srcFull);
        }
        string name = a.TryGetValue("newName", out var nn) ? nn : srcName;
        if (!IsSafeName(name) && !(isFolder && SafeFolderName.IsMatch(name))) return Refuse(ctx, "invalid_args", "the new name is not allowed (a plain name only)");
        if (destFolder.Equals(srcParent, StringComparison.OrdinalIgnoreCase)) return Refuse(ctx, "invalid_args", $"{srcName} is already in {destFolder} (use rename to change only its name)");
        string dst = Path.Combine(destFolder, name);
        // Collision: never overwritten, never silently renamed — the user decides (another name, or nothing).
        if (File.Exists(dst) || Directory.Exists(dst))
            return Refuse(ctx, "name_taken", $"{destFolder} already has {(Directory.Exists(dst) ? "a folder" : "a file")} named {name}; nothing is overwritten. Say a new name for it (\"… and call it …\") or choose another folder.");

        var parameters = new Dictionary<string, string>
        {
            ["operation"] = isFolder ? "Move a folder" : "Move a file",
            ["source"] = srcFull,
            ["destination"] = dst,
            ["content"] = isFolder ? $"{files} file(s), {bytes} bytes (every file is checked after the move)" : $"{bytes} bytes",
            ["overwrite"] = "Never: if the destination exists, nothing is moved.",
            ["reversible"] = "Yes: say \"undo the last move\" to move it back (asked for approval again; only if it is unchanged and its old place is free).",
            ["execution"] = isFolder
                ? "Performed once, right after your approval, by the D-ASK daemon as one move on the same drive; then the destination must hold exactly the same files (paths, sizes, SHA-256) and the source must be gone."
                : "Performed once, right after your approval, by the D-ASK daemon; then the destination must have the same SHA-256 and the source must be gone. Emergency Stop stops it.",
        };
        var (approved, request, fail) = await ApproveAsync(MoveType, parameters, $"D-ASK asks to move {srcName} to {destFolder}.", destFolder, ctx, ct);
        if (!approved) return fail!;
        // Re-validated after the approval: the same item, unchanged, and the destination still free.
        bool unchanged = isFolder ? Directory.Exists(srcFull) && FolderManifest(srcFull).Digest == digest
                                  : File.Exists(srcFull) && new FileInfo(srcFull).Length == bytes && Sha256Of(srcFull) == sha;
        if (!unchanged || File.Exists(dst) || Directory.Exists(dst) || CheckFolder(destFolder, out _) is not null)
            return DesktopCallResult.Fail("changed", "The item or the destination changed after your approval; nothing was moved.");
        if (ct.IsCancellationRequested || _isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Stopped before moving; nothing was moved.");
        var journal = new Journal(request!.ApprovalId, destFolder, DateTime.UtcNow,
            new List<JournalMove> { new(srcFull, dst, bytes, mtime, false, false, isFolder ? digest : sha) }, new List<string>(), false, isFolder ? "move-folder" : "move");
        try { SaveJournal(journal); } catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Undo journal could not be written."); return DesktopCallResult.Fail("journal_failed", "The undo record could not be written, so nothing was moved."); }
        string? problem = null;
        try { if (isFolder) Directory.Move(srcFull, dst); else File.Move(srcFull, dst, overwrite: false); }
        catch (Exception ex) { problem = ex.GetType().Name; }
        bool verified = problem == null && (isFolder
            ? !Directory.Exists(srcFull) && Directory.Exists(dst) && FolderManifest(dst).Digest == digest
            : !File.Exists(srcFull) && File.Exists(dst) && Sha256Of(dst) == sha);
        journal = journal with { Moves = new List<JournalMove> { journal.Moves[0] with { Done = verified, MtimeUtc = !isFolder && File.Exists(dst) ? new FileInfo(dst).LastWriteTimeUtc : mtime } } };
        try { SaveJournal(journal); } catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Undo journal could not be updated."); }
        await AuditAsync("FileMovePerformed", request, ctx, verified ? "moved and verified" : $"not verified{(problem != null ? ": " + problem : "")}");
        return DesktopCallResult.Ok(new
        {
            decision = "approved", consumed = true, executed = problem == null, verified, kind = isFolder ? "folder" : "file", source = srcFull, destination = dst,
            files = isFolder ? files : 1, bytes, journalId = journal.Id, stopped = problem,
        });
    }

    /// <summary>Moves back what D-ASK moved: only if it is unchanged (same SHA-256 / same folder manifest) and its old place is free.</summary>
    private async Task<DesktopCallResult> UndoMoveAsync(Journal j, JournalMove m, DesktopActionContext ctx, CancellationToken ct)
    {
        bool folder = j.Kind == "move-folder";
        bool Unchanged() => folder ? Directory.Exists(m.Into) && FolderManifest(m.Into).Digest == m.Sha256 : File.Exists(m.Into) && Sha256Of(m.Into) == m.Sha256;
        string? parent = Path.GetDirectoryName(m.Name);
        if (parent == null || CheckFolder(parent, out _) is not null || !Unchanged() || File.Exists(m.Name) || Directory.Exists(m.Name))
            return DesktopCallResult.Fail("nothing_to_undo", "What D-ASK moved has changed or is gone, or its old place is taken, so it is not moved back.");
        var parameters = new Dictionary<string, string>
        {
            ["operation"] = folder ? "Move a folder back" : "Move a file back",
            ["path"] = m.Into,
            ["detail"] = $"moved by D-ASK {j.CreatedUtc:u} from {m.Name}; unchanged since. It goes back to {m.Name}. Nothing is overwritten.",
            ["execution"] = "Performed once, right after your approval, by the D-ASK daemon, and verified.",
        };
        var (approved, request, fail) = await ApproveAsync(UndoCopyRenameType, parameters, $"D-ASK asks to undo its last move.", parent, ctx, ct);
        if (!approved) return fail!;
        if (ct.IsCancellationRequested || _isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Stopped before undoing; nothing was changed.");
        if (!Unchanged() || File.Exists(m.Name) || Directory.Exists(m.Name)) return DesktopCallResult.Fail("changed", "It changed after your approval; nothing was moved back.");
        string? problem = null;
        try { if (folder) Directory.Move(m.Into, m.Name); else File.Move(m.Into, m.Name, overwrite: false); } catch (Exception ex) { problem = ex.GetType().Name; }
        bool verified = problem == null && (folder ? Directory.Exists(m.Name) && !Directory.Exists(m.Into) && FolderManifest(m.Name).Digest == m.Sha256
                                                   : File.Exists(m.Name) && !File.Exists(m.Into) && Sha256Of(m.Name) == m.Sha256);
        try { SaveJournal(j with { Moves = new List<JournalMove> { m with { Undone = verified } }, Undone = verified }); } catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Undo journal could not be updated."); }
        await AuditAsync("FileMoveUndone", request!, ctx, verified ? "moved back and verified" : $"not verified{(problem != null ? ": " + problem : "")}");
        return DesktopCallResult.Ok(new { decision = "approved", consumed = true, executed = problem == null, verified, kind = j.Kind, path = m.Name, journalId = j.Id, stopped = problem });
    }

    private async Task<DesktopCallResult> UndoCopyRenameAsync(JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (args.ValueKind != JsonValueKind.Object || args.EnumerateObject().Any()) return Refuse(ctx, "invalid_args", "undo takes no arguments (it undoes the most recent copy or rename)");
        Journal? j = LatestJournal("copy", "rename", "move", "move-folder");
        if (j == null) return DesktopCallResult.Fail("nothing_to_undo", "There is no copy, rename or move to undo.");
        var m = j.Moves[0];
        if (j.Kind is "move" or "move-folder") return await UndoMoveAsync(j, m, ctx, ct);
        Dictionary<string, string> parameters;
        if (j.Kind == "copy")
        {
            var at = new FileInfo(m.Into);
            if (CheckFile(m.Into, out _, out _) is not null || at.Length != m.Size || at.LastWriteTimeUtc != m.MtimeUtc || Sha256Of(m.Into) != m.Sha256)
                return DesktopCallResult.Fail("nothing_to_undo", "The copy D-ASK made has changed or is gone, so it is not removed.");
            parameters = new()
            {
                ["operation"] = "Remove the copy D-ASK made",
                ["path"] = m.Into,
                ["detail"] = $"a copy of {m.Name} made {j.CreatedUtc:u}; unchanged since (same size and SHA-256). The original is not touched.",
                ["execution"] = "Performed once, right after your approval, by the D-ASK daemon, and verified.",
            };
        }
        else
        {
            var at = new FileInfo(Path.Combine(j.Folder, m.Into));
            string back = Path.Combine(j.Folder, m.Name);
            bool caseOnly = string.Equals(m.Name, m.Into, StringComparison.OrdinalIgnoreCase);
            if (CheckFile(at.FullName, out _, out _) is not null || at.Length != m.Size || at.LastWriteTimeUtc != m.MtimeUtc || (!caseOnly && (File.Exists(back) || Directory.Exists(back))))
                return DesktopCallResult.Fail("nothing_to_undo", "The renamed file has changed, is gone, or its old name is taken, so it is not renamed back.");
            parameters = new()
            {
                ["operation"] = "Rename back",
                ["path"] = at.FullName,
                ["detail"] = $"{m.Into} is renamed back to {m.Name} (renamed by D-ASK {j.CreatedUtc:u}). Nothing is overwritten.",
                ["execution"] = "Performed once, right after your approval, by the D-ASK daemon, and verified.",
            };
        }
        var (approved, request, fail) = await ApproveAsync(UndoCopyRenameType, parameters, $"D-ASK asks to undo its last {(j.Kind == "copy" ? "copy" : "rename")}.", j.Folder, ctx, ct);
        if (!approved) return fail!;
        if (ct.IsCancellationRequested || _isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Stopped before undoing; nothing was changed.");
        bool verified; string? problem = null;
        if (j.Kind == "copy")
        {
            var at = new FileInfo(m.Into);
            if (!at.Exists || at.Length != m.Size || at.LastWriteTimeUtc != m.MtimeUtc || Sha256Of(m.Into) != m.Sha256) return DesktopCallResult.Fail("changed", "The copy changed after your approval; it was not removed.");
            try { File.Delete(m.Into); } catch (Exception ex) { problem = ex.GetType().Name; }
            verified = problem == null && !File.Exists(m.Into) && File.Exists(m.Name);
        }
        else
        {
            string from = Path.Combine(j.Folder, m.Into), back = Path.Combine(j.Folder, m.Name);
            try { File.Move(from, back, overwrite: false); } catch (Exception ex) { problem = ex.GetType().Name; }
            verified = problem == null && File.Exists(back) && Directory.EnumerateFiles(j.Folder).Select(Path.GetFileName).Contains(m.Name, StringComparer.Ordinal);
        }
        var final = j with { Moves = new List<JournalMove> { m with { Undone = verified } }, Undone = verified };
        try { SaveJournal(final); } catch (Exception ex) { _logger?.LogWarning(ex, "[FileOrganize] Undo journal could not be updated."); }
        await AuditAsync("FileCopyRenameUndone", request!, ctx, verified ? $"{j.Kind} undone and verified" : $"not verified{(problem != null ? ": " + problem : "")}");
        return DesktopCallResult.Ok(new { decision = "approved", consumed = true, executed = problem == null, verified, kind = j.Kind, path = parameters["path"], journalId = j.Id, stopped = problem });
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
        await AuditAsync(type switch { OrganizeType => "FileOrganizeRequested", CopyType => "FileCopyRequested", RenameType => "FileRenameRequested", UndoCopyRenameType => "FileCopyRenameUndoRequested", _ => "FileUndoRequested" }, request, ctx, $"agent call {ctx.CallId}");
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

    /// <summary>The most recent journal of the given kinds (default: organisations) with something still undoable.</summary>
    public Journal? LatestJournal(params string[] kinds)
    {
        if (kinds.Length == 0) kinds = new[] { "organize" };
        if (!Directory.Exists(_opts.JournalDir)) return null;
        Journal? best = null;
        foreach (var f in Directory.EnumerateFiles(_opts.JournalDir, "*.json"))
        {
            try
            {
                var j = JsonSerializer.Deserialize<Journal>(File.ReadAllText(f));
                if (j == null || !kinds.Contains(j.Kind ?? "organize") || j.Undone || !j.Moves.Any(m => m.Done && !m.Undone)) continue;
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
