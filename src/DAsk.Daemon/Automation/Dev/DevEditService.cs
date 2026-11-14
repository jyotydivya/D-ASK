using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Dev;

public sealed class DevEditOptions
{
    /// <summary>Folders inside which files may be edited (AgentHost:DevEditRoots). Empty: off.</summary>
    public IReadOnlyList<string> Roots { get; init; } = Array.Empty<string>();
    public long MaxFileBytes { get; init; } = 1024 * 1024;
    /// <summary>Backups of every edited file (written BEFORE the edit); default %LOCALAPPDATA%\D-ASK\dev-edit-backups.</summary>
    public string BackupDir { get; init; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D-ASK", "dev-edit-backups");
}

/// <summary>
/// dev.edit_file (2026-11-14): ONE exact, approved text replacement in ONE source file inside an allowed folder. The model never writes a file
/// freely: the request names the file, the exact text to find (it must occur exactly once) and the exact replacement. The HUD card shows the
/// resulting diff; after approval the file must still have the SHA-256 it had when the diff was made; a backup is written first; the file is
/// replaced atomically and read back: the new content must equal the old content with exactly that one replacement (any other difference is
/// reported as an unintended modification). Line endings and encoding (incl. a UTF-8 BOM) are preserved. Running tests afterwards is the
/// existing dev.run_task (its own approval, same process containment).
/// </summary>
public sealed class DevEditService : IDesktopActionRequestService
{
    public const string EditFile = "dev.edit_file";
    private static readonly HashSet<string> TextExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".cs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".rs", ".py", ".md", ".txt", ".html", ".css", ".scss", ".xml", ".yml", ".yaml", ".toml",
        ".csproj", ".props", ".targets", ".sql", ".sh", ".ps1", ".go", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".ini", ".cfg",
    };

    private readonly ApprovalGate _gate;
    private readonly DevEditOptions _o;
    private readonly ILogger? _log;
    private readonly string[] _roots;

    public DevEditService(ApprovalGate gate, DevEditOptions options, ILogger? logger = null)
    {
        _gate = gate; _o = options; _log = logger;
        _roots = options.Roots.Where(r => !string.IsNullOrWhiteSpace(r) && Path.IsPathFullyQualified(r) && !r.StartsWith(@"\\", StringComparison.Ordinal))
            .Select(r => Path.TrimEndingDirectorySeparator(Path.GetFullPath(r))).Where(Directory.Exists).ToArray();
    }

    public IReadOnlyList<string> Tools => _roots.Length > 0 && _gate.Available ? new[] { EditFile } : Array.Empty<string>();
    public int MaxCallMs => (int)ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds + 20_000;

    public static string Sha(byte[] b) => Convert.ToHexString(SHA256.HashData(b));

