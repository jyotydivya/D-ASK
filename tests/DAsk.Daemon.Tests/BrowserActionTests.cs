using System.Diagnostics;
using System.Text.Json;
using DAsk.Daemon.Automation.Browser;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Browser stage 2: the daemon as approval authority for D-ASK's private browser. Real policy engine, digest-bound
/// approval, owner session, liveness, Stop generation, single-use consumption and audit; the HUD decision is simulated.
/// </summary>
[Collection("AgentHost")]
public class BrowserActionTests
{
    private const string Owner = "hud-session-owner";
    private static readonly string Fp = new('a', 64);

    private sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly BrowserActionRequestService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly HashSet<string> Live = new() { Owner };
        public bool Stopped;
        public ulong Generation = 1;
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-browser-{Guid.NewGuid():N}.db");

        public Rig(bool enabled = true, bool withAudit = true)
        {
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => Live.Contains(s));
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Service = new BrowserActionRequestService(Policy, () => Stopped, () => Generation, withAudit ? Recorder : null, enabled, TimeSpan.FromSeconds(10));
        }

        public Task<DesktopCallResult> Ask(object args, CancellationToken ct = default) =>
            Service.ExecuteAsync(BrowserActionRequestService.RequestAction, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), ct);

        public async Task<ActionApprovalRequest> DeliveredAsync()
        {
            var until = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < until) { lock (Delivered) if (Delivered.Count > 0) return Delivered[^1]; await Task.Delay(5); }
            throw new TimeoutException("no approval reached the HUD");
        }

        public bool Decide(ActionApprovalRequest r, bool approved) => Policy.SubmitApprovalDecision(new ActionApprovalResponse
        {
            ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
            ActionDigest = r.ActionDigest, Approved = approved, DecisionSource = "UserExplicitConfirmation",
        }, Owner, () => Stopped, () => Generation);

        public async Task<(DesktopCallResult res, ActionApprovalRequest req)> Run(object args, bool approve = true)
        {
            var call = Ask(args);
            var r = await DeliveredAsync();
            Assert.True(Decide(r, approve));
            return (await call, r);
        }

        public async Task<List<string>> Events() => (await Recorder.GetSafetyAuditRecordsAsync(200)).Select(e => e.EventType).Reverse().ToList();
        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(_db); } catch { } }
    }

    private static int Pid => Environment.ProcessId;
    private static object Click(string name = "Submit") => new { kind = "click", pageUrl = "http://127.0.0.1:8080/form", pageTitle = "Fixture form", element = new { role = "button", name, tag = "button", fingerprint = Fp }, ownerPid = Pid };
    private static object Fill(string text) => new { kind = "fill", pageUrl = "http://127.0.0.1:8080/form", pageTitle = "Fixture form", element = new { role = "textbox", name = "Email", tag = "input", fingerprint = Fp }, text, ownerPid = Pid };

    [Fact]
    public async Task Click_Approved_ShowsTheExactActionAndIsConsumedOnce()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var (res, req) = await rig.Run(Click());
        Assert.Equal("ok", res.Status);
        Assert.Equal("Browser.Click", req.ActionType);
        Assert.Equal("Elevated", req.RiskLevel);
        Assert.Equal("127.0.0.1:8080", req.ActionParameters["site"]);
        Assert.Equal("Submit", req.ActionParameters["elementName"]);
        Assert.Equal(Fp, req.ActionParameters["elementFingerprint"]);
        Assert.False(string.IsNullOrEmpty(req.ActionDigest));
        var j = JsonSerializer.SerializeToElement(res.Result);
        Assert.True(j.GetProperty("consumed").GetBoolean());
        // Single use: the same approval can never be consumed again.
        var (again, _) = rig.Policy.ValidateConsumedApproval(req.ApprovalId, req.ActionId, req.ActionType, req.ActionParameters, req.TargetProcessName, 0, Pid,
            req.TargetProcessCreationTime, Owner, rig.Generation, false);
        Assert.False(again);
        var ev = await rig.Events();
        Assert.True(ev.IndexOf("BrowserActionRequested") < ev.IndexOf("BrowserActionAdmitted"), string.Join(",", ev));
        Assert.True((await rig.Recorder.VerifyAuditChainAsync()).Ok);
    }

    [Fact]
    public async Task Fill_ShowsTheCompleteText_AuditKeepsOnlyItsHash()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var (res, req) = await rig.Run(Fill("me@example.com"));
        Assert.Equal("ok", res.Status);
        Assert.Equal("Browser.Fill", req.ActionType);
        Assert.Equal("me@example.com", req.ActionParameters["text"]);
        Assert.Equal("14", req.ActionParameters["textLength"]);
        var records = await rig.Recorder.GetSafetyAuditRecordsAsync(200);
        Assert.DoesNotContain(records, r => (r.DetailsJson ?? "").Contains("me@example.com"));
    }

    [Fact]
    public async Task Deny_NothingIsAdmitted()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var (res, _) = await rig.Run(Click(), approve: false);
        Assert.Equal("error", res.Status);
        Assert.Equal("approval_denied", res.Error!.Code);
        Assert.DoesNotContain("BrowserActionAdmitted", await rig.Events());
    }

    [Fact]
    public async Task EmergencyStopAfterApproval_InvalidatesIt()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var call = rig.Ask(Click());
        var r = await rig.DeliveredAsync();
        rig.Generation = 2; // Stop + Resume happened between the request and the decision
        rig.Decide(r, true);
        var res = await call;
        Assert.Equal("error", res.Status);
        Assert.DoesNotContain("BrowserActionAdmitted", await rig.Events());
    }

    [Fact]
    public async Task StoppedOrDisabledOrNoAudit_NothingIsOffered()
    {
        using (var rig = new Rig(enabled: false)) Assert.Empty(rig.Service.Tools);
        using (var rig = new Rig(withAudit: false)) Assert.Empty(rig.Service.Tools);
        using (var rig = new Rig())
        {
            rig.Stopped = true;
            var res = await rig.Ask(Click());
            Assert.True(res.Error!.Code == "emergency_stopped", res.Error.Message);
            Assert.Empty(rig.Delivered);
        }
    }

    [Fact]
    public async Task HudNotLive_IsRefused()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Live.Clear();
        var res = await rig.Ask(Click());
        Assert.Equal("hud_unavailable", res.Error!.Code);
    }

    public static IEnumerable<object[]> Invalid() => new[]
    {
        new object[] { new { kind = "submit", pageUrl = "http://a.com/", pageTitle = "", element = new { role = "button", name = "x", tag = "button", fingerprint = Fp }, ownerPid = 1 } },
        new object[] { new { kind = "click", pageUrl = "file:///C:/x", pageTitle = "", element = new { role = "button", name = "x", tag = "button", fingerprint = Fp }, ownerPid = 1 } },
        new object[] { new { kind = "click", pageUrl = "https://u:p@a.com/", pageTitle = "", element = new { role = "button", name = "x", tag = "button", fingerprint = Fp }, ownerPid = 1 } },
        new object[] { new { kind = "click", pageUrl = "https://a.com/", pageTitle = "", element = new { role = "img", name = "x", tag = "img", fingerprint = Fp }, ownerPid = 1 } },
        new object[] { new { kind = "click", pageUrl = "https://a.com/", pageTitle = "", element = new { role = "button", name = "x", tag = "button", fingerprint = "abc" }, ownerPid = 1 } },
        new object[] { new { kind = "fill", pageUrl = "https://a.com/", pageTitle = "", element = new { role = "button", name = "x", tag = "button", fingerprint = Fp }, text = "t", ownerPid = 1 } },
        new object[] { new { kind = "fill", pageUrl = "https://a.com/", pageTitle = "", element = new { role = "textbox", name = "x", tag = "input", fingerprint = Fp }, text = new string('x', 501), ownerPid = 1 } },
        new object[] { new { kind = "click", pageUrl = "https://a.com/", pageTitle = "", element = new { role = "button", name = "x", tag = "button", fingerprint = Fp }, text = "t", ownerPid = 1 } },
        new object[] { new { kind = "click", pageUrl = "https://a.com/", pageTitle = "", element = new { role = "button", name = "x", tag = "button", fingerprint = Fp }, ownerPid = 1, cookie = "x" } },
        new object[] { new { kind = "click", pageUrl = "https://a.com/", pageTitle = "", element = new { role = "button", name = "x", tag = "button", fingerprint = Fp, selector = "#x" }, ownerPid = 1 } },
    };

    [Theory]
    [MemberData(nameof(Invalid))]
    public async Task InvalidArguments_AreRefusedBeforeAnyApproval(object args)
    {
        using var rig = new Rig();
        var res = await rig.Ask(args);
        Assert.Equal("invalid_args", res.Error!.Code);
        Assert.Empty(rig.Delivered);
    }

    [Fact]
    public async Task SecretLookingText_IsNeverShownForApproval()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        // A bidirectional override in the text would make the card read differently from what is typed: refused.
        var res = await rig.Ask(Fill("abc\u202Edef"));
        Assert.Equal("error", res.Status);
        Assert.Empty(rig.Delivered);
    }

    [Fact]
    public void Policy_ClassifiesBrowserActionsAsElevated_NeverAutoAllowed()
    {
        var p = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance);
        foreach (var t in new[] { "Browser.Click", "Browser.Fill" })
        {
            var (allowed, risk, _) = p.EvaluatePolicy(t, new Dictionary<string, string>(), "D-ASK browser");
            Assert.False(allowed);
            Assert.Equal(ActionRiskLevel.Elevated, risk);
        }
    }
}
