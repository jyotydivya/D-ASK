using System.Text;
using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Dev;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// dev.edit_file with REAL files (2026-11-14): an exact approved replacement, the diff on the card, preserved CRLF + BOM, backup, refusal
/// of ambiguous / missing / out-of-root edits and of a file changed after approval, and the edit verified by RUNNING the project's real
/// tests through the existing DevTaskService (real Node.js, Job-Object containment). The test plays the HUD.
/// </summary>
public class DevEditTests
{
    private const string Owner = "hud-owner";
    private static readonly DesktopActionContext Ctx = new("t1", "c1", Owner);

    private sealed class Rig : IDisposable
    {
        public readonly string Root = Path.Combine(Path.GetTempPath(), $"dask-edit-{Guid.NewGuid():N}");
        public readonly string Backups;
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-edit-{Guid.NewGuid():N}.db");
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly ActionPolicyEngine Policy;
        public readonly DevEditService Edit;
        public readonly DevTaskService Tasks;
        public readonly List<ActionApprovalRequest> Cards = new();
        public Func<ActionApprovalRequest, bool> Decide = _ => true;
        public Action? BeforeDecision;
        public Rig()
        {
            Directory.CreateDirectory(Path.Combine(Root, "proj"));
            Backups = Path.Combine(Root, "_backups");
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Recorder.InitializeAsync().GetAwaiter().GetResult();
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => s == Owner);
            Policy.ApprovalRequested += (_, r) => Task.Run(async () =>
            {
                lock (Cards) Cards.Add(r);
                await Task.Delay(30);
                BeforeDecision?.Invoke();
                Policy.SubmitApprovalDecision(new ActionApprovalResponse { ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                    ActionDigest = r.ActionDigest, Approved = Decide(r), DecisionSource = "UserExplicitConfirmation" }, Owner, () => false, () => 1);
            });
            var gate = new ApprovalGate(Policy, () => false, () => 1, Recorder, s => s == Owner, "DevEdit");
            Edit = new DevEditService(gate, new DevEditOptions { Roots = new[] { Path.Combine(Root, "proj") }, BackupDir = Backups });
            Tasks = new DevTaskService(Policy, () => false, () => 1, Recorder, s => s == Owner, new DevTaskOptions { Enabled = true, Roots = new[] { Root }, Timeout = TimeSpan.FromMinutes(2) });
        }
        public Task<DesktopCallResult> Do(object args) => Edit.ExecuteAsync(DevEditService.EditFile, JsonSerializer.SerializeToElement(args), Ctx, CancellationToken.None);
        public void Dispose() { SqliteConnection.ClearAllPools(); try { Directory.Delete(Root, true); } catch { } try { File.Delete(_db); } catch { } }
    }

    [Fact]
    public async Task ExactApprovedEdit_PreservesEverythingElse_ThenTheRealTestsPass()
    {
        using var rig = new Rig();
        string proj = Path.Combine(rig.Root, "proj");
        Directory.CreateDirectory(proj);
        File.WriteAllText(Path.Combine(proj, "package.json"), JsonSerializer.Serialize(new { name = "calc", version = "1.0.0", scripts = new { test = "node test.js" } }));
        // A CRLF, BOM-prefixed source file with a bug (subtract adds).
        string src = "// calculator\r\nfunction add(a, b) { return a + b; }\r\nfunction subtract(a, b) { return a + b; }\r\nmodule.exports = { add, subtract };\r\n";
        string calc = Path.Combine(proj, "calc.js");
        File.WriteAllBytes(calc, new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Encoding.UTF8.GetBytes(src)).ToArray());
        File.WriteAllText(Path.Combine(proj, "test.js"), "const c = require('./calc');\nif (c.add(2,1) !== 3) { console.log('not ok 1 add'); process.exit(1); }\nif (c.subtract(2,1) !== 1) { console.log('not ok 2 subtract: expected 1, got ' + c.subtract(2,1)); process.exit(1); }\nconsole.log('# pass 2');\n");

        // Before: the real tests fail.
        var before = await rig.Tasks.ExecuteAsync(DevTaskService.RunTask, JsonSerializer.SerializeToElement(new { folder = proj, task = "test" }), Ctx, CancellationToken.None);
        Assert.False(JsonSerializer.SerializeToElement(before.Result).GetProperty("succeeded").GetBoolean());

        var r = await rig.Do(new { file = calc, find = "function subtract(a, b) { return a + b; }", replace = "function subtract(a, b) { return a - b; }" });
        Assert.True(r.Status == "ok", r.Error?.Code + ": " + r.Error?.Message);
        var card = rig.Cards.Single(c => c.ActionType == DesktopActionTypes.DevEditFile);
        Assert.Contains("- function subtract(a, b) { return a + b; }", card.ActionParameters["diff"]);
        Assert.Contains("+ function subtract(a, b) { return a - b; }", card.ActionParameters["diff"]);
        byte[] now = File.ReadAllBytes(calc);
        Assert.True(now[0] == 0xEF && now[1] == 0xBB && now[2] == 0xBF, "the BOM is kept");
        Assert.Equal(src.Replace("return a + b; }\r\nmodule", "return a - b; }\r\nmodule"), Encoding.UTF8.GetString(now, 3, now.Length - 3));   // CRLF kept, nothing else changed
        Assert.True(File.Exists(JsonSerializer.SerializeToElement(r.Result).GetProperty("backup").GetString()));

        // After: the real tests pass (DevTaskService: its own approval, Job-Object containment).
        var after = await rig.Tasks.ExecuteAsync(DevTaskService.RunTask, JsonSerializer.SerializeToElement(new { folder = proj, task = "test" }), Ctx, CancellationToken.None);
        Assert.True(JsonSerializer.SerializeToElement(after.Result).GetProperty("succeeded").GetBoolean());

        // Refusals: ambiguous, missing, outside the allowed folders; nothing is written.
        string sha = DevEditService.Sha(File.ReadAllBytes(calc));
        Assert.Equal("ambiguous_target", (await rig.Do(new { file = calc, find = "function", replace = "fn" })).Error?.Code);
        Assert.Equal("text_not_found", (await rig.Do(new { file = calc, find = "multiply", replace = "x" })).Error?.Code);
        Assert.Equal("folder_refused", (await rig.Do(new { file = Path.Combine(rig.Root, "other.js"), find = "a", replace = "b" })).Error?.Code);
        // Declined: nothing written.
        rig.Decide = _ => false;
        Assert.Equal("approval_denied", (await rig.Do(new { file = calc, find = "// calculator", replace = "// CALC" })).Error?.Code);
        Assert.Equal(sha, DevEditService.Sha(File.ReadAllBytes(calc)));
        // The file changes after approval (someone else edits it): nothing is written by D-ASK.
        rig.Decide = _ => true;
        rig.BeforeDecision = () => File.AppendAllText(calc, "// edited elsewhere\r\n");
        Assert.Equal("target_changed", (await rig.Do(new { file = calc, find = "// calculator", replace = "// CALC" })).Error?.Code);
        Assert.Contains("// calculator", File.ReadAllText(calc));
        Assert.True((await rig.Recorder.VerifyAuditChainAsync()).Ok);
    }
}
