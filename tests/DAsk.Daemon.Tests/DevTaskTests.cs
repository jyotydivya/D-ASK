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
/// dev.run_task with REAL processes: tiny npm projects in a temporary folder, run by the real Node.js/npm on this computer (offline:
/// npm runs the project's own scripts, no registry access). Real policy engine, approvals and audit journal.
/// </summary>
public class DevTaskTests
{
    private const string Owner = "hud-session-owner";

    private sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly DevTaskService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public bool Stopped;
        public readonly string Root = Path.Combine(Path.GetTempPath(), $"dask-dev-{Guid.NewGuid():N}");
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-dev-{Guid.NewGuid():N}.db");
        public Rig(TimeSpan? timeout = null, Func<string, string?>? find = null)
        {
            Directory.CreateDirectory(Root);
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => s == Owner);
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Service = new DevTaskService(Policy, () => Stopped, () => 1, Recorder, s => s == Owner,
                new DevTaskOptions { Enabled = true, Roots = new[] { Root }, Timeout = timeout ?? TimeSpan.FromMinutes(2), ApprovalTtl = TimeSpan.FromSeconds(20), FindProgram = find });
        }
        /// <summary>A project with these npm scripts and files.</summary>
        public string Project(string name, Dictionary<string, string> scripts, params (string File, string Content)[] files)
        {
            string dir = Path.Combine(Root, name);
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "package.json"), JsonSerializer.Serialize(new { name, version = "1.0.0", scripts }));
            foreach (var (f, c) in files) File.WriteAllText(Path.Combine(dir, f), c);
            return dir;
        }
        public async Task<(DesktopCallResult Res, ActionApprovalRequest? Card)> Run(object args, bool approve = true, Action? whileRunning = null)
        {
            lock (Delivered) Delivered.Clear();
            var call = Service.ExecuteAsync(DevTaskService.RunTask, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), CancellationToken.None);
            ActionApprovalRequest? card = null;
            for (int i = 0; i < 1000 && card == null && !call.IsCompleted; i++) { lock (Delivered) card = Delivered.LastOrDefault(); if (card == null) await Task.Delay(5); }
            lock (Delivered) card ??= Delivered.LastOrDefault();
            if (card != null)
            {
                Policy.SubmitApprovalDecision(new ActionApprovalResponse { ApprovalId = card.ApprovalId, ActionId = card.ActionId, ActionType = card.ActionType, ParametersSha256 = card.ParametersSha256, ActionDigest = card.ActionDigest, Approved = approve, DecisionSource = "UserExplicitConfirmation" }, Owner, () => false, () => 1);
                whileRunning?.Invoke();
            }
            return (await call, card);
        }
        public void Dispose() { SqliteConnection.ClearAllPools(); try { Directory.Delete(Root, true); } catch { } try { File.Delete(_db); } catch { } }
    }
    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);
    private static readonly Dictionary<string, string> Scripts = new() { ["test"] = "node test.js", ["build"] = "node build.js" };

    [Fact]
    public async Task FailingTests_AreRunForReal_AndTheFailureIsExplainedFromTheOutput()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        string dir = rig.Project("calc", Scripts,
            ("test.js", "console.log('ok 1 adds two numbers');console.log('not ok 2 subtracts: expected 1, got -1');console.log('# pass 1');console.log('# fail 1');process.exit(1);"),
            ("build.js", "console.log('built');"));
        var (res, card) = await rig.Run(new { folder = dir, task = "test" });
        Assert.Equal("ok", res.Status);
        Assert.Equal("Dev.RunTask", card!.ActionType); Assert.Equal("Elevated", card.RiskLevel);
        Assert.StartsWith("npm test", card.ActionParameters["command"]);
        Assert.Contains("node test.js", card.ActionParameters["command"]);
        var r = J(res);
        Assert.False(r.GetProperty("succeeded").GetBoolean());
        Assert.Equal(1, r.GetProperty("exitCode").GetInt32());
        Assert.Contains(r.GetProperty("errors").EnumerateArray(), e => e.GetString()!.Contains("not ok 2 subtracts: expected 1, got -1"));
        Assert.Contains(r.GetProperty("summary").EnumerateArray(), e => e.GetString()!.Contains("# fail 1"));
        Assert.Contains("FAILED (exit code 1)", r.GetProperty("observed").GetString());
    }

    [Fact]
    public async Task Build_Succeeds_ExitCodeZero_OutputCaptured()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        string dir = rig.Project("site", Scripts, ("build.js", "require('fs').writeFileSync('out.txt','artifact');console.log('Build succeeded');"));
        var (res, _) = await rig.Run(new { folder = dir, task = "build" });
        var r = J(res);
        Assert.True(r.GetProperty("succeeded").GetBoolean());
        Assert.Equal(0, r.GetProperty("exitCode").GetInt32());
        Assert.Contains("Build succeeded", r.GetProperty("outputTail").GetString());
        Assert.Equal("artifact", File.ReadAllText(Path.Combine(dir, "out.txt")));   // the build really ran
    }

    [Fact]
    public async Task EmergencyStop_DuringTheRun_KillsTheWholeProcessTree()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        string beat = Path.Combine(rig.Root, "heartbeat.txt");
        string dir = rig.Project("slow", Scripts, ("test.js", $"const fs=require('fs');setInterval(()=>fs.writeFileSync({JsonSerializer.Serialize(beat)}, String(Date.now())),100);setTimeout(()=>{{}},60000);"));
        var (res, _) = await rig.Run(new { folder = dir, task = "test" }, whileRunning: () => _ = Task.Run(async () =>
        {
            for (int i = 0; i < 100 && !File.Exists(beat); i++) await Task.Delay(100);   // the test is really running
            rig.Stopped = true;
        }));
        Assert.Equal("emergency_stopped", res.Error!.Code);
        string last = File.ReadAllText(beat);
        await Task.Delay(800);
        Assert.Equal(last, File.ReadAllText(beat));   // nothing is writing any more: the node process (a grandchild via npm) is dead
    }

    [Fact]
    public async Task Timeout_KillsTheRun_AndIsReportedAsNotFinished()
    {
        using var rig = new Rig(timeout: TimeSpan.FromSeconds(3)); await rig.Recorder.InitializeAsync();
        string dir = rig.Project("hang", Scripts, ("test.js", "setTimeout(()=>{},60000);"));
        var (res, _) = await rig.Run(new { folder = dir, task = "test" });
        var r = J(res);
        Assert.True(r.GetProperty("timedOut").GetBoolean());
        Assert.Equal(JsonValueKind.Null, r.GetProperty("exitCode").ValueKind);
        Assert.False(r.GetProperty("succeeded").GetBoolean());
    }

    [Fact]
    public async Task Refusals_NothingIsRun()
    {
        using var rig = new Rig(); await rig.Recorder.InitializeAsync();
        string marker = Path.Combine(rig.Root, "ran.txt");
        string dir = rig.Project("p", Scripts, ("test.js", $"require('fs').writeFileSync({JsonSerializer.Serialize(marker)},'x');"));
        string outside = Path.Combine(Path.GetTempPath(), $"dask-out-{Guid.NewGuid():N}"); Directory.CreateDirectory(outside);
        try
        {
            Assert.Equal("folder_refused", (await rig.Run(new { folder = outside, task = "test" })).Res.Error!.Code);
            Assert.Equal("invalid_args", (await rig.Run(new { folder = dir, task = "test", command = "del /s C:\\" })).Res.Error!.Code);
            Assert.Equal("invalid_args", (await rig.Run(new { folder = dir, task = "deploy" })).Res.Error!.Code);
            Directory.CreateDirectory(Path.Combine(rig.Root, "empty"));
            Assert.Equal("no_project", (await rig.Run(new { folder = Path.Combine(rig.Root, "empty"), task = "build" })).Res.Error!.Code);
            Assert.Equal("approval_denied", (await rig.Run(new { folder = dir, task = "test" }, approve: false)).Res.Error!.Code);
            rig.Stopped = true;
            Assert.Equal("emergency_stopped", (await rig.Run(new { folder = dir, task = "test" })).Res.Error!.Code);
            Assert.False(File.Exists(marker));
        }
        finally { Directory.Delete(outside, true); }
    }

    [Fact]
    public void ProjectDetection_DotnetAndCargo_UseFixedCommands()
    {
        using var rig = new Rig(find: p => @"C:\tools\" + p);
        string net = Path.Combine(rig.Root, "net"); Directory.CreateDirectory(net); File.WriteAllText(Path.Combine(net, "App.csproj"), "<Project/>");
        string rs = Path.Combine(rig.Root, "rs"); Directory.CreateDirectory(rs); File.WriteAllText(Path.Combine(rs, "Cargo.toml"), "[package]");
        var (dn, _) = rig.Service.CommandFor(net, "test");
        Assert.Equal(@"C:\tools\dotnet.exe", dn!.Program); Assert.Equal(new[] { "test", "--nologo" }, dn.Arguments);
        var (cg, _) = rig.Service.CommandFor(rs, "build");
        Assert.Equal(@"C:\tools\cargo.exe", cg!.Program); Assert.Equal(new[] { "build" }, cg.Arguments);
    }

    [Theory]
    [InlineData("Program.cs(12,5): error CS1002: ; expected", true)]
    [InlineData("error[E0425]: cannot find value `x` in this scope", true)]
    [InlineData("  Failed MyTests.Adds [3 ms]", true)]
    [InlineData("npm ERR! Test failed.", true)]
    [InlineData("Compiling foo v0.1.0", false)]
    public void ErrorLines_AreRecognised(string line, bool isError) => Assert.Equal(isError, DevTaskService.ErrorsIn(line).Count == 1);
}
