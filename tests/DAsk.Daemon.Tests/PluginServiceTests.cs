using System.Security.Cryptography;
using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Plugins;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>Plugins: the daemon validates a plugin folder itself, shows the approval card, and records exact hashes.</summary>
[Collection("AgentHost")]
public partial class PluginServiceTests
{
    private const string Owner = "hud-session-owner";

    internal sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly PluginService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly string Root = Path.Combine(Path.GetTempPath(), $"dask-plg-{Guid.NewGuid():N}");
        public string Plugins => Path.Combine(Root, "plugins");
        public string Approved => Path.Combine(Root, "approved.json");
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-plg-{Guid.NewGuid():N}.db");

        public Rig(bool enabled = true)
        {
            Directory.CreateDirectory(Plugins);
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => s == Owner);
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Service = new PluginService(Policy, () => false, () => 1, Recorder, new PluginOptions { Enabled = enabled, PluginsDir = Plugins, ApprovedPath = Approved }, TimeSpan.FromSeconds(10));
        }

        /// <summary>Copies the repository's sample plugin (plugins-samples/text_tools) into this rig's plugins folder.</summary>
        public string CopySample(string id = "text_tools", string source = "text_tools")
        {
            var src = Path.Combine(FindRepoRoot(), "plugins-samples", source);
            var dst = Path.Combine(Plugins, id);
            Directory.CreateDirectory(dst);
            foreach (var f in Directory.GetFiles(src)) File.Copy(f, Path.Combine(dst, Path.GetFileName(f)));
            return dst;
        }

        public Task<DesktopCallResult> Call(string tool, object args) => Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), CancellationToken.None);

        public async Task<(DesktopCallResult res, ActionApprovalRequest req)> Install(string id, bool approve = true, Action? before = null)
        {
            lock (Delivered) Delivered.Clear();
            var call = Call(PluginService.Approve, new { id });
            ActionApprovalRequest? r = null;
            for (var until = DateTime.UtcNow.AddSeconds(5); r == null && DateTime.UtcNow < until; await Task.Delay(5)) lock (Delivered) r = Delivered.LastOrDefault();
            Assert.NotNull(r);
            before?.Invoke();
            Assert.True(Policy.SubmitApprovalDecision(new ActionApprovalResponse { ApprovalId = r!.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType,
                ParametersSha256 = r.ParametersSha256, ActionDigest = r.ActionDigest, Approved = approve, DecisionSource = "UserExplicitConfirmation" }, Owner, () => false, () => 1));
            return (await call, r);
        }

        /// <summary>Calls any approval-gated plugin tool and answers its card (approve or deny). Returns the result and the card.</summary>
        public async Task<(DesktopCallResult res, ActionApprovalRequest? req)> Ask(string tool, object args, bool approve = true, Action? before = null)
        {
            lock (Delivered) Delivered.Clear();
            var call = Call(tool, args);
            ActionApprovalRequest? r = null;
            for (var until = DateTime.UtcNow.AddSeconds(3); r == null && DateTime.UtcNow < until && !call.IsCompleted; await Task.Delay(5)) lock (Delivered) r = Delivered.LastOrDefault();
            if (r == null) return (await call, null);   // refused before any card
            before?.Invoke();
            Assert.True(Policy.SubmitApprovalDecision(new ActionApprovalResponse { ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType,
                ParametersSha256 = r.ParametersSha256, ActionDigest = r.ActionDigest, Approved = approve, DecisionSource = "UserExplicitConfirmation" }, Owner, () => false, () => 1));
            return (await call, r);
        }

        public JsonElement Entry() { using var d = JsonDocument.Parse(File.ReadAllText(Approved)); return d.RootElement[0].Clone(); }

        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(_db); } catch { } try { Directory.Delete(Root, true); } catch { } }
    }

    private static string FindRepoRoot()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, "plugins-samples"))) return d.FullName;
        throw new DirectoryNotFoundException("repository root");
    }

    [Fact]
    public async Task Install_Approved_ShowsToolsAndComputeOnly_RecordsExactHashes()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var dir = rig.CopySample();
        var (res, req) = await rig.Install("text_tools");
        Assert.Equal("ok", res.Status);
        Assert.Equal("Plugin.Install", req.ActionType);
        Assert.Equal("Elevated", req.RiskLevel);
        Assert.Contains("word_count:", req.ActionParameters["tools"]);
        Assert.Equal("2", req.ActionParameters["toolCount"]);
        Assert.StartsWith("compute only", req.ActionParameters["permissions"]);
        using var doc = JsonDocument.Parse(File.ReadAllText(rig.Approved));
        var entry = doc.RootElement[0];
        Assert.Equal("text_tools", entry.GetProperty("id").GetString());
        Assert.Equal("1.0.0", entry.GetProperty("version").GetString());
        var expected = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(dir, "index.js")))).ToLowerInvariant();
        Assert.Equal(expected, entry.GetProperty("files").GetProperty("index.js").GetString());   // the shape the agent host reads
    }

    [Fact]
    public async Task Install_Denied_OrChangedAfterApproval_InstallsNothing()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var dir = rig.CopySample();
        var (denied, _) = await rig.Install("text_tools", approve: false);
        Assert.Equal("approval_denied", denied.Error!.Code);
        Assert.False(File.Exists(rig.Approved));
        var (changed, _) = await rig.Install("text_tools", before: () => File.AppendAllText(Path.Combine(dir, "index.js"), "\n// swapped"));
        Assert.Equal("changed", changed.Error!.Code);
        Assert.False(File.Exists(rig.Approved));
    }

    [Theory]
    [InlineData("network")]
    [InlineData("write:workspace")]
    [InlineData("process:spawn")]
    public async Task Install_AnyPermissionButCompute_RefusedWithoutAsking(string permission)
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var dir = rig.CopySample();
        var m = File.ReadAllText(Path.Combine(dir, "plugin.json")).Replace("\"compute\"", $"\"compute\", \"{permission}\"");
        File.WriteAllText(Path.Combine(dir, "plugin.json"), m);
        var res = await rig.Call(PluginService.Approve, new { id = "text_tools" });
        Assert.Equal("plugin_refused", res.Error!.Code);
        lock (rig.Delivered) Assert.Empty(rig.Delivered);
    }

    [Fact]
    public async Task Install_BadFolders_Refused()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var a = rig.CopySample("text_tools"); Directory.CreateDirectory(Path.Combine(a, "sub"));
        Assert.Equal("plugin_refused", (await rig.Call(PluginService.Approve, new { id = "text_tools" })).Error!.Code);
        Directory.Delete(Path.Combine(a, "sub"));
        File.WriteAllBytes(Path.Combine(a, "helper.exe"), new byte[] { 1 });
        Assert.Equal("plugin_refused", (await rig.Call(PluginService.Approve, new { id = "text_tools" })).Error!.Code);
        File.Delete(Path.Combine(a, "helper.exe"));
        var b = rig.CopySample("other_id");   // folder name and manifest id disagree
        Assert.Equal("plugin_refused", (await rig.Call(PluginService.Approve, new { id = "other_id" })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Call(PluginService.Approve, new { id = "../x" })).Error!.Code);
        lock (rig.Delivered) Assert.Empty(rig.Delivered);
    }

    [Fact]
    public async Task List_ShowsIntactState_AndRevokeRemovesTheApproval()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var dir = rig.CopySample();
        await rig.Install("text_tools");
        var list = JsonSerializer.SerializeToElement((await rig.Call(PluginService.ListTool, new { })).Result).GetProperty("plugins")[0];
        Assert.True(list.GetProperty("approved").GetBoolean() && list.GetProperty("intact").GetBoolean());
        File.AppendAllText(Path.Combine(dir, "index.js"), "\n// edited later");
        list = JsonSerializer.SerializeToElement((await rig.Call(PluginService.ListTool, new { })).Result).GetProperty("plugins")[0];
        Assert.False(list.GetProperty("intact").GetBoolean());
        Assert.Equal("ok", (await rig.Call(PluginService.Revoke, new { id = "text_tools" })).Status);
        Assert.Equal("[]", File.ReadAllText(rig.Approved));
        Assert.Equal("not_approved", (await rig.Call(PluginService.Revoke, new { id = "text_tools" })).Error!.Code);
    }

    [Fact]
    public void OffByDefault_ListUnmetered()
    {
        using var off = new Rig(enabled: false);
        Assert.Empty(off.Service.Tools);
        Assert.False(new DAsk.Daemon.AgentHost.AgentHostOptions().Plugins);
        Assert.True(PluginService.IsUnmetered("plugins.list") && !PluginService.IsUnmetered("plugins.approve"));
    }
}
