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
/// files.move: ONE file or ONE folder to another allowed folder (any of the allowed roots), after approval of the exact source and
/// destination. Never overwrites (a collision is reported, never silently renamed); re-validated after approval; undo journal written
/// before acting; verified by SHA-256 (file) or a content manifest (folder) with the source gone; undo moves it back only if unchanged.
/// Real files on disk (temporary folders); real policy engine, approvals and audit journal.
/// </summary>
public class FileMoveTests
{
    private const string Owner = "hud-session-owner";

    private sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly FileOrganizeRequestService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public bool Stopped;
        public readonly string Root = Path.Combine(Path.GetTempPath(), $"dask-mv-{Guid.NewGuid():N}");
        public readonly string A, B, Outside, Journal;
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-mv-{Guid.NewGuid():N}.db");
        public Rig()
        {
            A = Path.Combine(Root, "Work"); B = Path.Combine(Root, "Archive"); Outside = Path.Combine(Root, "Elsewhere"); Journal = Path.Combine(Root, "journal");
            foreach (var d in new[] { A, B, Outside }) Directory.CreateDirectory(d);
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => s == Owner);
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Service = new FileOrganizeRequestService(Policy, () => Stopped, () => 1, Recorder,
                new FileOrganizeOptions { Enabled = true, Roots = new[] { A, B }, JournalDir = Journal }, TimeSpan.FromSeconds(10));
        }
        public string Put(string dir, string name, string content = "hello") { Directory.CreateDirectory(dir); var p = Path.Combine(dir, name); File.WriteAllText(p, content); return p; }
        public Task<DesktopCallResult> Ask(string tool, object args) => Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), CancellationToken.None);
        public async Task<(DesktopCallResult Res, ActionApprovalRequest? Req)> Run(string tool, object args, bool approve = true, Action? before = null)
        {
            lock (Delivered) Delivered.Clear();
            var call = Ask(tool, args);
            ActionApprovalRequest? r = null;
            for (int i = 0; i < 1000 && r == null && !call.IsCompleted; i++) { lock (Delivered) r = Delivered.LastOrDefault(); if (r == null) await Task.Delay(5); }
            lock (Delivered) r ??= Delivered.LastOrDefault();
            if (r != null)
            {
                before?.Invoke();
                Policy.SubmitApprovalDecision(new ActionApprovalResponse { ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256, ActionDigest = r.ActionDigest, Approved = approve, DecisionSource = "UserExplicitConfirmation" }, Owner, () => Stopped, () => 1);
            }
            return (await call, r);
        }
        public async Task<List<string>> Events() => (await Recorder.GetSafetyAuditRecordsAsync(200)).Select(e => e.EventType).Reverse().ToList();
        public void Dispose() { SqliteConnection.ClearAllPools(); try { Directory.Delete(Root, true); } catch { } try { File.Delete(_db); } catch { } }
    }
    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);

    [Fact]
    public async Task File_MovesBetweenAllowedRoots_VerifiedBySha256_AndUndoMovesItBack()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var src = rig.Put(rig.A, "report.pdf", "%PDF report bytes");
        var (res, req) = await rig.Run(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.B });
        Assert.Equal("ok", res.Status);
        Assert.Equal("Files.Move", req!.ActionType); Assert.Equal("Elevated", req.RiskLevel);
        Assert.Equal(src, req.ActionParameters["source"]); Assert.Equal(Path.Combine(rig.B, "report.pdf"), req.ActionParameters["destination"]);
        Assert.True(J(res).GetProperty("verified").GetBoolean());
        Assert.False(File.Exists(src));
        Assert.Equal("%PDF report bytes", File.ReadAllText(Path.Combine(rig.B, "report.pdf")));

        var (undo, ureq) = await rig.Run(FileOrganizeRequestService.UndoCopyRename, new { });
        Assert.Equal("Move a file back", ureq!.ActionParameters["operation"]);
        Assert.True(J(undo).GetProperty("verified").GetBoolean());
        Assert.True(File.Exists(src)); Assert.False(File.Exists(Path.Combine(rig.B, "report.pdf")));
        var ev = await rig.Events();
        Assert.Contains("FileMovePerformed", ev); Assert.Contains("FileMoveUndone", ev);
    }

    [Fact]
    public async Task Folder_MovesWithAllItsFiles_VerifiedByManifest_AndUndoMovesItBack()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        string proj = Path.Combine(rig.A, "Project X");
        rig.Put(proj, "notes.txt", "n"); rig.Put(Path.Combine(proj, "src"), "main.cs", "class C {}"); rig.Put(Path.Combine(proj, "src"), "util.cs", "static class U {}");
        var (res, req) = await rig.Run(FileOrganizeRequestService.MoveTool, new { path = proj, toFolder = rig.B });
        Assert.Equal("ok", res.Status);
        Assert.Equal("Move a folder", req!.ActionParameters["operation"]);
        Assert.StartsWith("3 file(s)", req.ActionParameters["content"]);
        Assert.True(J(res).GetProperty("verified").GetBoolean());
        Assert.False(Directory.Exists(proj));
        Assert.Equal("class C {}", File.ReadAllText(Path.Combine(rig.B, "Project X", "src", "main.cs")));
        var (undo, _) = await rig.Run(FileOrganizeRequestService.UndoCopyRename, new { });
        Assert.True(J(undo).GetProperty("verified").GetBoolean());
        Assert.True(File.Exists(Path.Combine(proj, "src", "util.cs")));
    }

    [Fact]
    public async Task Collision_IsReportedNeverOverwritten_ANewNameIsExplicit()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var src = rig.Put(rig.A, "a.txt", "new");
        rig.Put(rig.B, "a.txt", "OLD");
        var (res, req) = await rig.Run(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.B });
        Assert.Equal("name_taken", res.Error!.Code);
        Assert.Null(req);   // nothing asked
        Assert.Equal("OLD", File.ReadAllText(Path.Combine(rig.B, "a.txt")));
        Assert.True(File.Exists(src));
        var (ok, req2) = await rig.Run(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.B, newName = "a (from Work).txt" });
        Assert.Equal("ok", ok.Status);
        Assert.Equal(Path.Combine(rig.B, "a (from Work).txt"), req2!.ActionParameters["destination"]);
        Assert.Equal("OLD", File.ReadAllText(Path.Combine(rig.B, "a.txt")));
    }

    [Fact]
    public async Task OutsideAllowedFolders_IntoItself_ARoot_OrUnsafeNames_AreRefusedBeforeAsking()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var src = rig.Put(rig.A, "x.txt");
        var outsideFile = rig.Put(rig.Outside, "y.txt");
        string sub = Path.Combine(rig.A, "Sub"); Directory.CreateDirectory(Path.Combine(sub, "Inner"));
        Assert.Equal("folder_refused", (await rig.Ask(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.Outside })).Error!.Code);
        Assert.Equal("file_refused", (await rig.Ask(FileOrganizeRequestService.MoveTool, new { path = outsideFile, toFolder = rig.B })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(FileOrganizeRequestService.MoveTool, new { path = sub, toFolder = Path.Combine(sub, "Inner") })).Error!.Code);
        Assert.Equal("folder_refused", (await rig.Ask(FileOrganizeRequestService.MoveTool, new { path = rig.A, toFolder = rig.B })).Error!.Code);   // an allowed root itself
        Assert.Equal("invalid_args", (await rig.Ask(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.B, newName = @"..\escape.txt" })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.A })).Error!.Code);    // already there
        Assert.Equal("invalid_args", (await rig.Ask(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.B, overwrite = "yes" })).Error!.Code);
        Assert.Empty(rig.Delivered);
        Assert.True(File.Exists(src) && File.Exists(outsideFile));
    }

    [Fact]
    public async Task Denied_Stopped_ChangedAfterApproval_NothingMoves()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var src = rig.Put(rig.A, "d.txt", "v1");
        Assert.Equal("approval_denied", (await rig.Run(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.B }, approve: false)).Res.Error!.Code);
        Assert.True(File.Exists(src));
        var (changed, _) = await rig.Run(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.B }, before: () => File.WriteAllText(src, "v2 changed"));
        Assert.Equal("changed", changed.Error!.Code);
        Assert.True(File.Exists(src)); Assert.False(File.Exists(Path.Combine(rig.B, "d.txt")));
        var (taken, _) = await rig.Run(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.B }, before: () => File.WriteAllText(Path.Combine(rig.B, "d.txt"), "someone else"));
        Assert.Equal("changed", taken.Error!.Code);
        Assert.Equal("someone else", File.ReadAllText(Path.Combine(rig.B, "d.txt")));
        rig.Stopped = true;
        Assert.Equal("emergency_stopped", (await rig.Ask(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.B })).Error!.Code);
    }

    [Fact]
    public async Task Undo_RefusesWhenTheMovedItemChangedOrItsOldPlaceIsTaken()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        var src = rig.Put(rig.A, "u.txt", "orig");
        Assert.Equal("ok", (await rig.Run(FileOrganizeRequestService.MoveTool, new { path = src, toFolder = rig.B })).Res.Status);
        File.WriteAllText(Path.Combine(rig.B, "u.txt"), "edited after the move");
        Assert.Equal("nothing_to_undo", (await rig.Ask(FileOrganizeRequestService.UndoCopyRename, new { })).Error!.Code);
        File.WriteAllText(Path.Combine(rig.B, "u.txt"), "orig");
        File.WriteAllText(src, "a new file took the old name");
        Assert.Equal("nothing_to_undo", (await rig.Ask(FileOrganizeRequestService.UndoCopyRename, new { })).Error!.Code);
        Assert.Equal("a new file took the old name", File.ReadAllText(src));
    }

    [Fact]
    public void Policy_MoveIsElevated() =>
        Assert.False(new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance).EvaluatePolicy(DesktopActionTypes.FilesMove, new(), "D-ASK files").isAllowed);
}
