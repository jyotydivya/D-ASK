using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Input;
using DAsk.Daemon.Automation.Policy;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Chrome;

public sealed class ChromeOptions
{
    /// <summary>AgentHost:ChromeControl. Off by default.</summary>
    public bool Enabled { get; init; } = false;
    /// <summary>chrome.exe used to OPEN Chrome when it is not running (the user's normal profile).</summary>
    public string? ChromeExePath { get; init; }
    /// <summary>Web searches need internet access: off unless AgentHost:WebSearch (offline-first).</summary>
    public bool WebSearchAllowed { get; init; } = false;
    /// <summary>How long one authorization lasts at most (it also ends with Emergency Stop, revocation or a daemon restart).</summary>
    public TimeSpan SessionLifetime { get; init; } = TimeSpan.FromHours(2);
    public int ConnectWaitMs { get; init; } = 20_000;
    /// <summary>TESTS ONLY: treat the computer as offline.</summary>
    public Func<bool>? IsOnline { get; init; }
}

/// <summary>
/// The user's own Google Chrome, through the D-ASK extension and Chrome Native Messaging (2026-11-14). No debugging port is opened.
///   * The FIRST action asks the user (HUD) to authorize controlling this Chrome, naming the connected Chrome process. The session lasts
///     until revoked (chrome.revoke), Emergency Stop, Chrome disconnecting, D-ASK restarting, or the lifetime above.
///   * Ordinary navigation, reading and tab management then need no further approval. Clicks that look consequential (buy, pay, send,
///     delete, publish, submit a form, account settings, …) each need a SEPARATE approval naming the page and the element.
///   * Password, payment-card and one-time-code fields are never filled; secret-looking text is never typed.
///   * D-ASK never reads cookies, saved passwords, autofill data, history or profile files: the extension has no such permission.
///   * Results are verified from what Chrome reports after the action (final URL/title, the field's value read back, tab state).
/// </summary>
public sealed partial class ChromeService : IDesktopActionRequestService, IDisposable
{
    public const string Status = "chrome.status", Authorize = "chrome.authorize", Revoke = "chrome.revoke", Open = "chrome.open";
    public const string ListTabs = "chrome.list_tabs", OpenTab = "chrome.open_tab", Navigate = "chrome.navigate", SwitchTab = "chrome.switch_tab", CloseTab = "chrome.close_tab";
    public const string ReadPage = "chrome.read_page", Click = "chrome.click", Fill = "chrome.fill", Search = "chrome.search";
    public static readonly IReadOnlyList<string> All = new[] { Status, Authorize, Revoke, Open, ListTabs, OpenTab, Navigate, SwitchTab, CloseTab, ReadPage, Click, Fill, Search };

    public static bool IsUnmetered(string tool) => tool.StartsWith("chrome.", StringComparison.Ordinal);

    private readonly ApprovalGate _gate;
    private readonly ChromeBroker _broker;
    private readonly ChromeOptions _o;
    private readonly ILogger? _log;
    private readonly object _lock = new();
    private string? _session;
    private DateTimeOffset _sessionUntil;
    private string? _sessionOwner;
    private readonly Timer _stopWatch;

    public ChromeService(ApprovalGate gate, ChromeBroker broker, ChromeOptions options, ILogger? logger = null)
    {
        _gate = gate; _broker = broker; _o = options; _log = logger;
        _broker.ConnectionChanged += () => { if (!_broker.Connected) EndSession("Chrome disconnected"); };
        // Emergency Stop revokes the session at once (and the extension refuses everything until a new authorization).
        _stopWatch = new Timer(_ => { if (_gate.Stopped && SessionActive) _ = RevokeAsync("Emergency Stop"); }, null, 300, 300);
    }

    public IReadOnlyList<string> Tools => _o.Enabled && _gate.Available ? All : Array.Empty<string>();
    public int MaxCallMs => (int)ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds * 2 + 60_000;
    public bool SessionActive { get { lock (_lock) return _session != null && DateTimeOffset.UtcNow < _sessionUntil; } }

    private void EndSession(string why)
    {
        lock (_lock) { if (_session == null) return; _session = null; _sessionOwner = null; }
        _log?.LogInformation("[Chrome] Control session ended: {Why}.", why);
    }