    /// <summary>A unified-style diff of the changed lines with 2 lines of context (for the approval card and the result).</summary>
    public static string Diff(string before, string after, string name)
    {
        var a = before.Split('\n'); var b = after.Split('\n');
        int start = 0; while (start < a.Length && start < b.Length && a[start] == b[start]) start++;
        int ea = a.Length - 1, eb = b.Length - 1; while (ea >= start && eb >= start && a[ea] == b[eb]) { ea--; eb--; }
        var sb = new StringBuilder($"--- {name}\n+++ {name}\n@@ line {start + 1} @@\n");
        for (int i = Math.Max(0, start - 2); i < start; i++) sb.Append("  ").Append(a[i].TrimEnd('\r')).Append('\n');
        for (int i = start; i <= ea; i++) sb.Append("- ").Append(a[i].TrimEnd('\r')).Append('\n');
        for (int i = start; i <= eb; i++) sb.Append("+ ").Append(b[i].TrimEnd('\r')).Append('\n');
        for (int i = ea + 1; i < Math.Min(a.Length, ea + 3); i++) sb.Append("  ").Append(a[i].TrimEnd('\r')).Append('\n');
        return sb.ToString().TrimEnd('\n');
    }

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        try { return await RunAsync(tool, a, ctx, ct); }
        catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
    }

    private async Task<DesktopCallResult> RunAsync(string tool, JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        if (tool != EditFile) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (_roots.Length == 0) return DesktopCallResult.Fail("dev_edit_disabled", "Code edits are switched off in this installation (AgentHost:DevEditRoots). Nothing was changed.");
        if (a.ValueKind != JsonValueKind.Object) return DesktopCallResult.Fail("invalid_args", "arguments must be an object");
        string? file = null, find = null, replace = null;
        foreach (var p in a.EnumerateObject())
        {
            if (p.Value.ValueKind != JsonValueKind.String) return DesktopCallResult.Fail("invalid_args", $"{p.Name} must be text");
            switch (p.Name) { case "file": file = p.Value.GetString(); break; case "find": find = p.Value.GetString(); break; case "replace": replace = p.Value.GetString(); break;
                default: return DesktopCallResult.Fail("invalid_args", "only { file, find, replace } are accepted"); }
        }
        if (string.IsNullOrEmpty(file) || string.IsNullOrEmpty(find) || replace == null) return DesktopCallResult.Fail("invalid_args", "file, find and replace are required");
        if (find.Length > 4000 || replace.Length > 4000) return DesktopCallResult.Fail("invalid_args", "find and replace are limited to 4000 characters each");
        if (find == replace) return DesktopCallResult.Fail("invalid_args", "the replacement is identical to the text found; nothing to change");
        if (!Path.IsPathFullyQualified(file) || file.StartsWith(@"\\", StringComparison.Ordinal) || file.IndexOf(':', 2) >= 0) return DesktopCallResult.Fail("invalid_args", "file must be a plain absolute path");
        string full = Path.GetFullPath(file);
        if (!_roots.Any(r => full.StartsWith(r + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)))
            return DesktopCallResult.Fail("folder_refused", "That file is not inside a folder D-ASK may edit (AgentHost:DevEditRoots). Nothing was changed.");
        if (!TextExtensions.Contains(Path.GetExtension(full))) return DesktopCallResult.Fail("file_refused", "Only source and text files can be edited.");
        var info = new FileInfo(full);
        if (!info.Exists) return DesktopCallResult.Fail("not_found", "The file does not exist. Nothing was changed.");
        if ((info.Attributes & (FileAttributes.ReparsePoint | FileAttributes.System | FileAttributes.Hidden | FileAttributes.ReadOnly)) != 0)
            return DesktopCallResult.Fail("file_refused", "Links, hidden, system and read-only files are not edited.");
        if (info.Length > _o.MaxFileBytes) return DesktopCallResult.Fail("file_refused", "The file is too large to edit safely.");

        byte[] raw = await File.ReadAllBytesAsync(full, ct);
        if (raw.Contains((byte)0)) return DesktopCallResult.Fail("file_refused", "The file looks binary; nothing was changed.");
        bool bom = raw.Length >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF;
        string before;
        try { before = new UTF8Encoding(false, true).GetString(raw, bom ? 3 : 0, raw.Length - (bom ? 3 : 0)); }
        catch (DecoderFallbackException) { return DesktopCallResult.Fail("file_refused", "The file is not valid UTF-8 text; nothing was changed."); }
        // Line endings: the request's text uses \n; a CRLF file is matched and edited in CRLF.
        bool crlf = before.Contains("\r\n");
        string f = crlf ? find.Replace("\r\n", "\n").Replace("\n", "\r\n") : find;
        string r = crlf ? replace.Replace("\r\n", "\n").Replace("\n", "\r\n") : replace;
        int first = before.IndexOf(f, StringComparison.Ordinal);
        if (first < 0) return DesktopCallResult.Fail("text_not_found", "The text to replace was not found in the file. Nothing was changed.");
        if (before.IndexOf(f, first + 1, StringComparison.Ordinal) >= 0) return DesktopCallResult.Fail("ambiguous_target", "The text to replace occurs more than once; quote more of it so it is unique. Nothing was changed.");
        string after = before[..first] + r + before[(first + f.Length)..];
        string shaBefore = Sha(raw);
        string diff = Diff(before, after, Path.GetFileName(full));
        if (diff.Length > 3500) diff = diff[..3500] + "\n… (diff truncated on the card)";

        var parameters = new Dictionary<string, string>
        {
            ["operation"] = $"Change {Path.GetFileName(full)}: replace exactly one passage (shown as a diff below)",
            ["file"] = full, ["sha256Before"] = shaBefore[..16], ["diff"] = diff,
            ["guarantees"] = "Nothing else in the file changes; line endings and encoding are kept; a backup is written first; if the file changes before you approve, nothing is done.",
            ["execution"] = "Written once, right after your approval, then read back and compared with exactly this change.",
        };
        var (req, refusal) = await _gate.RequestAsync(DesktopActionTypes.DevEditFile, parameters, Path.GetFileName(full), full, $"D-ASK asks to edit {Path.GetFileName(full)}.", ctx, ct);
        if (refusal != null) return refusal;

        byte[] now = await File.ReadAllBytesAsync(full, ct);
        if (Sha(now) != shaBefore) { await _gate.AuditAsync("Changed", req!, ctx, "file changed after approval"); return DesktopCallResult.Fail("target_changed", "The file changed after you approved; nothing was written."); }
        Directory.CreateDirectory(_o.BackupDir);
        string backup = Path.Combine(_o.BackupDir, $"{DateTime.UtcNow:yyyyMMddTHHmmssfff}-{shaBefore[..12]}-{Path.GetFileName(full)}");
        await File.WriteAllBytesAsync(backup, now, ct);
        byte[] newBytes = (bom ? new byte[] { 0xEF, 0xBB, 0xBF } : Array.Empty<byte>()).Concat(Encoding.UTF8.GetBytes(after)).ToArray();
        string tmp = full + ".dask-edit.tmp";
        await File.WriteAllBytesAsync(tmp, newBytes, ct);
        File.Move(tmp, full, overwrite: true);

        // Verification: read back; the content must be exactly the approved change, nothing else.
        byte[] back = await File.ReadAllBytesAsync(full, ct);
        bool exact = back.AsSpan().SequenceEqual(newBytes);
        string backText = Encoding.UTF8.GetString(back, bom ? 3 : 0, back.Length - (bom ? 3 : 0));
        bool contains = backText.Contains(r, StringComparison.Ordinal) && (r.Contains(f) || !backText.Contains(f, StringComparison.Ordinal));
        var linesBefore = before.Split('\n'); var linesAfter = backText.Split('\n');
        int unchangedOutside = 0;
        int changedStart = before[..first].Count(c => c == '\n');
        for (int i = 0; i < changedStart && i < linesAfter.Length; i++) if (linesBefore[i] == linesAfter[i]) unchangedOutside++;
        bool verified = exact && contains && unchangedOutside == changedStart;
        await _gate.AuditAsync(verified ? "Verified" : "Unverified", req!, ctx, $"edit {Path.GetFileName(full)}: exact={exact}");
        _log?.LogInformation("[DevEdit] {File}: verified={Verified}.", Path.GetFileName(full), verified);
        if (!verified) return DesktopCallResult.Fail("execution_unverified", $"The file was written once, but reading it back does not show exactly the approved change (unintended modification). The original is in {backup}.");
        return DesktopCallResult.Ok(new
        {
            executed = true, verified = true, file = full, backup, sha256Before = shaBefore, sha256After = Sha(back), diff,
            linesBefore = linesBefore.Length, linesAfter = linesAfter.Length,
            observed = "the file now holds exactly the approved change and nothing else (read back and compared); line endings and encoding kept",
        });
    }
}
