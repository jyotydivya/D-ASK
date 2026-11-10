using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Browser;

/// <summary>
/// Browser stage 2: the daemon is the approval authority for actions in D-ASK's private browser. The agent host owns the
/// browser (local Chromium, network locked to the site the user named); it may only ASK, through this tool, for the user's
/// approval of ONE exact action: click one element, or fill one field with exact text, on one page. The daemon validates
/// every field strictly, shows the exact action in the HUD (same policy engine, digest, owner session, liveness lease,
/// expiry and Emergency Stop generation as every desktop action), records the audit trail, and on approval consumes the
/// approval exactly once and returns it. The host must re-identify the element before acting and verify the effect after.
/// Passwords and secrets are never accepted for approval (the host refuses password fields; the policy engine refuses
/// secret-looking parameters). Off unless AgentHost:BrowserActions is true.
/// </summary>
public sealed class BrowserActionRequestService : IDesktopActionRequestService
{
    public const string RequestAction = "browser.request_action";
    public const string ClickType = "Browser.Click";
    public const string FillType = "Browser.Fill";
    public const string Performed = "Performed once, right after your approval, in D-ASK's private browser on exactly this element (page address and element checked again first); the result is then verified. Emergency Stop cancels it.";
    public const int MaxTextChars = 500;

    private static readonly Regex Fingerprint = new("^[0-9a-f]{64}$");
    private static readonly HashSet<string> Roles = new(StringComparer.Ordinal) { "button", "link", "checkbox", "radio", "tab", "menuitem", "textbox", "searchbox", "combobox", "option", "switch" };
    private static readonly HashSet<string> FillRoles = new(StringComparer.Ordinal) { "textbox", "searchbox", "combobox" };
    private static readonly HashSet<string> Fields = new(StringComparer.Ordinal) { "kind", "pageUrl", "pageTitle", "element", "text", "ownerPid" };

    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly bool _enabled;
    private readonly TimeSpan _ttl;
    private readonly ILogger? _logger;

    public BrowserActionRequestService(ActionPolicyEngine policy, Func<bool> isStopped, Func<ulong> generation, IEvidenceRecorder? evidence,
        bool enabled, TimeSpan? approvalTtl = null, ILogger? logger = null)
    {
        _policy = policy; _isStopped = isStopped; _generation = generation; _evidence = evidence; _enabled = enabled;
        _ttl = approvalTtl ?? TimeSpan.FromSeconds(30); _logger = logger;
    }

