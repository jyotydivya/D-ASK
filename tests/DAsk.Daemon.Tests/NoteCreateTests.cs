using System.Diagnostics;
using System.Text;
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
/// notes.create: the daemon validates the title and exact text, derives the only path (&lt;notes folder&gt;\&lt;title&gt;.txt),
/// shows the exact note for approval, writes a NEW file (never overwriting) on a REAL temporary folder, reads it back, and
/// never reports an unverified note as created. Real policy engine (digest, owner session, liveness, Stop generation,
/// single use) and audit; the HUD decision is simulated.
/// </summary>
[Collection("AgentHost")]
public class NoteCreateTests
{
    private const string Owner = "hud-session-owner";
    private const string Text = "Remember to submit the project report by Friday";

    private sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly NoteCreateRequestService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly HashSet<string> Live = new() { Owner };
        public bool Stopped;
        public ulong Generation = 1;
        public readonly string Root = Path.Combine(Path.GetTempPath(), $"dask-notes-{Guid.NewGuid():N}");
        public readonly string Dir;
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-notes-{Guid.NewGuid():N}.db");

        public Rig(bool enabled = true, bool withAudit = true, string? dir = null, Func<string, byte[], Task>? write = null, TimeSpan? ttl = null, bool create = true)
        {
            Dir = dir ?? Path.Combine(Root, "Notes");
            Directory.CreateDirectory(Root);
            if (create && dir == null) Directory.CreateDirectory(Dir);
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => Live.Contains(s));
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Service = new NoteCreateRequestService(Policy, () => Stopped, () => Generation, withAudit ? Recorder : null,
                new NoteOptions { Enabled = enabled, NotesDir = Dir, WriteOverride = write }, ttl ?? TimeSpan.FromSeconds(10));
        }

        public string NoteFile(string title) => Path.Combine(Dir, title + ".txt");

        public Task<DesktopCallResult> Ask(object args, CancellationToken ct = default) =>
            Service.ExecuteAsync(NoteCreateRequestService.Create, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), ct);

        public async Task<ActionApprovalRequest?> DeliveredAsync(int ms = 5000)
        {
            var until = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < until) { lock (Delivered) if (Delivered.Count > 0) return Delivered[^1]; await Task.Delay(5); }
            return null;
        }

        public bool Decide(ActionApprovalRequest r, bool approved, string session = Owner) => Policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
            ActionDigest = r.ActionDigest, Approved = approved, DecisionSource = "UserExplicitConfirmation",
        }, session, () => Stopped, () => Generation);

        public async Task<(DesktopCallResult res, ActionApprovalRequest req)> Run(object args, bool approve = true, Action? beforeDecision = null)
        {
            lock (Delivered) Delivered.Clear();
            var call = Ask(args);
            var r = await DeliveredAsync() ?? throw new TimeoutException("no approval reached the HUD");
            beforeDecision?.Invoke();
            Assert.True(Decide(r, approve));
            return (await call, r);
        }

        public async Task<List<string>> Events() => (await Recorder.GetSafetyAuditRecordsAsync(200)).Select(e => e.EventType).Reverse().ToList();
        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(_db); } catch { } try { Directory.Delete(Root, true); } catch { } }
    }

    private static object Note(string title, string text) => new { title, text };
    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);

    [Fact]
    public async Task Create_Approved_WritesExactTitleAndText_AndVerifies()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var (res, req) = await rig.Run(Note("Meeting", Text));
        Assert.Equal("ok", res.Status);
        Assert.Equal("Files.CreateNote", req.ActionType);
        Assert.Equal("Elevated", req.RiskLevel);
        // The card shows exactly what will be written, where.
        Assert.Equal("Meeting", req.ActionParameters["title"]);
        Assert.Equal(rig.NoteFile("Meeting"), req.ActionParameters["file"]);
        Assert.Equal(Text, req.ActionParameters["text"]);
        Assert.Equal(Text.Length.ToString(), req.ActionParameters["textLength"]);
        var j = J(res);
        Assert.True(j.GetProperty("executed").GetBoolean());
        Assert.True(j.GetProperty("verified").GetBoolean());
        Assert.Equal(rig.NoteFile("Meeting"), j.GetProperty("file").GetString());
        // The artifact itself: exactly the text, UTF-8 without BOM, nothing added.
        Assert.Equal(Encoding.UTF8.GetBytes(Text), File.ReadAllBytes(rig.NoteFile("Meeting")));
        Assert.Single(Directory.GetFiles(rig.Dir));
        var ev = await rig.Events();
        Assert.Contains("NoteCreateRequested", ev); Assert.Contains("NoteCreateAdmitted", ev); Assert.Contains("NoteCreated", ev);
    }

    [Fact]
    public async Task Create_PreservesQuotationMarksAndPunctuation_ByteForByte()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        const string text = "She said \"yes\" — then 'maybe'; it's 50% done (really?!)\nSecond line:\tend.";
        var (res, req) = await rig.Run(Note("Q&A, v2", text));
        Assert.Equal("ok", res.Status);
        Assert.Equal(text, req.ActionParameters["text"]);
        Assert.Equal(new UTF8Encoding(false).GetBytes(text), File.ReadAllBytes(rig.NoteFile("Q&A, v2")));
    }

    [Fact]
    public async Task Create_MissingFolder_IsCreated_InsideItsExistingParentOnly()
    {
        using var rig = new Rig(create: false);
        await rig.Recorder.InitializeAsync();
        Assert.False(Directory.Exists(rig.Dir));
        var (res, _) = await rig.Run(Note("Meeting", Text));
        Assert.Equal("ok", res.Status);
        Assert.Equal(Text, File.ReadAllText(rig.NoteFile("Meeting")));
    }

    [Fact]
    public async Task Create_Denied_WritesNothing()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var (res, _) = await rig.Run(Note("Meeting", Text), approve: false);
        Assert.Equal("approval_denied", res.Error!.Code);
        Assert.Contains("Nothing was written", res.Error.Message);
        Assert.Empty(Directory.GetFiles(rig.Dir));
        Assert.Contains("NoteCreateNotApproved", await rig.Events());
    }

    [Fact]
    public async Task Create_ApprovalFromAnotherSession_IsRejected_AndExpires_WritingNothing()
    {
        using var rig = new Rig(ttl: TimeSpan.FromSeconds(2));
        await rig.Recorder.InitializeAsync();
        var call = rig.Ask(Note("Meeting", Text));
        var r = await rig.DeliveredAsync() ?? throw new TimeoutException();
        Assert.False(rig.Decide(r, true, session: "someone-else"));
        var res = await call;
        Assert.Equal("error", res.Status);
        Assert.NotEqual("ok", res.Status);
        Assert.False(File.Exists(rig.NoteFile("Meeting")));
    }

    [Fact]
    public async Task Create_NeverOverwrites_RefusedBeforeApproval()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        File.WriteAllText(rig.NoteFile("Meeting"), "old");
        var res = await rig.Ask(Note("Meeting", Text));
        Assert.Equal("target_refused", res.Error!.Code);
        Assert.Null(await rig.DeliveredAsync(300));
        Assert.Equal("old", File.ReadAllText(rig.NoteFile("Meeting")));
    }

    [Fact]
    public async Task Create_FileAppearsAfterApproval_WritesNothing_AndKeepsTheOtherFile()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var (res, _) = await rig.Run(Note("Meeting", Text), beforeDecision: () => File.WriteAllText(rig.NoteFile("Meeting"), "other"));
        Assert.Equal("changed", res.Error!.Code);
        Assert.Equal("other", File.ReadAllText(rig.NoteFile("Meeting")));
    }

    [Theory]
    [InlineData("..\\evil")]
    [InlineData("sub\\name")]
    [InlineData("a/b")]
    [InlineData("C:\\Windows\\x")]
    [InlineData("con")]
    [InlineData("Meeting.")]
    [InlineData("Meeting ")]
    [InlineData("")]
    [InlineData(".hidden")]
    [InlineData("a..b")]
    [InlineData("x:stream")]
    public async Task Create_UnsafeTitles_Refused_NoApprovalAsked(string title)
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var res = await rig.Ask(Note(title, Text));
        Assert.Equal("invalid_args", res.Error!.Code);
        Assert.Null(await rig.DeliveredAsync(200));
        Assert.Empty(Directory.GetFiles(rig.Dir));
    }

    [Fact]
    public async Task Create_InvalidTextOrArguments_Refused_NoApprovalAsked()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        Assert.Equal("invalid_args", (await rig.Ask(Note("Meeting", ""))).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(Note("Meeting", "   "))).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(Note("Meeting", "bell\u0007"))).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(Note("Meeting", "abc\u202Edef"))).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(Note("Meeting", new string('x', 2001)))).Error!.Code);
        // No path of any kind can be given.
        Assert.Equal("invalid_args", (await rig.Ask(new { title = "Meeting", text = Text, path = "C:\\Windows\\x.txt" })).Error!.Code);
        Assert.Equal("invalid_args", (await rig.Ask(new { title = "Meeting" })).Error!.Code);
        Assert.Null(await rig.DeliveredAsync(200));
        Assert.Empty(Directory.GetFiles(rig.Dir));
    }

    [Fact]
    public async Task Create_NotesFolderIsAJunction_Refused()
    {
        using var rig0 = new Rig();
        var real = Path.Combine(rig0.Root, "Real"); Directory.CreateDirectory(real);
        var link = Path.Combine(rig0.Root, "Linked");
        using (var p = Process.Start(new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{real}\"") { CreateNoWindow = true, UseShellExecute = false })!) p.WaitForExit();
        Assert.True(Directory.Exists(link));
        using var rig = new Rig(dir: link);
        await rig.Recorder.InitializeAsync();
        var res = await rig.Ask(Note("Meeting", Text));
        Assert.Equal("target_refused", res.Error!.Code);
        Assert.Null(await rig.DeliveredAsync(200));
        Assert.Empty(Directory.GetFiles(real));
        Directory.Delete(link);
    }

    [Fact]
    public async Task Create_FailedWrite_IsNotReportedAsCreated_AndLeavesNoFile()
    {
        using var rig = new Rig(write: (f, b) => throw new IOException("disk full"));
        await rig.Recorder.InitializeAsync();
        var (res, _) = await rig.Run(Note("Meeting", Text));
        Assert.Equal("not_verified", res.Error!.Code);
        Assert.Contains("not created", res.Error.Message);
        Assert.False(File.Exists(rig.NoteFile("Meeting")));
        Assert.Contains("NoteCreateFailed", await rig.Events());
    }

    [Fact]
    public async Task Create_PartialWriteThenFailure_RemovesItsOwnPartialFile()
    {
        using var rig = new Rig(write: async (f, b) => { await File.WriteAllBytesAsync(f, b[..5]); throw new IOException("device removed"); });
        await rig.Recorder.InitializeAsync();
        var (res, _) = await rig.Run(Note("Meeting", Text));
        Assert.Equal("not_verified", res.Error!.Code);
        Assert.Contains("partial file was removed", res.Error.Message);
        Assert.False(File.Exists(rig.NoteFile("Meeting")));
    }

    [Fact]
    public async Task Create_ContentDoesNotReadBackExactly_IsNotVerified_AndRemoved()
    {
        using var rig = new Rig(write: (f, b) => File.WriteAllTextAsync(f, Text.Replace("Friday", "Monday")));
        await rig.Recorder.InitializeAsync();
        var (res, _) = await rig.Run(Note("Meeting", Text));
        Assert.Equal("not_verified", res.Error!.Code);
        Assert.Contains("did not read back exactly", res.Error.Message);
        Assert.False(File.Exists(rig.NoteFile("Meeting")));
    }

    [Fact]
    public async Task EmergencyStop_BeforeApproval_NothingAsked_NothingWritten()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Stopped = true;
        var res = await rig.Ask(Note("Meeting", Text));
        Assert.Equal("emergency_stopped", res.Error!.Code);
        Assert.Null(await rig.DeliveredAsync(200));
        Assert.Empty(Directory.GetFiles(rig.Dir));
    }

    [Fact]
    public void Tools_OfferedOnlyWhenEnabled_WithAudit_AndAPlainFolder_DefaultOff()
    {
        using var on = new Rig(); Assert.Equal(new[] { "notes.create" }, on.Service.Tools);
        using var off = new Rig(enabled: false); Assert.Empty(off.Service.Tools);
        using var noAudit = new Rig(withAudit: false); Assert.Empty(noAudit.Service.Tools);
        using var unc = new Rig(dir: @"\\server\share\notes"); Assert.Empty(unc.Service.Tools);
        using var rel = new Rig(dir: "notes"); Assert.Empty(rel.Service.Tools);
        Assert.False(new DAsk.Daemon.AgentHost.AgentHostOptions().Notes);
        Assert.False(new NoteOptions().Enabled);
    }

    [Fact]
    public void Policy_ClassifiesNoteCreation_AsElevated_NeverAutoAllowed()
    {
        using var rig = new Rig();
        var (allowed, risk, _) = rig.Policy.EvaluatePolicy("Files.CreateNote", new Dictionary<string, string>(), "D-ASK notes");
        Assert.False(allowed);
        Assert.Equal(ActionRiskLevel.Elevated, risk);
    }
}
