using System.Text.Json;
using DAsk.Daemon.Automation.Plugins;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>Granular plugin permissions: declared vs granted, one approval card per grant, individual revocation, persistence, disable / enable.</summary>
public partial class PluginServiceTests
{
    private static string[] Granted(JsonElement e) => e.GetProperty("granted").EnumerateArray().Select(x => x.GetString()!).ToArray();

    [Fact]
    public async Task Install_GrantsComputeOnly_AndSaysSoOnTheCard()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        rig.CopySample("note_reader", "note_reader");
        var (res, req) = await rig.Install("note_reader");
        Assert.Equal("ok", res.Status);
        Assert.StartsWith("compute only", req.ActionParameters["permissions"]);
        Assert.Contains("files.read", req.ActionParameters["permissions"]);
        Assert.Contains("does NOT grant", req.ActionParameters["permissions"]);
        Assert.Equal(new[] { "compute" }, Granted(rig.Entry()));
        var item = JsonSerializer.SerializeToElement((await rig.Call(PluginService.ListTool, new { })).Result).GetProperty("plugins")[0];
        Assert.Equal(new[] { "compute", "files.read", "memory.read" }, item.GetProperty("declared").EnumerateArray().Select(x => x.GetString()).ToArray());
        Assert.Equal(new[] { "compute" }, item.GetProperty("granted").EnumerateArray().Select(x => x.GetString()).ToArray());
        Assert.True(item.GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task Grant_Approved_AddsOnlyThatPermission_ShowsAnExactCard_AndPersists()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        rig.CopySample("note_reader", "note_reader");
        await rig.Install("note_reader");
        var (res, req) = await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "files.read" });
        Assert.Equal("ok", res.Status);
        Assert.NotNull(req);
        Assert.Equal("Plugin.GrantPermission", req!.ActionType);
        Assert.Equal("Elevated", req.RiskLevel);
        Assert.Equal("files.read", req.ActionParameters["permission"]);
        Assert.Contains("never secret files", req.ActionParameters["allows"]);
        Assert.Contains("compute", req.ActionParameters["currently"]);
        Assert.Equal(new[] { "compute", "files.read" }, Granted(rig.Entry()));           // memory.read is NOT granted
        // a new service instance (a restart) reads the same state from disk
        Assert.Equal(new[] { "compute", "files.read" }, rig.Service.LoadApproved()[0].GrantedPermissions.ToArray());
        var again = await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "files.read" });
        Assert.Equal("already_granted", again.res.Error!.Code);
        Assert.Null(again.req);
        var (res2, _) = await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "memory.read" });
        Assert.Equal("ok", res2.Status);
        Assert.Equal(new[] { "compute", "files.read", "memory.read" }, Granted(rig.Entry()));
    }

    [Fact]
    public async Task Grant_Denied_ChangedAfterApproval_OrNotDeclared_GrantsNothing()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var dir = rig.CopySample("note_reader", "note_reader");
        await rig.Install("note_reader");
        var (denied, req) = await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "files.read" }, approve: false);
        Assert.NotNull(req);
        Assert.Equal("approval_denied", denied.Error!.Code);
        Assert.Equal(new[] { "compute" }, Granted(rig.Entry()));
        var (changed, _) = await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "files.read" }, before: () => File.AppendAllText(Path.Combine(dir, "index.js"), "\n// swapped after the card"));
        Assert.Equal("changed", changed.Error!.Code);
        Assert.Equal(new[] { "compute" }, Granted(rig.Entry()));
        // A plugin that never declared the permission can never be given it, and the user is not even asked.
        rig.CopySample("text_tools");
        await rig.Install("text_tools");
        var und = await rig.Ask(PluginService.GrantTool, new { id = "text_tools", permission = "files.read" });
        Assert.Equal("not_declared", und.res.Error!.Code);
        Assert.Null(und.req);
        Assert.Equal("not_approved", (await rig.Ask(PluginService.GrantTool, new { id = "ghost_plugin", permission = "files.read" })).res.Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "network" })).res.Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(PluginService.GrantTool, new { id = "note_reader" })).res.Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "files.read", extra = 1 })).res.Error!.Code);
    }

    [Fact]
    public async Task RevokePermission_IsIndividual_NeedsNoCard_AndComputeIsNotRevocable()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        rig.CopySample("note_reader", "note_reader");
        await rig.Install("note_reader");
        await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "files.read" });
        await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "memory.read" });
        var (res, req) = await rig.Ask(PluginService.RevokePermissionTool, new { id = "note_reader", permission = "files.read" });
        Assert.Equal("ok", res.Status);
        Assert.Null(req);                                                                  // taking a capability away needs no approval
        Assert.Equal(new[] { "compute", "memory.read" }, Granted(rig.Entry()));            // the other grant is untouched
        Assert.Equal("not_granted", (await rig.Ask(PluginService.RevokePermissionTool, new { id = "note_reader", permission = "files.read" })).res.Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(PluginService.RevokePermissionTool, new { id = "note_reader", permission = "compute" })).res.Error!.Code);
        Assert.Equal("not_approved", (await rig.Ask(PluginService.RevokePermissionTool, new { id = "nobody", permission = "files.read" })).res.Error!.Code);
    }

    [Fact]
    public async Task DisableAndEnable_KeepTheApproval_ButEnableNeedsIntactFiles()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var dir = rig.CopySample("note_reader", "note_reader");
        await rig.Install("note_reader");
        await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "files.read" });
        var (dis, dreq) = await rig.Ask(PluginService.DisableTool, new { id = "note_reader" });
        Assert.Equal("ok", dis.Status); Assert.Null(dreq);
        Assert.True(rig.Entry().GetProperty("disabled").GetBoolean());
        Assert.Equal(new[] { "compute", "files.read" }, Granted(rig.Entry()));             // permissions are kept while disabled
        var item = JsonSerializer.SerializeToElement((await rig.Call(PluginService.ListTool, new { })).Result).GetProperty("plugins")[0];
        Assert.False(item.GetProperty("enabled").GetBoolean());
        File.AppendAllText(Path.Combine(dir, "index.js"), "\n// edited while disabled");
        Assert.Equal("changed", (await rig.Ask(PluginService.EnableTool, new { id = "note_reader" })).res.Error!.Code);   // a changed plugin cannot be re-enabled
        Assert.True(rig.Entry().GetProperty("disabled").GetBoolean());
        File.WriteAllText(Path.Combine(dir, "index.js"), File.ReadAllText(Path.Combine(FindRepoRoot(), "plugins-samples", "note_reader", "index.js")));
        Assert.Equal("ok", (await rig.Ask(PluginService.EnableTool, new { id = "note_reader" })).res.Status);
        Assert.False(rig.Entry().TryGetProperty("disabled", out var d) && d.GetBoolean());
        Assert.Equal("not_approved", (await rig.Ask(PluginService.DisableTool, new { id = "nobody" })).res.Error!.Code);
    }

    [Fact]
    public async Task EveryChange_IsAudited_AndAnOldApprovalFileStillMeansComputeOnly()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        rig.CopySample("note_reader", "note_reader");
        await rig.Install("note_reader");
        await rig.Ask(PluginService.GrantTool, new { id = "note_reader", permission = "files.read" });
        await rig.Ask(PluginService.RevokePermissionTool, new { id = "note_reader", permission = "files.read" });
        await rig.Ask(PluginService.DisableTool, new { id = "note_reader" });
        await rig.Ask(PluginService.EnableTool, new { id = "note_reader" });
        var events = await rig.Recorder.GetSafetyAuditRecordsAsync(100);
        var names = events.Select(e => e.EventType).ToList();
        foreach (var expected in new[] { "PluginInstalled", "PluginPermissionRequested", "PluginPermissionGranted", "PluginPermissionRevoked", "PluginDisabled", "PluginEnabled" })
            Assert.Contains(expected, names);
        // a record written before granular permissions had no "granted" list: it must mean compute only, never "everything declared"
        var old = "[{\"id\":\"note_reader\",\"version\":\"1.0.0\",\"files\":{},\"approvedUtc\":\"2026-01-01T00:00:00Z\"}]";
        File.WriteAllText(rig.Approved, old);
        Assert.Equal(new[] { "compute" }, rig.Service.LoadApproved()[0].GrantedPermissions.ToArray());
    }

    [Fact]
    public void GrantType_IsElevated_AndPluginPermissionCatalogueIsClosed()
    {
        Assert.True(PluginService.IsUnmetered("plugins.disable") && PluginService.IsUnmetered("plugins.enable") && PluginService.IsUnmetered("plugins.revoke_permission"));
        Assert.False(PluginService.IsUnmetered("plugins.grant"));
        Assert.Equal(new[] { "compute", "files.read", "memory.read" }, PluginPermissions.All.Keys.OrderBy(k => k).ToArray());
    }
}