    /// <summary>Offered only when enabled AND the audit journal exists (no audit, no action).</summary>
    public IReadOnlyList<string> Tools => _enabled && _evidence != null ? new[] { RequestAction } : Array.Empty<string>();
    public int MaxCallMs => (int)Math.Min(_ttl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + 10_000;

    public sealed record Request(string Kind, string PageUrl, string Site, string PageTitle, string Role, string Name, string Tag, string Fingerprint, string? Text, int OwnerPid);

    /// <summary>Strict: every field required and bounded; nothing unknown; only http(s) pages; fills only into text fields.</summary>
    public static string? Parse(JsonElement args, out Request req)
    {
        req = null!;
        if (args.ValueKind != JsonValueKind.Object) return "arguments must be an object";
        foreach (var p in args.EnumerateObject()) if (!Fields.Contains(p.Name)) return $"unknown argument '{(p.Name.Length > 40 ? p.Name[..40] : p.Name)}'";
        string? S(string n, int max) => args.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String && v.GetString()!.Length is > 0 and var l && l <= max ? v.GetString() : null;
        var kind = S("kind", 8);
        if (kind is not ("click" or "fill")) return "kind must be click or fill";
        var url = S("pageUrl", 2000);
        if (url == null || !Uri.TryCreate(url, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https") || !string.IsNullOrEmpty(u.UserInfo))
            return "pageUrl must be an http(s) address without credentials";
        var title = args.TryGetProperty("pageTitle", out var tv) && tv.ValueKind == JsonValueKind.String && tv.GetString()!.Length <= 300 ? tv.GetString()! : null;
        if (title == null) return "pageTitle is required (may be empty)";
        if (!args.TryGetProperty("element", out var el) || el.ValueKind != JsonValueKind.Object) return "element is required";
        foreach (var p in el.EnumerateObject()) if (p.Name is not ("role" or "name" or "tag" or "fingerprint")) return "unknown element field";
        string? E(string n, int max) => el.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String && v.GetString()!.Length is > 0 and var l && l <= max ? v.GetString() : null;
        var role = E("role", 20); var name = E("name", 200); var tag = E("tag", 20); var fp = E("fingerprint", 64);
        if (role == null || !Roles.Contains(role)) return "element.role is not an allowed role";
        if (name == null) return "element.name is required";
        if (tag == null || !Regex.IsMatch(tag, "^[a-z][a-z0-9-]{0,19}$")) return "element.tag is invalid";
        if (fp == null || !Fingerprint.IsMatch(fp)) return "element.fingerprint must be a SHA-256 hex digest";
        string? text = null;
        if (kind == "fill")
        {
            if (!FillRoles.Contains(role)) return "only text fields can be filled";
            text = args.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            if (text == null || text.Length == 0 || text.Length > MaxTextChars) return $"text must be 1 to {MaxTextChars} characters";
        }
        else if (args.TryGetProperty("text", out _)) return "a click has no text";
        if (!args.TryGetProperty("ownerPid", out var bp) || !bp.TryGetInt32(out int pid) || pid <= 0) return "ownerPid is required";
        req = new Request(kind, url, u.IsDefaultPort ? u.Host : $"{u.Host}:{u.Port}", title, role, name, tag, fp, text, pid);
        return null;
    }

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (tool != RequestAction || !Tools.Contains(tool)) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (Parse(args, out var r) is { } bad)
        {
            _logger?.LogInformation("[BrowserAction] Refused for task {TaskId}: invalid_args.", ctx.TaskId);
            return DesktopCallResult.Fail("invalid_args", bad);
        }
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active. Nothing was done.");
        string type = r.Kind == "click" ? ClickType : FillType;
        var (_, risk, _) = _policy.EvaluatePolicy(type, new Dictionary<string, string>(), "D-ASK browser");
        if (risk != ActionRiskLevel.Elevated) return DesktopCallResult.Fail("approval_refused", "This browser action is not classified for approval. Nothing was done.");
        var parameters = new Dictionary<string, string>
        {
            ["site"] = r.Site,
            ["pageUrl"] = r.PageUrl,
            ["pageTitle"] = r.PageTitle,
            ["elementRole"] = r.Role,
            ["elementName"] = r.Name,
            ["elementTag"] = r.Tag,
            ["elementFingerprint"] = r.Fingerprint,
            ["browser"] = "D-ASK private browser (local Chromium); network limited to the site you named",
            ["reversible"] = r.Kind == "fill" ? "Usually: the field can be cleared. Nothing is submitted by filling a field." : "It depends on what this element does on that site (a click may submit, send or buy).",
            ["execution"] = Performed,
        };
        if (r.Text != null) { parameters["text"] = r.Text; parameters["textLength"] = r.Text.Length.ToString(); }
        int pid = r.OwnerPid;
        DateTimeOffset started;
        try { using var p = Process.GetProcessById(pid); started = new DateTimeOffset(p.StartTime.ToUniversalTime(), TimeSpan.Zero); }
        catch { return DesktopCallResult.Fail("browser_unavailable", "The process that owns D-ASK's browser is not running. Nothing was done."); }
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"),
            ActionId = Guid.NewGuid().ToString("N"),
            ActionType = type,
            ActionParameters = parameters,
            TargetProcessName = "D-ASK browser",
            TargetWindowTitle = r.PageTitle.Length > 0 ? r.PageTitle : r.Site,
            TargetHwnd = 0,
            TargetProcessId = pid,
            TargetProcessCreationTime = started,
            SessionId = ctx.OwnerSessionId,
            StopGeneration = _generation(),
            RiskLevel = risk.ToString(),
            CreatedAtUtc = DateTimeOffset.UtcNow,
            ExpiresAtUtc = DateTimeOffset.UtcNow + _ttl,
            Reason = r.Kind == "click" ? $"D-ASK asks to click one element on {r.Site}." : $"D-ASK asks to fill one field on {r.Site}.",
        };
        await AuditAsync("BrowserActionRequested", request, ctx, r, "Pending", $"agent call {ctx.CallId}");
        ActionApprovalResponse decision = await _policy.RequestApprovalAsync(request, ct);
        if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
        if (!decision.Approved)
        {
            var (code, message) = decision.DecisionSource switch
            {
                "UserExplicitConfirmation" => ("approval_denied", "You declined. Nothing was done."),
                "TimeoutDenied" => ("approval_expired", "The approval expired before a decision. Nothing was done."),
                "EmergencyStopDenied" or "StaleGenerationDenied" => ("emergency_stopped", "Emergency Stop cancelled the request. Nothing was done."),
                "SessionDisconnectedDenied" => ("hud_unavailable", "The HUD is not connected or not responding, so the request could not be approved. Nothing was done."),
                "IntegrityMismatch" => ("approval_refused", "The request could not be offered for approval exactly as it would be performed. Nothing was done."),
                _ => ("approval_denied", "The request was not approved. Nothing was done."),
            };
            await AuditAsync("BrowserActionNotApproved", request, ctx, r, "Denied", decision.DecisionSource ?? "denied");
            return DesktopCallResult.Fail(code, message);
        }
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters,
            request.TargetProcessName, 0, pid, started, ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid)
        {
            await AuditAsync("BrowserActionApprovalInvalid", request, ctx, r, "Refused", error ?? "invalid");
            return DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was done.");
        }
        if (_evidence == null) return DesktopCallResult.Fail("approval_invalid", "No audit journal. Nothing was done.");
        // Required record: no audit, no action.
        await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
        {
            EventType = "BrowserActionAdmitted", Source = "BrowserActionRequestService", ActionId = request.ActionId, ApprovalId = request.ApprovalId,
            SessionId = request.SessionId, RiskLevel = request.RiskLevel, StopGeneration = request.StopGeneration, Decision = "Admitted",
            Reason = "approval consumed once", DetailsJson = AuditJson.Details(Details(request, ctx, r)),
        });
        _logger?.LogInformation("[BrowserAction] {Type} approved and consumed for task {TaskId} (approval {ApprovalId}).", type, ctx.TaskId, request.ApprovalId);
        return DesktopCallResult.Ok(new
        {
            decision = "approved", consumed = true, approvalId = request.ApprovalId, actionType = type, stopGeneration = request.StopGeneration,
            elementFingerprint = r.Fingerprint, pageUrl = r.PageUrl,
        });
    }

    private static object Details(ActionApprovalRequest q, DesktopActionContext ctx, Request r) => new
    {
        actionType = q.ActionType, taskId = ctx.TaskId, callId = ctx.CallId, site = r.Site, role = r.Role, fingerprint = r.Fingerprint, ownerPid = r.OwnerPid,
        textLength = r.Text?.Length, textSha256 = r.Text != null ? Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(r.Text))).ToLowerInvariant() : null,
    };

    private async Task AuditAsync(string evt, ActionApprovalRequest q, DesktopActionContext ctx, Request r, string decision, string reason)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt, Source = "BrowserActionRequestService", ActionId = q.ActionId, ApprovalId = q.ApprovalId, SessionId = q.SessionId,
                RiskLevel = q.RiskLevel, StopGeneration = q.StopGeneration, Decision = decision, Reason = AuditJson.Bound(reason),
                DetailsJson = AuditJson.Details(Details(q, ctx, r)),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[BrowserAction] Audit record {Event} failed.", evt); }
    }
}