    private async Task<bool> RevokeAsync(string why)
    {
        EndSession(why);
        var r = await _broker.SendAsync("revoke", new { }, null, 3000, CancellationToken.None);
        return r.Ok;
    }

    public void Dispose()
    {
        _stopWatch.Dispose();
        if (SessionActive) { try { RevokeAsync("D-ASK is shutting down").Wait(2000); } catch { } }
    }

    private static string? Str(JsonElement a, string n) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static int? Int(JsonElement a, string n) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out int i) ? i : null;
    private static DesktopCallResult Bad(string m) => DesktopCallResult.Fail("invalid_args", m);
    private bool Online() => _o.IsOnline?.Invoke() ?? NetworkInterface.GetIsNetworkAvailable();

    private static string? CheckUrl(string? url, out Uri? uri)
    {
        uri = null;
        if (string.IsNullOrWhiteSpace(url) || url.Length > 2000) return "a web address is required";
        if (!url.Contains("://")) url = "https://" + url;
        if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || (uri.Scheme != "https" && uri.Scheme != "http")) return "only http(s) web addresses can be opened";
        return null;
    }
    private static bool IsLocal(Uri u) => u.IsLoopback || u.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase);

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        try
        {
            if (!All.Contains(tool)) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
            if (!_o.Enabled) return DesktopCallResult.Fail("chrome_disabled", "Controlling your Chrome is switched off in this installation (AgentHost:ChromeControl). Nothing was done.");
            if (a.ValueKind != JsonValueKind.Object) return Bad("arguments must be an object");
            if (_gate.Stopped && tool != Status && tool != Revoke) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active; Chrome control is suspended. Nothing was done.");
            var r = await RunAsync(tool, a, ctx, ct);
            if (r.Status != "ok") _log?.LogInformation("[Chrome] {Tool} for task {TaskId}: {Code}.", tool, ctx.TaskId, r.Error?.Code ?? r.Status);
            return r;
        }
        catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
    }

    private async Task<DesktopCallResult> RunAsync(string tool, JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        switch (tool)
        {
            case Status:
                return DesktopCallResult.Ok(new { verified = true, connected = _broker.Connected, authorized = SessionActive, chromePid = _broker.ChromePid, chromePath = _broker.ChromePath,
                    observed = _broker.Connected ? $"Chrome is connected through the D-ASK extension{(SessionActive ? " and D-ASK is authorized to control it" : "; D-ASK is not authorized yet")}" : "Chrome with the D-ASK extension is not connected" });
            case Revoke:
            {
                bool had = SessionActive;
                bool told = await RevokeAsync("you revoked it");
                return DesktopCallResult.Ok(new { executed = had, verified = true, extensionConfirmed = told, observed = had ? "D-ASK's control of your Chrome was revoked" : "D-ASK was not controlling your Chrome" });
            }
            case Authorize:
            {
                if (await EnsureConnected(false, ct) is { } nc) return nc;
                return await EnsureAuthorized(ctx, ct) ?? DesktopCallResult.Ok(new { executed = true, verified = true, authorized = true, observed = "D-ASK may now control this Chrome until you revoke it or press Emergency Stop" });
            }
            case Open:
            {
                Uri? uri = null;
                if (Str(a, "url") is { } u && CheckUrl(u, out uri) is { } bad) return Bad(bad);
                if (uri != null && !IsLocal(uri) && !Online()) return DesktopCallResult.Fail("offline", "This computer is offline, so the web page cannot be loaded. Nothing was opened.");
                if (await EnsureConnected(true, ct) is { } nc) return nc;
                if (await EnsureAuthorized(ctx, ct) is { } na) return na;
                if (uri == null) return DesktopCallResult.Ok(new { executed = true, verified = true, observed = "Chrome is open and connected to D-ASK" });
                return await TabResult("openTab", new { url = uri.ToString(), active = true }, uri, ct);
            }
            case Search:
            {
                if (Str(a, "query") is not { Length: > 0 and <= 300 } q) return Bad("query is required (up to 300 characters)");
                if (!_o.WebSearchAllowed) return DesktopCallResult.Fail("web_search_off", "Web searches are switched off (offline-first; AgentHost:WebSearch). Nothing was searched.");
                if (!Online()) return DesktopCallResult.Fail("offline", "This computer is offline, so a web search is not possible. Nothing was searched.");
                if (await EnsureConnected(true, ct) is { } nc) return nc;
                if (await EnsureAuthorized(ctx, ct) is { } na) return na;
                var su = new Uri("https://www.google.com/search?q=" + Uri.EscapeDataString(q));
                return await TabResult("openTab", new { url = su.ToString(), active = true }, su, ct);
            }
        }

        // Everything else acts on the connected, authorized Chrome.
        if (await EnsureConnected(false, ct) is { } notConnected) return notConnected;
        if (await EnsureAuthorized(ctx, ct) is { } notAuthorized) return notAuthorized;
        switch (tool)
        {
            case ListTabs:
            {
                var r = await Send("listTabs", new { }, ct);
                if (!r.Ok) return Fail(r.Error);
                var tabs = r.Result.EnumerateArray().Select(t => new { tabId = t.GetProperty("tabId").GetInt32(), title = t.GetProperty("title").GetString(), url = t.GetProperty("url").GetString(), active = t.GetProperty("active").GetBoolean() }).ToList();
                return DesktopCallResult.Ok(new { verified = true, count = tabs.Count, tabs, observed = $"{tabs.Count} open tab(s)" });
            }
            case OpenTab:
            {
                if (CheckUrl(Str(a, "url"), out var uri) is { } bad) return Bad(bad);
                if (!IsLocal(uri!) && !Online()) return DesktopCallResult.Fail("offline", "This computer is offline, so the web page cannot be loaded. Nothing was opened.");
                return await TabResult("openTab", new { url = uri!.ToString(), active = true }, uri, ct);
            }
            case Navigate:
            {
                if (CheckUrl(Str(a, "url"), out var uri) is { } bad) return Bad(bad);
                if (!IsLocal(uri!) && !Online()) return DesktopCallResult.Fail("offline", "This computer is offline, so the web page cannot be loaded. Nothing was changed.");
                int? tab = await TabOf(a, ct);
                if (tab == null) return DesktopCallResult.Fail("no_tab", "There is no Chrome tab to navigate.");
                return await TabResult("navigate", new { tabId = tab, url = uri!.ToString() }, uri, ct);
            }
            case SwitchTab:
            {
                int? tab = Int(a, "tabId");
                if (tab == null && Str(a, "title") is { Length: > 0 } title)
                {
                    var l = await Send("listTabs", new { }, ct);
                    if (!l.Ok) return Fail(l.Error);
                    var hits = l.Result.EnumerateArray().Where(t => (t.GetProperty("title").GetString() ?? "").Contains(title, StringComparison.OrdinalIgnoreCase)).ToList();
                    if (hits.Count != 1) return DesktopCallResult.Fail(hits.Count == 0 ? "not_found" : "ambiguous_target", hits.Count == 0 ? $"No tab's title contains \"{title}\"." : $"{hits.Count} tabs match \"{title}\"; be more specific.");
                    tab = hits[0].GetProperty("tabId").GetInt32();
                }
                if (tab == null) return Bad("tabId or title is required");
                var r = await Send("activateTab", new { tabId = tab }, ct);
                if (!r.Ok) return Fail(r.Error);
                bool active = r.Result.GetProperty("active").GetBoolean();
                return active ? DesktopCallResult.Ok(new { executed = true, verified = true, tabId = tab, title = r.Result.GetProperty("title").GetString(), url = r.Result.GetProperty("url").GetString(), observed = "that tab is now the active tab" })
                    : DesktopCallResult.Fail("execution_unverified", "Chrome did not report the tab as active.");
            }
            case CloseTab:
            {
                if (Int(a, "tabId") is not int tab) return Bad("tabId is required");
                var r = await Send("closeTab", new { tabId = tab }, ct);
                if (!r.Ok) return Fail(r.Error);
                var l = await Send("listTabs", new { }, ct);
                bool gone = l.Ok && !l.Result.EnumerateArray().Any(t => t.GetProperty("tabId").GetInt32() == tab);
                return gone ? DesktopCallResult.Ok(new { executed = true, verified = true, observed = "the tab is closed" }) : DesktopCallResult.Fail("execution_unverified", "The tab is still listed.");
            }
            case ReadPage:
            {
                int? tab = await TabOf(a, ct);
                if (tab == null) return DesktopCallResult.Fail("no_tab", "There is no Chrome tab to read.");
                var r = await Send("readPage", new { tabId = tab }, ct, 20_000);
                if (!r.Ok) return Fail(r.Error);
                return DesktopCallResult.Ok(new { verified = true, tabId = tab, page = r.Result, observed = "read the page's visible content" });
            }
            case Click: return await ClickAsync(a, ctx, ct);
            case Fill:
            {
                if (Str(a, "field") is not { Length: > 0 and <= 120 } field) return Bad("field (its label, name or placeholder) is required");
                if (Str(a, "text") is not { } text || text.Length > 2000) return Bad("text is required (up to 2000 characters)");
                if (ClipboardService.LooksSecret(text)) return DesktopCallResult.Fail("secret_refused", "That text looks like a password, key or token; D-ASK does not type it into web pages.");
                int? tab = await TabOf(a, ct);
                if (tab == null) return DesktopCallResult.Fail("no_tab", "There is no Chrome tab.");
                var r = await Send("fill", new { tabId = tab, field, value = text }, ct);
                if (!r.Ok) return Fail(r.Error);
                if (!r.Result.GetProperty("filled").GetBoolean()) return DesktopCallResult.Fail("not_filled", $"Nothing was filled: {r.Result.GetProperty("reason").GetString()}.");
                bool back = r.Result.GetProperty("readBack").GetBoolean();
                return back ? DesktopCallResult.Ok(new { executed = true, verified = true, field = r.Result.GetProperty("field").GetString(), textLength = text.Length, observed = "the field now holds exactly the text (read back); nothing was submitted" })
                    : DesktopCallResult.Fail("execution_unverified", "The field was set once, but reading it back did not show exactly the text.");
            }
        }
        return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
    }

    private static DesktopCallResult Fail(string error) =>
        error.StartsWith("no_site_access", StringComparison.Ordinal) ? DesktopCallResult.Fail("no_site_access", error["no_site_access: ".Length..])
        : error.StartsWith("not_authorized", StringComparison.Ordinal) ? DesktopCallResult.Fail("not_authorized", "Chrome refused: D-ASK is not authorized in this Chrome right now.")
        : DesktopCallResult.Fail("chrome_error", error.Length > 300 ? error[..300] : error);

    private Task<(bool Ok, JsonElement Result, string Error)> Send(string cmd, object args, CancellationToken ct, int timeoutMs = 25_000)
    {
        string? s; lock (_lock) s = _session;
        return _broker.SendAsync(cmd, args, s, timeoutMs, ct);
    }

    private async Task<int?> TabOf(JsonElement a, CancellationToken ct)
    {
        if (Int(a, "tabId") is int t) return t;
        var l = await Send("listTabs", new { }, ct);
        if (!l.Ok) return null;
        var tabs = l.Result.EnumerateArray().ToList();
        var active = tabs.Where(x => x.GetProperty("active").GetBoolean()).ToList();
        return (active.LastOrDefault().ValueKind == JsonValueKind.Object ? active.Last() : tabs.LastOrDefault()) is { ValueKind: JsonValueKind.Object } x ? x.GetProperty("tabId").GetInt32() : null;
    }

    /// <summary>Navigation result, verified by the URL Chrome reports when the tab finished loading.</summary>
    private async Task<DesktopCallResult> TabResult(string cmd, object args, Uri? want, CancellationToken ct)
    {
        var r = await Send(cmd, args, ct, 30_000);
        if (!r.Ok) return Fail(r.Error);
        if (r.Result.ValueKind != JsonValueKind.Object) return DesktopCallResult.Fail("execution_unverified", "Chrome did not report the tab after loading.");
        string url = r.Result.GetProperty("url").GetString() ?? "", title = r.Result.GetProperty("title").GetString() ?? "";
        bool sameHost = want == null || (Uri.TryCreate(url, UriKind.Absolute, out var got) && got.Host.Equals(want.Host, StringComparison.OrdinalIgnoreCase));
        bool loaded = r.Result.TryGetProperty("status", out var st) && st.GetString() == "complete";
        if (!sameHost) return DesktopCallResult.Fail("execution_unverified", $"Chrome ended up at {url} instead of {want!.Host}.");
        return DesktopCallResult.Ok(new { executed = true, verified = loaded, tabId = r.Result.GetProperty("tabId").GetInt32(), url, title,
            observed = loaded ? $"Chrome shows \"{title}\" at {url}" : $"Chrome is still loading {url}" });
    }

    private static readonly Regex SensitiveWords = new(
        @"\b(buy|purchase|pay|payment|checkout|check\s*out|place\s+order|order\s+now|book\s+now|add\s+to\s+cart|subscribe|donate|transfer|send|post|publish|share|tweet|reply|submit|delete|remove|erase|unsubscribe|close\s+account|deactivate|confirm|sign\s*up|register|save\s+changes|update|change\s+password|log\s*out|sign\s*out|accept|agree|install|download)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex SensitivePath = new(@"/(checkout|payment|pay|billing|account|settings|cart|order|purchase|transfer|delete|compose|send)(/|$|\?)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Why a click needs its own approval, or null when it is ordinary navigation.</summary>
    public static string? SensitiveReason(JsonElement probe)
    {
        string text = probe.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
        string href = probe.TryGetProperty("href", out var h) ? h.GetString() ?? "" : "";
        string action = probe.TryGetProperty("formAction", out var f) ? f.GetString() ?? "" : "";
        string page = probe.TryGetProperty("pageUrl", out var p) ? p.GetString() ?? "" : "";
        if (probe.TryGetProperty("formHasPayment", out var fp) && fp.GetBoolean()) return "it is in a form with payment-card fields";
        if (probe.TryGetProperty("formHasPassword", out var fw) && fw.GetBoolean()) return "it is in a sign-in or account form";
        if (probe.TryGetProperty("isSubmit", out var s) && s.GetBoolean()) return "it submits a form";
        if (SensitiveWords.Match(text) is { Success: true } m) return $"\"{m.Value}\" may buy, pay, send, delete, publish or change something";
        if (href.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase)) return "it runs page script instead of following a link";
        foreach (var u in new[] { href, action, page })
            if (Uri.TryCreate(u, UriKind.Absolute, out var uri) && SensitivePath.IsMatch(uri.AbsolutePath)) return $"it is on or leads to {uri.Host}{uri.AbsolutePath}";
        return null;
    }

    private async Task<DesktopCallResult> ClickAsync(JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        if (Str(a, "text") is not { Length: > 0 and <= 120 } text) return Bad("text (the link or button's visible text) is required");
        int? tab = await TabOf(a, ct);
        if (tab == null) return DesktopCallResult.Fail("no_tab", "There is no Chrome tab.");
        var probe = await Send("probe", new { tabId = tab, target = new { text } }, ct);
        if (!probe.Ok) return Fail(probe.Error);
        int found = probe.Result.GetProperty("found").GetInt32();
        if (found != 1) return DesktopCallResult.Fail(found == 0 ? "target_not_found" : "ambiguous_target", found == 0 ? $"No visible link or button reads \"{text}\"." : $"{found} links/buttons read \"{text}\"; nothing was clicked.");
        string fingerprint = probe.Result.GetProperty("fingerprint").GetString()!;
        string pageUrl = probe.Result.GetProperty("pageUrl").GetString() ?? "";
        if (SensitiveReason(probe.Result) is { } why)
        {
            var parameters = new Dictionary<string, string>
            {
                ["operation"] = $"Click \"{probe.Result.GetProperty("text").GetString()}\" on {(Uri.TryCreate(pageUrl, UriKind.Absolute, out var pu) ? pu.Host : "this page")} in your Chrome",
                ["page"] = pageUrl, ["element"] = probe.Result.GetProperty("tag").GetString() ?? "", ["elementText"] = probe.Result.GetProperty("text").GetString() ?? "",
                ["link"] = probe.Result.GetProperty("href").GetString() ?? "", ["formAction"] = probe.Result.GetProperty("formAction").GetString() ?? "",
                ["why"] = $"Separate approval needed: {why}.",
                ["execution"] = "Clicked once, right after your approval, only if the element is unchanged; the resulting page is then reported.",
            };
            var (req, refusal) = await _gate.RequestAsync(DesktopActionTypes.ChromeSensitive, parameters, "chrome.exe", pageUrl, "D-ASK asks to do something consequential in your Chrome.", ctx, ct);
            if (refusal != null) return refusal;
            await _gate.AuditAsync("SensitiveApproved", req!, ctx, why);
            if (!SessionActive) return DesktopCallResult.Fail("emergency_stopped", "D-ASK's control of Chrome was revoked before the click. Nothing was clicked.");
        }
        var r = await Send("click", new { tabId = tab, target = new { text }, fingerprint }, ct, 20_000);
        if (!r.Ok) return Fail(r.Error);
        if (!r.Result.GetProperty("clicked").GetBoolean()) return DesktopCallResult.Fail("not_clicked", $"Nothing was clicked: {r.Result.GetProperty("reason").GetString()}.");
        string before = r.Result.GetProperty("urlBefore").GetString() ?? "", after = r.Result.GetProperty("urlAfter").GetString() ?? "";
        bool navigated = before != after;
        return DesktopCallResult.Ok(new { executed = true, verified = true, clicked = r.Result.GetProperty("text").GetString(), urlBefore = before, urlAfter = after, title = r.Result.GetProperty("titleAfter").GetString(),
            observed = navigated ? $"clicked once; Chrome now shows \"{r.Result.GetProperty("titleAfter").GetString()}\" at {after}" : "clicked once; the page stayed at the same address" });
    }

    /// <summary>Launches Chrome (the user's normal profile) when wanted and waits for the extension to connect.</summary>
    private async Task<DesktopCallResult?> EnsureConnected(bool launch, CancellationToken ct)
    {
        if (_broker.Connected) return null;
        if (!launch) return DesktopCallResult.Fail("not_connected", "Chrome with the D-ASK extension is not running. Ask D-ASK to open Chrome, or open it yourself (the D-ASK extension must be installed: see the setup steps).");
        string? exe = _o.ChromeExePath;
        if (exe == null || !File.Exists(exe)) return DesktopCallResult.Fail("chrome_missing", "Google Chrome was not found on this computer.");
        using (Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false })) { }
        var sw = Stopwatch.StartNew();
        while (!_broker.Connected && sw.ElapsedMilliseconds < _o.ConnectWaitMs) await Task.Delay(250, ct);
        return _broker.Connected ? null : DesktopCallResult.Fail("extension_missing", "Chrome opened, but the D-ASK extension did not connect. Install it (chrome://extensions → Developer mode → Load unpacked → the D-ASK 'extensions\\dask-chrome' folder) and run scripts\\chrome\\register-native-host.ps1 once.");
    }

    /// <summary>One approval authorizes controlling THIS connected Chrome until revoked, Emergency Stop, disconnect, restart or the lifetime.</summary>
    private async Task<DesktopCallResult?> EnsureAuthorized(DesktopActionContext ctx, CancellationToken ct)
    {
        if (SessionActive) return null;
        var parameters = new Dictionary<string, string>
        {
            ["operation"] = "Let D-ASK control your Google Chrome, including sites where you are signed in",
            ["chrome"] = $"{_broker.ChromePath ?? "chrome.exe"} (process {_broker.ChromePid?.ToString() ?? "unknown"}), through the D-ASK extension",
            ["allows"] = "Opening, reading and switching tabs, following links, filling ordinary fields.",
            ["separately"] = "Purchases, payments, sending, deleting, publishing, account changes and form submissions each need their own approval.",
            ["never"] = "D-ASK never reads cookies, saved passwords, autofill or history, and never fills password or card fields.",
            ["until"] = $"You revoke it, press Emergency Stop, Chrome or D-ASK closes, or {(int)_o.SessionLifetime.TotalMinutes} minutes pass.",
            ["execution"] = "Starts right after your approval; Chrome is told the session id and refuses anything without it.",
        };
        var (req, refusal) = await _gate.RequestAsync(DesktopActionTypes.ChromeAuthorize, parameters, "chrome.exe", "Google Chrome", "D-ASK asks to control your Chrome.", ctx, ct);
        if (refusal != null) return refusal;
        string session = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var told = await _broker.SendAsync("authorize", new { session }, null, 5000, ct);
        if (!told.Ok) { await _gate.AuditAsync("AuthorizeFailed", req!, ctx, told.Error); return DesktopCallResult.Fail("chrome_error", $"Chrome did not accept the session ({told.Error})."); }
        lock (_lock) { _session = session; _sessionUntil = DateTimeOffset.UtcNow + _o.SessionLifetime; _sessionOwner = ctx.OwnerSessionId; }
        await _gate.AuditAsync("Authorized", req!, ctx, $"chrome pid {_broker.ChromePid}");
        _log?.LogInformation("[Chrome] Control session authorized (Chrome pid {Pid}).", _broker.ChromePid);
        return null;
    }
}
