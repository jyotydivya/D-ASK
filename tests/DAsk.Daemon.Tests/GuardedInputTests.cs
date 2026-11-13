using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Input;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DAsk.Daemon.Tests.Phase7B1bTests;

namespace DAsk.Daemon.Tests;

/// <summary>
/// P1 (mouse) + P2 (keyboard/text) guarded input. The pathway is the real one (policy engine, digest-bound approval,
/// single-use consumption, window + control revalidation, write-ahead audit, per-event gate, release, verification);
/// the OS is a recording fake. No real input is sent by these tests.
/// </summary>
[Collection("AgentHost")]
public class GuardedInputTests
{
    private const string Owner = "hud-session-owner";
    private const long Hwnd = 100;
    private static readonly int[] ButtonId = { 42, 3 }, EditId = { 42, 4 }, PasswordId = { 42, 2 }, LabelId = { 42, 5 };

    private static UiaNode Node(int[] id, int parent, string type, string aid, string name, int[] b, bool password = false, string[]? patterns = null) =>
        new(id, parent < 0 ? 0 : 1, parent, type, aid, name, type, b, true, false, password, type != "Text", patterns ?? Array.Empty<string>());

    private static UiaInspection Tree(string label = "Clicks: 0", bool twoButtons = false)
    {
        var nodes = new List<UiaNode>
        {
            Node(new[] { 42, 1 }, -1, "Window", "", "Fixture", new[] { 100, 100, 500, 400 }, patterns: new[] { "Window" }),
            Node(PasswordId, 0, "Edit", "pw", "Password", new[] { 110, 110, 300, 130 }, password: true, patterns: new[] { "Value" }),
            Node(ButtonId, 0, "Button", "go", "Go", new[] { 110, 150, 210, 180 }, patterns: new[] { "Invoke" }),
            Node(EditId, 0, "Edit", "notes", "Notes", new[] { 110, 200, 400, 230 }, patterns: new[] { "Value" }),
            Node(LabelId, 0, "Text", "label", label, new[] { 110, 250, 400, 270 }),
        };
        if (twoButtons) nodes.Add(Node(new[] { 42, 9 }, 0, "Button", "", "Go", new[] { 220, 150, 320, 180 }, patterns: new[] { "Invoke" }));
        return new UiaInspection("ok", nodes, false, DateTimeOffset.UtcNow, null);
    }

    private sealed class FakeMonitor : IUserInputMonitor { public string? Interruption { get; set; } public bool Disposed; public void Dispose() => Disposed = true; }

    private sealed class FakePlatform : IDesktopInputPlatform, IInputInjector
    {
        public readonly List<InputEvent> Sent = new();
        public int AcceptLimit = int.MaxValue;            // accept at most this many events of the NEXT batch
        public long Foreground = 999;                     // another window is in front initially
        public bool GrantForeground = true, GrantFocus = true, MonitorFails;
        public long RootAt = Hwnd;
        public int[]? ElementAt = ButtonId;
        public int[]? Focused;
        public (int X, int Y) Cursor = (0, 0);
        public readonly Dictionary<string, string> Values = new() { ["42,4"] = "ab" };
        public FakeMonitor Monitor = new();
        public Action<InputEvent>? Effect;

        public IInputInjector Injector => this;
        public IUserInputMonitor StartMonitor() { if (MonitorFails) throw new InvalidOperationException("hook refused"); return Monitor; }
        public long ForegroundRoot() => Foreground;
        public bool BringToForeground(long hwnd) { if (GrantForeground) Foreground = hwnd; return GrantForeground; }
        public (int X, int Y)? CursorPos() => Cursor;
        public long RootWindowAt(int x, int y) => RootAt;
        public int[]? RuntimeIdAt(int x, int y) => ElementAt;
        public int[]? FocusedRuntimeId() => Focused;
        public bool FocusElement(long hwnd, int[] runtimeId) { if (GrantFocus) Focused = runtimeId; return GrantFocus; }
        public (bool Ok, string Value, bool ReadOnly) ReadValue(long hwnd, int[] runtimeId) =>
            Values.TryGetValue(string.Join(",", runtimeId), out var v) ? (true, v, false) : (false, "", true);

