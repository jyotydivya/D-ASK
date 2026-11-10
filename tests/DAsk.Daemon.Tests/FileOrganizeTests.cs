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
/// File organisation: the daemon validates, shows the exact moves for approval, performs them on a REAL temporary folder,
/// never overwrites, keeps an undo journal, and undoes only what is unchanged. Real policy engine (digest, owner session,
/// liveness, Stop generation, single use) and audit; the HUD decision is simulated.
/// </summary>
[Collection("AgentHost")]
public class FileOrganizeTests
{
    private const string Owner = "hud-session-owner";

    private sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly FileOrganizeRequestService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly HashSet<string> Live = new() { Owner };
        public bool Stopped;
        public ulong Generation = 1;
        public readonly string Root = Path.Combine(Path.GetTempPath(), $"dask-org-{Guid.NewGuid():N}");
        public readonly string Folder;
        public readonly string Journal;
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-org-{Guid.NewGuid():N}.db");

        public Rig(bool enabled = true, bool withAudit = true, bool withRoot = true)
        {
            Folder = Path.Combine(Root, "Downloads");
            Journal = Path.Combine(Root, "journal");
            Directory.CreateDirectory(Folder);
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => Live.Contains(s));
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Service = new FileOrganizeRequestService(Policy, () => Stopped, () => Generation, withAudit ? Recorder : null,
                new FileOrganizeOptions { Enabled = enabled, Roots = withRoot ? new[] { Folder } : Array.Empty<string>(), JournalDir = Journal }, TimeSpan.FromSeconds(10));
        }

        public string Put(string name, string content = "x") { var p = Path.Combine(Folder, name); File.WriteAllText(p, content); return p; }

        public Task<DesktopCallResult> Ask(string tool, object args, CancellationToken ct = default) =>
            Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), ct);

        public async Task<ActionApprovalRequest?> DeliveredAsync(int ms = 5000)
        {
            var until = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < until) { lock (Delivered) if (Delivered.Count > 0) return Delivered[^1]; await Task.Delay(5); }
            return null;
        }

        public bool Decide(ActionApprovalRequest r, bool approved) => Policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
            ActionDigest = r.ActionDigest, Approved = approved, DecisionSource = "UserExplicitConfirmation",
        }, Owner, () => Stopped, () => Generation);

        public async Task<(DesktopCallResult res, ActionApprovalRequest req)> Run(string tool, object args, bool approve = true, Action? beforeDecision = null)
        {
            lock (Delivered) Delivered.Clear();
            var call = Ask(tool, args);
            var r = await DeliveredAsync() ?? throw new TimeoutException("no approval reached the HUD");
            beforeDecision?.Invoke();
            Assert.True(Decide(r, approve));
            return (await call, r);
        }

        public async Task<List<string>> Events() => (await Recorder.GetSafetyAuditRecordsAsync(200)).Select(e => e.EventType).Reverse().ToList();
        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(_db); } catch { } try { Directory.Delete(Root, true); } catch { } }
    }

    private static object Plan(string folder, params (string name, string into)[] moves) => new { folder, moves = moves.Select(m => new { name = m.name, into = m.into }).ToArray() };
    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);

    [Fact]
    public async Task Organize_Approved_MovesExactlyTheListedFiles_VerifiesAndJournals()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Put("report.pdf", "pdf"); rig.Put("photo.jpg", "jpg"); rig.Put("keep.txt", "txt");
        var (res, req) = await rig.Run(FileOrganizeRequestService.Organize, Plan(rig.Folder, ("report.pdf", "Documents"), ("photo.jpg", "Images")));
        Assert.Equal("ok", res.Status);
        Assert.Equal("Files.Organize", req.ActionType);
        Assert.Equal("Elevated", req.RiskLevel);
        Assert.Equal("report.pdf → Documents\\\nphoto.jpg → Images\\", req.ActionParameters["moves"]);
        Assert.Equal("2", req.ActionParameters["moveCount"]);
        Assert.Contains("Documents", req.ActionParameters["newSubfolders"]);
        var j = J(res);
        Assert.True(j.GetProperty("verified").GetBoolean());
        Assert.Equal(2, j.GetProperty("moved").GetInt32());
        Assert.True(File.Exists(Path.Combine(rig.Folder, "Documents", "report.pdf")));
        Assert.True(File.Exists(Path.Combine(rig.Folder, "Images", "photo.jpg")));
        Assert.False(File.Exists(Path.Combine(rig.Folder, "report.pdf")));
        Assert.True(File.Exists(Path.Combine(rig.Folder, "keep.txt")));   // not listed: untouched
        Assert.Single(Directory.GetFiles(rig.Journal, "*.json"));
        var ev = await rig.Events();
        Assert.Contains("FileOrganizeRequested", ev); Assert.Contains("FileOrganizeAdmitted", ev); Assert.Contains("FileOrganizePerformed", ev);
    }

    [Fact]
    public async Task Organize_Denied_MovesNothing()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Put("a.pdf");
        var (res, _) = await rig.Run(FileOrganizeRequestService.Organize, Plan(rig.Folder, ("a.pdf", "Documents")), approve: false);
        Assert.Equal("approval_denied", res.Error!.Code);
        Assert.True(File.Exists(Path.Combine(rig.Folder, "a.pdf")));
        Assert.False(Directory.Exists(Path.Combine(rig.Folder, "Documents")));
    }

    [Fact]
    public async Task Organize_NeverOverwrites_RefusedBeforeApproval()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Put("a.pdf", "new");
        Directory.CreateDirectory(Path.Combine(rig.Folder, "Documents"));
        File.WriteAllText(Path.Combine(rig.Folder, "Documents", "a.pdf"), "old");
        var res = await rig.Ask(FileOrganizeRequestService.Organize, Plan(rig.Folder, ("a.pdf", "Documents")));
        Assert.Equal("move_refused", res.Error!.Code);
        Assert.Null(await rig.DeliveredAsync(300));
        Assert.Equal("old", File.ReadAllText(Path.Combine(rig.Folder, "Documents", "a.pdf")));
        Assert.Equal("new", File.ReadAllText(Path.Combine(rig.Folder, "a.pdf")));
    }

    [Fact]
    public async Task Organize_ChangedAfterApproval_MovesNothing()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Put("a.pdf", "x");
        // A file appears at the destination while the card is shown: nothing is moved, nothing overwritten.
        var (res, _) = await rig.Run(FileOrganizeRequestService.Organize, Plan(rig.Folder, ("a.pdf", "Documents")), beforeDecision: () =>
        {
            Directory.CreateDirectory(Path.Combine(rig.Folder, "Documents"));
            File.WriteAllText(Path.Combine(rig.Folder, "Documents", "a.pdf"), "other");
        });
        Assert.Equal("changed", res.Error!.Code);
        Assert.Equal("other", File.ReadAllText(Path.Combine(rig.Folder, "Documents", "a.pdf")));
        Assert.True(File.Exists(Path.Combine(rig.Folder, "a.pdf")));
    }

    [Theory]
    [InlineData("..\\evil.txt", "Documents")]
    [InlineData("sub\\a.txt", "Documents")]
    [InlineData("a.txt", "..")]
    [InlineData("a.txt", "Docs\\Deep")]
    [InlineData("a.txt", "C:\\Windows")]
    [InlineData("con.txt", "Documents")]
    [InlineData("a.txt ", "Documents")]
    public async Task Organize_UnsafeNames_Refused(string name, string into)
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var res = await rig.Ask(FileOrganizeRequestService.Organize, Plan(rig.Folder, (name, into)));
        Assert.Equal("invalid_args", res.Error!.Code);
        Assert.Null(await rig.DeliveredAsync(200));
    }

    [Fact]
    public async Task Organize_FolderOutsideRoots_LinksAndHiddenFiles_Refused()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var outside = Path.Combine(rig.Root, "Elsewhere"); Directory.CreateDirectory(outside); File.WriteAllText(Path.Combine(outside, "a.pdf"), "x");
        Assert.Equal("folder_refused", (await rig.Ask(FileOrganizeRequestService.Organize, Plan(outside, ("a.pdf", "Documents")))).Error!.Code);
        Assert.Equal("folder_refused", (await rig.Ask(FileOrganizeRequestService.Organize, Plan(rig.Folder + "\\..\\Elsewhere", ("a.pdf", "Documents")))).Error!.Code);
        var hidden = rig.Put("secret.pdf"); File.SetAttributes(hidden, FileAttributes.Hidden);
        Assert.Equal("move_refused", (await rig.Ask(FileOrganizeRequestService.Organize, Plan(rig.Folder, ("secret.pdf", "Documents")))).Error!.Code);
        Assert.Equal("move_refused", (await rig.Ask(FileOrganizeRequestService.Organize, Plan(rig.Folder, ("missing.pdf", "Documents")))).Error!.Code);
        Assert.Null(await rig.DeliveredAsync(200));
    }

    [Fact]
    public async Task Undo_MovesBackOnlyUnchangedFiles_AndRemovesEmptyCreatedFolders()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Put("a.pdf", "A"); rig.Put("b.pdf", "B"); rig.Put("c.jpg", "C");
        var (res, _) = await rig.Run(FileOrganizeRequestService.Organize, Plan(rig.Folder, ("a.pdf", "Documents"), ("b.pdf", "Documents"), ("c.jpg", "Images")));
        Assert.True(J(res).GetProperty("verified").GetBoolean());
        // The user edits b.pdf after it was moved: undo leaves it where it is.
        File.AppendAllText(Path.Combine(rig.Folder, "Documents", "b.pdf"), " edited");
        var (undo, req) = await rig.Run(FileOrganizeRequestService.Undo, new { });
        Assert.Equal("ok", undo.Status);
        Assert.Equal("Files.UndoOrganize", req.ActionType);
        Assert.Equal("2", req.ActionParameters["moveCount"]);
        Assert.DoesNotContain("b.pdf", req.ActionParameters["moves"]);
        Assert.True(File.Exists(Path.Combine(rig.Folder, "a.pdf")));
        Assert.True(File.Exists(Path.Combine(rig.Folder, "c.jpg")));
        Assert.True(File.Exists(Path.Combine(rig.Folder, "Documents", "b.pdf")));
        Assert.False(Directory.Exists(Path.Combine(rig.Folder, "Images")));      // emptied, created by D-ASK: removed
        Assert.True(Directory.Exists(Path.Combine(rig.Folder, "Documents")));    // still holds b.pdf
    }

    [Fact]
    public async Task Undo_NothingToUndo_AskedForNoApproval()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var res = await rig.Ask(FileOrganizeRequestService.Undo, new { });
        Assert.Equal("nothing_to_undo", res.Error!.Code);
        Assert.Null(await rig.DeliveredAsync(200));
    }

    [Fact]
    public async Task EmergencyStop_BeforeApproval_NothingAsked()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Put("a.pdf"); rig.Stopped = true;
        var res = await rig.Ask(FileOrganizeRequestService.Organize, Plan(rig.Folder, ("a.pdf", "Documents")));
        Assert.Equal("emergency_stopped", res.Error!.Code);
        Assert.True(File.Exists(Path.Combine(rig.Folder, "a.pdf")));
    }

    [Fact]
    public void Tools_OfferedOnlyWhenEnabled_WithRootsAndAudit()
    {
        using var on = new Rig();
        Assert.Equal(new[] { "files.organize", "files.undo_organize" }, on.Service.Tools);
        using var off = new Rig(enabled: false); Assert.Empty(off.Service.Tools);
        using var noAudit = new Rig(withAudit: false); Assert.Empty(noAudit.Service.Tools);
        using var noRoots = new Rig(withRoot: false); Assert.Empty(noRoots.Service.Tools);
        Assert.False(new DAsk.Daemon.AgentHost.AgentHostOptions().FileOrganize);
    }

    [Fact]
    public void MovesList_TooLongToShow_IsRefused()
    {
        var moves = Enumerable.Range(0, 40).Select(i => new { name = $"a-very-long-file-name-for-display-number-{i:D2}.pdf", into = "Documents" }).ToArray();
        var err = FileOrganizeRequestService.ParseOrganize(JsonSerializer.SerializeToElement(new { folder = "C:\\x", moves }), out _, out _);
        Assert.NotNull(err);
        Assert.Contains("too long to show", err);
    }
}
