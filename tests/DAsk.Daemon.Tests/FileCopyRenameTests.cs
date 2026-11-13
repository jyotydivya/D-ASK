using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Files;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Copy and rename (one file per request) through the same service, policy engine, approval, journal and audit as file organisation.
/// Real temporary folders; the HUD decision is simulated.
/// </summary>
[Collection("AgentHost")]
public class FileCopyRenameTests
{
    private const string Owner = "hud-session-owner";

    private sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly FileOrganizeRequestService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public bool Stopped;
        public readonly string Root = Path.Combine(Path.GetTempPath(), $"dask-cr-{Guid.NewGuid():N}");
        public readonly string Folder, Other, Outside, Journal;
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-cr-{Guid.NewGuid():N}.db");

        public Rig()
        {
            Folder = Path.Combine(Root, "Docs"); Other = Path.Combine(Root, "Docs", "Archive"); Outside = Path.Combine(Root, "Elsewhere"); Journal = Path.Combine(Root, "journal");
            Directory.CreateDirectory(Folder); Directory.CreateDirectory(Other); Directory.CreateDirectory(Outside);
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => s == Owner);
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Service = new FileOrganizeRequestService(Policy, () => Stopped, () => 1, Recorder,
                new FileOrganizeOptions { Enabled = true, Roots = new[] { Folder }, JournalDir = Journal }, TimeSpan.FromSeconds(10));
        }
        public string Put(string name, string content = "hello", string? dir = null) { var p = Path.Combine(dir ?? Folder, name); File.WriteAllText(p, content); return p; }
        public Task<DesktopCallResult> Ask(string tool, object args) => Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), CancellationToken.None);
        public async Task<(DesktopCallResult res, ActionApprovalRequest req)> Run(string tool, object args, bool approve = true, Action? before = null)
        {
            lock (Delivered) Delivered.Clear();
            var call = Ask(tool, args);
            ActionApprovalRequest? r = null;
            for (int i = 0; i < 1000 && r == null; i++) { lock (Delivered) r = Delivered.LastOrDefault(); if (r == null) await Task.Delay(5); }
            if (r == null) { var early = call.IsCompleted ? await call : null; throw new TimeoutException($"no approval ({early?.Error?.Code}: {early?.Error?.Message})"); }
            before?.Invoke();
            Assert.True(Policy.SubmitApprovalDecision(new ActionApprovalResponse { ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256, ActionDigest = r.ActionDigest, Approved = approve, DecisionSource = "UserExplicitConfirmation" }, Owner, () => Stopped, () => 1));
            return (await call, r);
        }
        public async Task<List<string>> Events() => (await Recorder.GetSafetyAuditRecordsAsync(200)).Select(e => e.EventType).Reverse().ToList();
        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(_db); } catch { } try { Directory.Delete(Root, true); } catch { } }
    }
    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);

    [Fact]
    public async Task Copy_Approved_IsByteIdentical_AndUndoRemovesOnlyTheUnchangedCopy()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var src = rig.Put("plan.txt", "the plan");
        var (res, req) = await rig.Run(FileOrganizeRequestService.Copy, new { path = src, toFolder = rig.Other });
        Assert.Equal("ok", res.Status);
        Assert.Equal("Files.Copy", req.ActionType); Assert.Equal("Elevated", req.RiskLevel);
        Assert.Equal(Path.Combine(rig.Other, "plan.txt"), req.ActionParameters["destination"]);
        Assert.True(J(res).GetProperty("verified").GetBoolean());
        Assert.Equal("the plan", File.ReadAllText(Path.Combine(rig.Other, "plan.txt")));
        Assert.True(File.Exists(src));
        var (undo, ureq) = await rig.Run(FileOrganizeRequestService.UndoCopyRename, new { });
        Assert.Equal("Files.UndoCopyRename", ureq.ActionType);
        Assert.Equal("Remove the copy D-ASK made", ureq.ActionParameters["operation"]);
        Assert.True(J(undo).GetProperty("verified").GetBoolean());
        Assert.False(File.Exists(Path.Combine(rig.Other, "plan.txt")));
        Assert.True(File.Exists(src));
        var ev = await rig.Events();
        Assert.Contains("FileCopyRequested", ev); Assert.Contains("FileCopyPerformed", ev); Assert.Contains("FileCopyRenameUndone", ev);
    }

    [Fact]
    public async Task Copy_NameTaken_GetsAFreeName_ShownOnTheCard_NeverOverwrites()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var src = rig.Put("a.txt", "new");
        rig.Put("a.txt", "OLD", rig.Other);
        var (res, req) = await rig.Run(FileOrganizeRequestService.Copy, new { path = src, toFolder = rig.Other });
        Assert.StartsWith("Yes: a.txt already exists, so the copy is named a (copy).txt", req.ActionParameters["nameTaken"]);
        Assert.Equal("OLD", File.ReadAllText(Path.Combine(rig.Other, "a.txt")));
        Assert.Equal("new", File.ReadAllText(Path.Combine(rig.Other, "a (copy).txt")));
        Assert.True(J(res).GetProperty("renamedBecauseTaken").GetBoolean());
    }

    [Fact]
    public async Task Copy_UndoRefusesAChangedCopy()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var src = rig.Put("b.txt");
        await rig.Run(FileOrganizeRequestService.Copy, new { path = src, newName = "b2.txt" });
        File.WriteAllText(Path.Combine(rig.Folder, "b2.txt"), "edited by the user");
        var r = await rig.Ask(FileOrganizeRequestService.UndoCopyRename, new { });
        Assert.Equal("error", r.Status); Assert.Equal("nothing_to_undo", r.Error!.Code);
        Assert.Equal("edited by the user", File.ReadAllText(Path.Combine(rig.Folder, "b2.txt")));
    }

    [Fact]
    public async Task Copy_OutsideTheAllowedFolders_OrUnsafeNames_AreRefusedBeforeAnyApproval()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var src = rig.Put("c.txt");
        var outside = rig.Put("x.txt", "x", rig.Outside);
        foreach (var args in new object[] { new { path = src, toFolder = rig.Outside }, new { path = outside }, new { path = src, newName = "..\\evil.txt" }, new { path = src, newName = "con" }, new { path = "c.txt" }, new { path = src, extra = "x" } })
        {
            var r = await rig.Ask(FileOrganizeRequestService.Copy, args);
            Assert.Equal("error", r.Status);
        }
        lock (rig.Delivered) Assert.Empty(rig.Delivered);
        Assert.Single(Directory.GetFiles(rig.Folder));
    }

    [Fact]
    public async Task Rename_Approved_AndUndoRenamesBack()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var src = rig.Put("draft.txt", "d");
        var (res, req) = await rig.Run(FileOrganizeRequestService.Rename, new { path = src, newName = "final.txt" });
        Assert.Equal("Files.Rename", req.ActionType);
        Assert.Equal("draft.txt", req.ActionParameters["from"]); Assert.Equal("final.txt", req.ActionParameters["to"]); Assert.Equal("No", req.ActionParameters["extensionChange"]);
        Assert.True(J(res).GetProperty("verified").GetBoolean());
        Assert.False(File.Exists(src)); Assert.True(File.Exists(Path.Combine(rig.Folder, "final.txt")));
        var (undo, _) = await rig.Run(FileOrganizeRequestService.UndoCopyRename, new { });
        Assert.True(J(undo).GetProperty("verified").GetBoolean());
        Assert.True(File.Exists(src)); Assert.False(File.Exists(Path.Combine(rig.Folder, "final.txt")));
        Assert.Contains("FileRenamePerformed", await rig.Events());
    }

    [Fact]
    public async Task Rename_NeverOverwrites_ExtensionChangeIsShown_CaseOnlyWorks()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var a = rig.Put("one.txt", "1"); rig.Put("two.txt", "2");
        var taken = await rig.Ask(FileOrganizeRequestService.Rename, new { path = a, newName = "two.txt" });
        Assert.Equal("name_taken", taken.Error!.Code);
        Assert.Equal("2", File.ReadAllText(Path.Combine(rig.Folder, "two.txt")));
        var (_, req) = await rig.Run(FileOrganizeRequestService.Rename, new { path = a, newName = "one.md" }, approve: false);
        Assert.StartsWith("Yes: .txt becomes .md", req.ActionParameters["extensionChange"]);
        Assert.True(File.Exists(a));
        var (res, _) = await rig.Run(FileOrganizeRequestService.Rename, new { path = a, newName = "ONE.txt" });
        Assert.True(J(res).GetProperty("verified").GetBoolean());
        Assert.Contains("ONE.txt", Directory.GetFiles(rig.Folder).Select(Path.GetFileName));
    }

    [Fact]
    public async Task EmergencyStop_BeforeOrDuringApproval_NothingHappens()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var a = rig.Put("s.txt");
        rig.Stopped = true;
        var r = await rig.Ask(FileOrganizeRequestService.Copy, new { path = a });
        Assert.Equal("emergency_stopped", r.Error!.Code);
        rig.Stopped = false;
        var (res, _) = await rig.Run(FileOrganizeRequestService.Rename, new { path = a, newName = "t.txt" }, before: () => rig.Stopped = true);
        Assert.Equal("error", res.Status);
        Assert.True(File.Exists(a)); Assert.False(File.Exists(Path.Combine(rig.Folder, "t.txt")));
    }

    [Fact]
    public async Task UndoOrganize_IsNotConfusedWithCopyOrRename()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var a = rig.Put("u.txt");
        await rig.Run(FileOrganizeRequestService.Rename, new { path = a, newName = "v.txt" });
        var r = await rig.Ask(FileOrganizeRequestService.Undo, new { });
        Assert.Equal("nothing_to_undo", r.Error!.Code);
        Assert.True(File.Exists(Path.Combine(rig.Folder, "v.txt")));
    }
}