        public int Send(IReadOnlyList<InputEvent> events)
        {
            int n = Math.Min(events.Count, AcceptLimit);
            AcceptLimit = int.MaxValue;
            for (int i = 0; i < n; i++)
            {
                var e = events[i];
                lock (Sent) Sent.Add(e);
                if (e is MouseMoveTo m) Cursor = (m.X, m.Y);
                if (e is UnicodeChar { Down: true } c && Focused != null) { var k = string.Join(",", Focused); Values[k] = (Values.GetValueOrDefault(k) ?? "") + c.Unit; }
                Effect?.Invoke(e);
            }
            return n;
        }
    }

    private sealed class Rig : IDisposable
    {
        public readonly FakeWindows Windows = new();
        public readonly FakeUia Uia = new() { Result = Tree() };
        public readonly FakePlatform Os = new();
        public readonly ActionPolicyEngine Policy;
        public readonly GuardedInputRequestService Service;
        public readonly HashSet<string> Live = new() { Owner };
        public bool Stopped;
        public ulong Generation = 1;
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly string Db = Path.Combine(Path.GetTempPath(), $"dask-input-{Guid.NewGuid():N}.db");
        public Func<Task>? BeforeFirst;
        public Func<int, Task>? Between;

        public Rig(bool mouse = true, bool keyboard = true)
        {
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, Db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder, Windows);   // Phase 4B-2A: the OS view used to re-verify a window-bound approval
            Policy.SetSessionLivenessGate(s => Live.Contains(s));
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Windows.Windows.Add(W(Hwnd, 4000, "fixture.exe", "DASK Input Fixture"));
            // A click changes the label, as the fixture's button does.
            Os.Effect = e => { if (e is MouseLeft { Down: false }) Uia.Result = Tree("Clicks: 1"); };
            Service = new GuardedInputRequestService(new DesktopReadService(Windows, Uia), Uia, Policy, () => Stopped, () => Generation, Recorder,
                s => Live.Contains(s), Os,
                new GuardedInputOptions { MouseEnabled = mouse, KeyboardEnabled = keyboard, VerifyTimeoutMs = 300, InterEventDelayMs = 0,
                    TestHookBeforeFirstEvent = () => BeforeFirst?.Invoke() ?? Task.CompletedTask, TestHookBetweenEvents = i => Between?.Invoke(i) ?? Task.CompletedTask });
        }

