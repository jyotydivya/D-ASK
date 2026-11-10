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

namespace DAsk.Daemon.Automation.Plugins;

public sealed class PluginOptions
{
    public bool Enabled { get; init; }
    public string PluginsDir { get; init; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D-ASK", "plugins");
    public string ApprovedPath { get; init; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D-ASK", "plugins-approved.json");
}

public sealed record ApprovedPlugin(string Id, string Version, Dictionary<string, string> Files, DateTime ApprovedUtc);

/// <summary>
/// Dynamic plugins: the daemon is the authority. A plugin is a folder in PluginsDir with plugin.json and its code. The daemon
/// reads and validates it ITSELF (id, version, tools, "compute" as the only permission; regular files only, no links or
/// subfolders, allowed types, size limits), computes the SHA-256 of every file, and shows the user an approval card
/// (Plugin.Install, Elevated). Only on approval is the plugin added to the approved list, which the agent host reads; the host
/// re-verifies every hash before each run and runs plugin code only in its sandbox. plugins.list is read-only; plugins.revoke
/// removes an approval (no approval needed to take a capability away). Off unless AgentHost:Plugins is true.
/// </summary>
public sealed class PluginService : IDesktopActionRequestService
{
    public const string ListTool = "plugins.list", Approve = "plugins.approve", Revoke = "plugins.revoke";
    public const string InstallType = "Plugin.Install";
    public static bool IsUnmetered(string tool) => tool == ListTool;
    public const int MaxFiles = 30;
    public const long MaxTotalBytes = 2 * 1024 * 1024;
    private static readonly Regex Id = new("^[a-z][a-z0-9_]{1,30}$");
    private static readonly Regex Version = new(@"^\d{1,4}\.\d{1,4}\.\d{1,4}$");
    private static readonly Regex FileName = new(@"^[\w.-]{1,80}$");
    private static readonly HashSet<string> AllowedExt = new(StringComparer.OrdinalIgnoreCase) { ".js", ".cjs", ".json", ".md", ".txt" };

    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly PluginOptions _opts;
    private readonly TimeSpan _ttl;
    private readonly ILogger? _logger;

    public PluginService(ActionPolicyEngine policy, Func<bool> isStopped, Func<ulong> generation, IEvidenceRecorder? evidence, PluginOptions options, TimeSpan? approvalTtl = null, ILogger? logger = null)
    {
        _policy = policy; _isStopped = isStopped; _generation = generation; _evidence = evidence; _opts = options; _ttl = approvalTtl ?? TimeSpan.FromSeconds(60); _logger = logger;
    }

    public bool Enabled => _opts.Enabled && _evidence != null;
    public IReadOnlyList<string> Tools => Enabled ? new[] { ListTool, Approve, Revoke } : Array.Empty<string>();
    public int MaxCallMs => (int)Math.Min(_ttl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + 10_000;

    public sealed record Inspected(string Id, string Name, string Version, string Description, List<(string name, string description)> Tools, Dictionary<string, string> Files, long Bytes);

    /// <summary>Reads and validates a plugin folder. The same rules as the agent host's validateManifest.</summary>
    public string? Inspect(string id, out Inspected? plugin)
    {
        plugin = null;
        if (!Id.IsMatch(id)) return "a plugin id is 2-31 lowercase letters, digits or _";
        var dir = new DirectoryInfo(Path.Combine(_opts.PluginsDir, id));
        if (!dir.Exists) return $"there is no folder {id} in the plugins folder";
        if ((dir.Attributes & FileAttributes.ReparsePoint) != 0) return "the plugin folder is a link";
        if (dir.EnumerateDirectories().Any()) return "a plugin folder may not contain subfolders";
        var files = dir.EnumerateFiles().ToList();
        if (files.Count is 0 or > MaxFiles) return $"a plugin has 1 to {MaxFiles} files";
        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        long total = 0;
        foreach (var f in files)
        {
            if ((f.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Hidden | FileAttributes.System)) != 0) return $"{f.Name} is a link, hidden or system file";
            if (!FileName.IsMatch(f.Name) || !AllowedExt.Contains(f.Extension)) return $"{f.Name}: only .js, .cjs, .json, .md and .txt files are allowed";
            total += f.Length;
            if (total > MaxTotalBytes) return "the plugin is larger than 2 MB";
            hashes[f.Name] = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(f.FullName))).ToLowerInvariant();
        }
        if (!hashes.ContainsKey("plugin.json")) return "plugin.json is missing";
        JsonElement m;
        try { m = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir.FullName, "plugin.json"))).RootElement; } catch { return "plugin.json is not valid JSON"; }
        string? S(JsonElement e, string n) => e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        if (S(m, "id") != id) return "the manifest id does not match the folder name";
        var name = S(m, "name"); var version = S(m, "version"); var entry = S(m, "entry");
        if (name is not { Length: >= 1 and <= 60 }) return "name is 1-60 characters";
        if (version == null || !Version.IsMatch(version)) return "version is MAJOR.MINOR.PATCH";
        if (entry == null || !Regex.IsMatch(entry, @"^[\w-]{1,60}\.(c?js)$") || !hashes.ContainsKey(entry)) return "entry must be a .js/.cjs file of the plugin";
        if (!m.TryGetProperty("permissions", out var perms) || perms.ValueKind != JsonValueKind.Array || perms.EnumerateArray().Any(p => p.GetString() != "compute"))
            return "the only permission a plugin may have is \"compute\"";
        if (!m.TryGetProperty("tools", out var tools) || tools.ValueKind != JsonValueKind.Array || tools.GetArrayLength() is 0 or > 10) return "1 to 10 tools";
        var list = new List<(string, string)>();
        foreach (var t in tools.EnumerateArray())
        {
            var tn = S(t, "name"); var td = S(t, "description");
            if (tn == null || !Id.IsMatch(tn)) return "tool names are 2-31 lowercase letters, digits or _";
            if (td is not { Length: >= 5 and <= 300 }) return "tool descriptions are 5-300 characters";
            if (!t.TryGetProperty("inputSchema", out var s) || S(s, "type") != "object" || !s.TryGetProperty("properties", out var props) || props.ValueKind != JsonValueKind.Object) return "each tool's inputSchema is an object schema";
            foreach (var p in props.EnumerateObject()) if (S(p.Value, "type") is not ("string" or "number" or "integer" or "boolean")) return "input properties are strings, numbers or booleans";
            if (t.TryGetProperty("timeoutMs", out var to) && (!to.TryGetInt32(out int ms) || ms <= 0 || ms > 10_000)) return "timeoutMs is at most 10000";
            list.Add((tn, td));
        }
        plugin = new Inspected(id, name, version, S(m, "description") ?? "", list, hashes, total);
        return null;
    }

    public List<ApprovedPlugin> LoadApproved()
    {
        try { return File.Exists(_opts.ApprovedPath) ? JsonSerializer.Deserialize<List<ApprovedPlugin>>(File.ReadAllText(_opts.ApprovedPath), new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }) ?? new() : new(); }
        catch { throw new InvalidDataException("approved list unreadable"); }
    }

    private void StoreApproved(List<ApprovedPlugin> all)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_opts.ApprovedPath)!);
        var tmp = _opts.ApprovedPath + ".tmp";
        // camelCase, the shape the agent host reads ({id, version, files, approvedUtc}).
        File.WriteAllText(tmp, JsonSerializer.Serialize(all, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }), new UTF8Encoding(false));
        File.Move(tmp, _opts.ApprovedPath, overwrite: true);
    }

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (!Tools.Contains(tool)) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (args.ValueKind != JsonValueKind.Object) return DesktopCallResult.Fail("invalid_args", "arguments must be an object");
        string? id = args.TryGetProperty("id", out var iv) && iv.ValueKind == JsonValueKind.String ? iv.GetString() : null;
        if (args.EnumerateObject().Any(p => p.Name != "id")) return DesktopCallResult.Fail("invalid_args", "only an id may be given");
        List<ApprovedPlugin> approved;
        try { approved = LoadApproved(); } catch { return DesktopCallResult.Fail("store_unreadable", "The approved-plugins list could not be read; nothing was changed."); }

        if (tool == ListTool)
        {
            var folders = Directory.Exists(_opts.PluginsDir) ? Directory.EnumerateDirectories(_opts.PluginsDir).Select(Path.GetFileName).Where(n => n != null && Id.IsMatch(n)).ToList() : new List<string?>();
            return DesktopCallResult.Ok(new
            {
                plugins = folders.Select(f =>
                {
                    var a = approved.FirstOrDefault(x => x.Id == f);
                    string? err = Inspect(f!, out var p);
                    bool intact = a != null && p != null && p.Version == a.Version && p.Files.Count == a.Files.Count && p.Files.All(kv => a.Files.TryGetValue(kv.Key, out var h) && h == kv.Value);
                    return new { id = f, name = p?.Name, version = p?.Version, approved = a != null, intact, problem = err, tools = p?.Tools.Select(t => t.name).ToArray() };
                }).ToArray(),
            });
        }
        if (id == null || !Id.IsMatch(id)) return DesktopCallResult.Fail("invalid_args", "a plugin id is required");
        if (tool == Revoke)
        {
            var a = approved.FirstOrDefault(x => x.Id == id);
            if (a == null) return DesktopCallResult.Fail("not_approved", $"The plugin {id} is not installed.");
            approved.Remove(a); StoreApproved(approved);
            await AuditAsync("PluginRevoked", ctx, id, "approval removed");
            return DesktopCallResult.Ok(new { revoked = true, id });
        }

        // Approve (install).
        if (Inspect(id, out var plugin) is { } bad) return DesktopCallResult.Fail("plugin_refused", $"The plugin cannot be installed: {bad}. Nothing was installed.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active. Nothing was installed.");
        string manifestHash = plugin!.Files["plugin.json"];
        var parameters = new Dictionary<string, string>
        {
            ["plugin"] = $"{plugin.Name} ({plugin.Id}) {plugin.Version}",
            ["tools"] = string.Join("\n", plugin.Tools.Select(t => $"{t.name}: {t.description}")),
            ["toolCount"] = plugin.Tools.Count.ToString(),
            ["permissions"] = "compute only: no files, no network, no programs, no other processes (enforced by D-ASK's sandbox)",
            ["files"] = $"{plugin.Files.Count} file(s), {plugin.Bytes} bytes; manifest SHA-256 {manifestHash}",
            ["verification"] = "Every file is checked against these hashes before each run; any change disables the plugin until approved again.",
            ["reversible"] = $"Yes: say \"remove the plugin {plugin.Id}\" (no approval needed).",
            ["execution"] = "Only the approval is recorded now; the plugin runs only when a request uses one of its tools.",
        };
        using var self = Process.GetCurrentProcess();
        var started = new DateTimeOffset(self.StartTime.ToUniversalTime(), TimeSpan.Zero);
        var (_, risk, _) = _policy.EvaluatePolicy(InstallType, new Dictionary<string, string>(), "D-ASK plugins");
        if (risk != ActionRiskLevel.Elevated) return DesktopCallResult.Fail("approval_refused", "Installing plugins is not classified for approval. Nothing was installed.");
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"), ActionId = Guid.NewGuid().ToString("N"), ActionType = InstallType, ActionParameters = parameters,
            TargetProcessName = "D-ASK plugins", TargetWindowTitle = plugin.Id, TargetHwnd = 0, TargetProcessId = self.Id, TargetProcessCreationTime = started,
            SessionId = ctx.OwnerSessionId, StopGeneration = _generation(), RiskLevel = risk.ToString(), CreatedAtUtc = DateTimeOffset.UtcNow,
            ExpiresAtUtc = DateTimeOffset.UtcNow + _ttl, Reason = $"D-ASK asks to install the plugin {plugin.Id} {plugin.Version}.",
        };
        await AuditAsync("PluginInstallRequested", ctx, id, $"{plugin.Version}; manifest {manifestHash}");
        var decision = await _policy.RequestApprovalAsync(request, ct);
        if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
        if (!decision.Approved) { await AuditAsync("PluginInstallNotApproved", ctx, id, decision.DecisionSource ?? "denied"); return DesktopCallResult.Fail("approval_denied", "The plugin was not approved. Nothing was installed."); }
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters, request.TargetProcessName, 0, self.Id, started,
            ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid) return DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was installed.");
        // The folder must still be exactly what was shown.
        if (Inspect(id, out var again) != null || again!.Files.Count != plugin.Files.Count || again.Files.Any(kv => !plugin.Files.TryGetValue(kv.Key, out var h) || h != kv.Value))
            return DesktopCallResult.Fail("changed", "The plugin's files changed after your approval; nothing was installed.");
        try { approved = LoadApproved(); } catch { return DesktopCallResult.Fail("store_unreadable", "The approved-plugins list could not be read; nothing was installed."); }
        approved.RemoveAll(x => x.Id == id);
        approved.Add(new ApprovedPlugin(plugin.Id, plugin.Version, plugin.Files, DateTime.UtcNow));
        StoreApproved(approved);
        await AuditAsync("PluginInstalled", ctx, id, $"{plugin.Version}; manifest {manifestHash}");
        _logger?.LogInformation("[Plugins] {Id} {Version} approved ({Count} files).", plugin.Id, plugin.Version, plugin.Files.Count);
        return DesktopCallResult.Ok(new { decision = "approved", consumed = true, executed = true, verified = true, id = plugin.Id, version = plugin.Version, tools = plugin.Tools.Select(t => t.name).ToArray() });
    }

    private async Task AuditAsync(string evt, DesktopActionContext ctx, string id, string reason)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt, Source = "PluginService", ActionId = Guid.NewGuid().ToString("N"), SessionId = ctx.OwnerSessionId, RiskLevel = "Elevated",
                StopGeneration = _generation(), Decision = evt, Reason = AuditJson.Bound(reason), DetailsJson = AuditJson.Details(new { taskId = ctx.TaskId, plugin = id }),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[Plugins] Audit record {Event} failed.", evt); }
    }
}