        public Task<DesktopCallResult> Ask(string tool, object args, CancellationToken ct = default) =>
            Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), ct);

        public async Task<ActionApprovalRequest> DeliveredAsync(int n = 1)
        {
            var until = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < until) { lock (Delivered) if (Delivered.Count >= n) return Delivered[n - 1]; await Task.Delay(5); }
            throw new TimeoutException("no approval reached the HUD");
        }

        public bool Decide(ActionApprovalRequest r, bool approved) =>
            Policy.SubmitApprovalDecision(new ActionApprovalResponse
            {
                ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                ActionDigest = r.ActionDigest, Approved = approved, DecisionSource = "UserExplicitConfirmation",
            }, Owner, () => Stopped, () => Generation);

        public async Task<DesktopCallResult> Run(string tool, object args, bool approve = true)
        {
            int n; lock (Delivered) n = Delivered.Count + 1;
            var call = Ask(tool, args);
            var r = await DeliveredAsync(n);
            Assert.True(Decide(r, approve));
            return await call;
        }

        /// <summary>Chronological (the recorder returns newest first).</summary>
        public async Task<List<string>> Events() => (await Recorder.GetSafetyAuditRecordsAsync(500)).Select(e => e.EventType).Reverse().ToList();
        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(Db); } catch { } }
    }

    private static readonly object ClickGo = new { process = "fixture.exe", element = new { controlType = "Button", automationId = "go" } };
    private static object TypeInto(string text, string aid = "notes") => new { process = "fixture.exe", element = new { controlType = "Edit", automationId = aid }, text };
    private static object Keys(string keys) => new { process = "fixture.exe", element = new { controlType = "Edit", automationId = "notes" }, keys };
    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);

    // ── P1 mouse ──

    [Fact]
    public async Task Click_Approved_SendsOneClickAtTheControlCentre_AndIsVerified()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var res = await rig.Run(GuardedInputTools.ClickElement, ClickGo);
        Assert.Equal("ok", res.Status);
        Assert.True(J(res).GetProperty("verified").GetBoolean());
        Assert.Equal(new InputEvent[] { new MouseMoveTo(160, 165), new MouseLeft(true), new MouseLeft(false) }, rig.Os.Sent);
        var ev = await rig.Events();
        Assert.True(ev.IndexOf("DesktopInputExecutionAdmitted") >= 0 && ev.IndexOf("DesktopInputExecutionAdmitted") < ev.IndexOf("DesktopInputSent"), string.Join(",", ev));
        Assert.Contains("DesktopInputVerified", ev);
        Assert.True(rig.Os.Monitor.Disposed, "the D-4 monitor is removed after the action");
        Assert.True((await rig.Recorder.VerifyAuditChainAsync()).Ok);
    }

    [Fact]
    public async Task Click_ApprovalShowsTheControlAndPoint_BoundIntoTheDigest()
    {
        using var rig = new Rig();
        var call = rig.Ask(GuardedInputTools.ClickElement, ClickGo);
        var r = await rig.DeliveredAsync();
        Assert.Equal(DesktopActionTypes.ClickElement, r.ActionType);
        Assert.Equal("mouse", r.ActionParameters["inputPolicy"]);
        Assert.Equal("160,165", r.ActionParameters["point"]);
        Assert.Equal("Button #go \"\"".Replace(" \"\"", ""), r.ActionParameters["control"]);
        Assert.False(string.IsNullOrEmpty(r.ActionDigest));
        rig.Decide(r, false);
        Assert.Equal("approval_denied", (await call).Error!.Code);
        Assert.Empty(rig.Os.Sent);
    }

    [Fact]
    public async Task Click_Unverified_WhenNothingChanges_IsNotSuccess_AndNotRetried()
    {
        using var rig = new Rig();
        rig.Os.Effect = null; // the click has no visible effect
        var res = await rig.Run(GuardedInputTools.ClickElement, ClickGo);
        Assert.Equal("execution_unverified", res.Error!.Code);
        Assert.Equal(3, rig.Os.Sent.Count); // one move, one down+up; nothing repeated
    }

    [Fact]
    public async Task Click_ElementUnderPointerIsNotTheControl_NoButtonEvent()
    {
        using var rig = new Rig();
        rig.Os.ElementAt = LabelId;
        var res = await rig.Run(GuardedInputTools.ClickElement, ClickGo);
        Assert.Equal("target_obscured", res.Error!.Code);
        Assert.DoesNotContain(rig.Os.Sent, e => e is MouseLeft);
    }

    [Fact]
    public async Task Click_CoveredByAnotherWindow_NoButtonEvent()
    {
        // The occlusion check runs immediately before the button event (after the harmless pointer move).
        using var rig = new Rig();
        rig.Os.RootAt = 555;
        var res = await rig.Run(GuardedInputTools.ClickElement, ClickGo);
        Assert.Equal("target_obscured", res.Error!.Code);
        Assert.DoesNotContain(rig.Os.Sent, e => e is MouseLeft);
        Assert.True(rig.Os.Sent.Count <= 1, "at most the pointer move was sent");
    }

    [Fact]
    public async Task ForegroundNotGranted_NoInput()
    {
        using var rig = new Rig();
        rig.Os.GrantForeground = false;
        var res = await rig.Run(GuardedInputTools.ClickElement, ClickGo);
        Assert.Equal("foreground_denied", res.Error!.Code);
        Assert.Empty(rig.Os.Sent);
    }

    // ── P2 keyboard / text ──

    [Fact]
    public async Task Type_Approved_TypesEachCharacterOnce_VerifiedByExactInsertion_TextNeverInTheAudit()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        const string text = "Héllo 42";
        var res = await rig.Run(GuardedInputTools.TypeText, TypeInto(text));
        Assert.Equal("ok", res.Status);
        Assert.Equal("ab" + text, rig.Os.Values["42,4"]);
        Assert.Equal(text.Length * 2, rig.Os.Sent.Count);
        Assert.All(rig.Os.Sent, e => Assert.IsType<UnicodeChar>(e));
        var records = await rig.Recorder.GetSafetyAuditRecordsAsync(500);
        Assert.DoesNotContain(records, x => (x.DetailsJson ?? "").Contains(text) || (x.Reason ?? "").Contains(text));
        Assert.Contains(records, x => (x.DetailsJson ?? "").Contains(TextRules.Sha256(text)));
    }

    [Fact]
    public async Task Type_UserTouchesTheKeyboard_StopsBeforeTheNextCharacter_NoRetry()
    {
        using var rig = new Rig();
        rig.Between = i => { if (i == 2) rig.Os.Monitor.Interruption = "you pressed a key"; return Task.CompletedTask; };
        var res = await rig.Run(GuardedInputTools.TypeText, TypeInto("abcdef"));
        Assert.Equal("user_interrupted", res.Error!.Code);
        Assert.Equal(4, rig.Os.Sent.Count); // exactly two characters (down+up each), then nothing
        Assert.Contains("2 of 6", res.Error.Message);
    }

    [Fact]
    public async Task Type_FocusLeavesTheControl_Stops()
    {
        using var rig = new Rig();
        rig.Between = i => { if (i == 1) rig.Os.Focused = LabelId; return Task.CompletedTask; };
        var res = await rig.Run(GuardedInputTools.TypeText, TypeInto("abc"));
        Assert.Equal("focus_changed", res.Error!.Code);
        Assert.Equal(2, rig.Os.Sent.Count);
    }

    [Fact]
    public async Task Type_IntoPasswordField_IsRefusedBeforeAnyApproval()
    {
        using var rig = new Rig();
        var res = await rig.Ask(GuardedInputTools.TypeText, TypeInto("secret", "pw"));
        Assert.Equal("target_forbidden", res.Error!.Code);
        Assert.Empty(rig.Delivered);
        Assert.Empty(rig.Os.Sent);
    }

    [Fact]
    public async Task Keys_Chord_IsOneAtomicBatch_ModifiersReleased()
    {
        using var rig = new Rig();
        rig.Os.Effect = e => { if (e is VirtualKey { Down: false, Vk: 0x41 }) rig.Uia.Result = Tree("selected"); };
        var res = await rig.Run(GuardedInputTools.PressKeys, Keys("ctrl+a"));
        Assert.Equal("ok", res.Status);
        Assert.Equal(new InputEvent[] { new VirtualKey(0x11, true), new VirtualKey(0x41, true), new VirtualKey(0x41, false), new VirtualKey(0x11, false) }, rig.Os.Sent);
    }

    [Fact]
    public async Task Keys_Backspace_IsVerifiedByTheValueChange()
    {
        using var rig = new Rig();
        rig.Os.Effect = e => { if (e is VirtualKey { Down: true, Vk: 0x08 }) rig.Os.Values["42,4"] = "a"; };
        var res = await rig.Run(GuardedInputTools.PressKeys, Keys("Backspace"));
        Assert.Equal("ok", res.Status);
        Assert.Contains("text changed", J(res).GetProperty("observed").GetString());
    }

    [Fact]
    public async Task Keys_WithNoObservableEffect_AreUnverified_NotSuccess()
    {
        using var rig = new Rig();
        rig.Os.Effect = null;
        var res = await rig.Run(GuardedInputTools.PressKeys, Keys("Ctrl+A"));
        Assert.Equal("execution_unverified", res.Error!.Code);
        Assert.Equal(4, rig.Os.Sent.Count);
    }

    [Fact]
    public async Task Keys_PartiallyAcceptedBatch_ReleasesEverythingHeld()
    {
        using var rig = new Rig();
        rig.BeforeFirst = () => { rig.Os.AcceptLimit = 2; return Task.CompletedTask; }; // Ctrl down + A down accepted, then blocked
        var res = await rig.Run(GuardedInputTools.PressKeys, Keys("Ctrl+A"));
        Assert.Equal("input_blocked", res.Error!.Code);
        Assert.Contains(new VirtualKey(0x41, false), rig.Os.Sent);
        Assert.Contains(new VirtualKey(0x11, false), rig.Os.Sent);
    }

    [Theory]
    [InlineData("Alt+F4")]
    [InlineData("Win+R")]
    [InlineData("Ctrl+Alt+Delete")]
    [InlineData("Ctrl+W")]
    [InlineData("Ctrl+Shift+Escape")]
    [InlineData("Ctrl+Ctrl+A")]
    public void Keys_OutsideTheAllowlist_AreRejected(string chord) => Assert.NotNull(KeyChords.Parse(chord, out _));

    [Fact]
    public void Text_AndInsertionRules()
    {
        Assert.NotNull(TextRules.Validate("line1\nline2", 200));
        Assert.NotNull(TextRules.Validate("tab\there", 200));
        Assert.NotNull(TextRules.Validate(new string('x', 201), 200));
        Assert.NotNull(TextRules.Validate("\uD800", 200));
        Assert.Null(TextRules.Validate("ok 😀", 200));
        Assert.True(TextRules.IsExactInsertion("ab", "aXYb", "XY"));
        Assert.False(TextRules.IsExactInsertion("ab", "aXY", "XY"));
        Assert.False(TextRules.IsExactInsertion("ab", "abXYXY", "XY"));
    }

    // ── shared safety ──

    [Fact]
    public async Task SeparatePolicies_MouseOffRefusesClicks_KeyboardOffRefusesTyping()
    {
        using (var rig = new Rig(mouse: false, keyboard: true))
        {
            Assert.Equal("input_disabled", (await rig.Ask(GuardedInputTools.ClickElement, ClickGo)).Error!.Code);
            Assert.Empty(rig.Delivered);
        }
        using (var rig = new Rig(mouse: true, keyboard: false))
        {
            Assert.Equal("input_disabled", (await rig.Ask(GuardedInputTools.TypeText, TypeInto("x"))).Error!.Code);
            Assert.Equal("input_disabled", (await rig.Ask(GuardedInputTools.PressKeys, Keys("Enter"))).Error!.Code);
            Assert.Empty(rig.Delivered);
        }
    }

    [Theory]
    [InlineData("x")]
    [InlineData("hwnd")]
    [InlineData("approved")]
    [InlineData("vk")]
    public async Task AgentCannotSupplyCoordinatesHandlesKeyCodesOrApprovals(string field)
    {
        using var rig = new Rig();
        var args = new Dictionary<string, object> { ["process"] = "fixture.exe", ["element"] = new { controlType = "Button", automationId = "go" }, [field] = 1 };
        Assert.Equal("invalid_args", (await rig.Ask(GuardedInputTools.ClickElement, args)).Error!.Code);
        Assert.Empty(rig.Delivered);
    }

    [Fact]
    public async Task AmbiguousControl_IsRefused()
    {
        using var rig = new Rig();
        rig.Uia.Result = Tree(twoButtons: true);
        var res = await rig.Ask(GuardedInputTools.ClickElement, new { process = "fixture.exe", element = new { controlType = "Button", name = "Go" } });
        Assert.Equal("ambiguous_target", res.Error!.Code);
        Assert.Empty(rig.Delivered);
    }

    [Fact]
    public void Resolver_AcceptsTypeAliasesAndOneIdentifierEitherWay_ButStaysExactAndUnique()
    {
        // "TextBox" is the Edit; a lone identifier may be the automation id or the name, exactly.
        Assert.Null(ControlResolver.Resolve(Tree(), new ControlSelector("TextBox", null, "notes"), out var c1));
        Assert.Equal(EditId, c1!.RuntimeId);
        Assert.Null(ControlResolver.Resolve(Tree(), new ControlSelector("Button", "Go", null), out var c2));
        Assert.Equal(ButtonId, c2!.RuntimeId);
        Assert.NotNull(ControlResolver.Resolve(Tree(), new ControlSelector("Edit", null, "note"), out _));      // no prefix matching
        Assert.NotNull(ControlResolver.Resolve(Tree(), new ControlSelector("Button", "go", "Stop"), out _));    // both given: both must match
        // A value that is one control's name and ANOTHER control's automation id is ambiguous, never a guess.
        var nodes = Tree().Nodes.ToList();
        nodes.Add(Node(new[] { 42, 7 }, 0, "Button", "x", "go", new[] { 330, 150, 400, 180 }, patterns: new[] { "Invoke" }));
        Assert.Equal("ambiguous_target", ControlResolver.Resolve(new UiaInspection("ok", nodes, false, DateTimeOffset.UtcNow, null), new ControlSelector("Button", null, "go"), out _)!.Code);
    }

    [Fact]
    public void InputFlags_DefaultOff_InCodeAndInAppsettings()
    {
        var o = new DAsk.Daemon.AgentHost.AgentHostOptions();
        Assert.False(o.DesktopMouseInput);
        Assert.False(o.DesktopKeyboardInput);
        Assert.False(new GuardedInputOptions().MouseEnabled);
        Assert.False(new GuardedInputOptions().KeyboardEnabled);
        string settings = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "DAsk.Daemon", "appsettings.json")));
        using var doc = JsonDocument.Parse(settings);
        var host = doc.RootElement.GetProperty("AgentHost");
        foreach (var k in new[] { "DesktopMouseInput", "DesktopKeyboardInput" })
            Assert.True(!host.TryGetProperty(k, out var v) || v.ValueKind == JsonValueKind.False, $"{k} must not be enabled in appsettings.json");
    }

    [Fact]
    public async Task IncompleteInspection_CannotProveUniqueness_IsRefused()
    {
        using var rig = new Rig();
        rig.Uia.Result = Tree() with { Status = "partial" };
        Assert.Equal("target_uncertain", (await rig.Ask(GuardedInputTools.ClickElement, ClickGo)).Error!.Code);
    }

    [Fact]
    public async Task EmergencyStopAfterApproval_NoInput()
    {
        using var rig = new Rig();
        rig.BeforeFirst = () => { rig.Stopped = true; return Task.CompletedTask; };
        var res = await rig.Run(GuardedInputTools.ClickElement, ClickGo);
        Assert.Equal("emergency_stopped", res.Error!.Code);
        Assert.Empty(rig.Os.Sent);
    }

    [Fact]
    public async Task HudLeaseLostAfterApproval_NoInput()
    {
        using var rig = new Rig();
        rig.BeforeFirst = () => { rig.Live.Clear(); return Task.CompletedTask; };
        var res = await rig.Run(GuardedInputTools.TypeText, TypeInto("abc"));
        Assert.Equal("hud_unavailable", res.Error!.Code);
        Assert.Empty(rig.Os.Sent);
    }

    [Fact]
    public async Task WindowTitleChangedAfterApproval_NoInput()
    {
        using var rig = new Rig();
        var call = rig.Ask(GuardedInputTools.ClickElement, ClickGo);
        var r = await rig.DeliveredAsync();
        rig.Windows.Now[Hwnd] = rig.Windows.Windows[0] with { Title = "Something else" };
        rig.Decide(r, true);
        Assert.Equal("target_changed", (await call).Error!.Code);
        Assert.Empty(rig.Os.Sent);
    }

    [Fact]
    public async Task ControlMovedAfterApproval_NoInput()
    {
        using var rig = new Rig();
        var call = rig.Ask(GuardedInputTools.ClickElement, ClickGo);
        var r = await rig.DeliveredAsync();
        var moved = Tree().Nodes.Select(n => n.RuntimeId!.SequenceEqual(ButtonId) ? n with { Bounds = new[] { 130, 150, 230, 180 } } : n).ToList();
        rig.Uia.Result = new UiaInspection("ok", moved, false, DateTimeOffset.UtcNow, null);
        rig.Decide(r, true);
        Assert.Equal("target_changed", (await call).Error!.Code);
        Assert.Empty(rig.Os.Sent);
    }

    [Fact]
    public async Task MonitorCannotStart_NoInput()
    {
        using var rig = new Rig();
        rig.Os.MonitorFails = true;
        var res = await rig.Run(GuardedInputTools.ClickElement, ClickGo);
        Assert.Equal("stop_path_unavailable", res.Error!.Code);
        Assert.Empty(rig.Os.Sent);
    }

    [Fact]
    public async Task CancellationDuringTyping_StopsBeforeTheNextCharacter()
    {
        using var rig = new Rig();
        using var cts = new CancellationTokenSource();
        rig.Between = i => { if (i == 1) cts.Cancel(); return Task.CompletedTask; };
        int n; lock (rig.Delivered) n = rig.Delivered.Count + 1;
        var call = rig.Service.ExecuteAsync(GuardedInputTools.TypeText, JsonSerializer.SerializeToElement(TypeInto("abcd")), new DesktopActionContext("t1", "c1", Owner), cts.Token);
        rig.Decide(await rig.DeliveredAsync(n), true);
        var res = await call;
        Assert.NotEqual("ok", res.Status);
        Assert.True(rig.Os.Sent.Count <= 2, $"sent {rig.Os.Sent.Count} events after cancellation");
    }

    [Fact]
    public void Policy_ClassifiesInputAsElevated_ApprovalRequired()
    {
        var p = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance);
        foreach (var t in new[] { DesktopActionTypes.ClickElement, DesktopActionTypes.TypeText, DesktopActionTypes.PressKeys })
        {
            var (allowed, risk, _) = p.EvaluatePolicy(t, new Dictionary<string, string>(), "fixture.exe");
            Assert.False(allowed);
            Assert.Equal(ActionRiskLevel.Elevated, risk);
        }
    }

    [Fact]
    public void Composite_RoutesByTool_AndRejectsDuplicates()
    {
        using var rig = new Rig();
        var c = new CompositeDesktopActionRequestService(rig.Service);
        Assert.Equal(GuardedInputTools.All, c.Tools);
        Assert.Throws<ArgumentException>(() => new CompositeDesktopActionRequestService(rig.Service, rig.Service));
    }
}
