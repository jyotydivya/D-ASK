using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Input;

/// <summary>Reads and writes Unicode text on the Windows clipboard (behind an interface so the pathway can be tested with a fake).</summary>
public interface IClipboardPlatform
{
    /// <summary>(ok, text) — ok=false when the clipboard could not be opened; text=null when it holds no text.</summary>
    (bool Ok, string? Text) ReadText();
    bool WriteText(string text);
    uint SequenceNumber();
}

public sealed class ClipboardOptions
{
    /// <summary>AgentHost:Clipboard. Off by default.</summary>
    public bool Enabled { get; init; } = false;
    public int MaxWriteLength { get; init; } = 4000;
    public int MaxReadLength { get; init; } = 4000;
}

/// <summary>
/// desktop.clipboard_write / desktop.clipboard_read. Both are approved separately in the HUD (the clipboard may hold anything the user
/// copied, so even reading it is the user's decision). A write shows the exact text and is verified by reading the clipboard back; a read
/// returns at most MaxReadLength characters and refuses to hand over text that looks like a secret (passwords, keys, tokens).
/// Neither the written nor the read text is ever logged or audited (only lengths).
/// </summary>
public sealed class ClipboardService : IDesktopActionRequestService
{
    public const string Read = "desktop.clipboard_read";
    public const string Write = "desktop.clipboard_write";

    private readonly ApprovalGate _gate;
    private readonly IClipboardPlatform _clip;
    private readonly ClipboardOptions _opts;
    private readonly ILogger? _logger;

    public ClipboardService(ApprovalGate gate, IClipboardPlatform clip, ClipboardOptions options, ILogger? logger = null)
    {
        _gate = gate; _clip = clip; _opts = options; _logger = logger;
    }

    public IReadOnlyList<string> Tools => _opts.Enabled && _gate.Available ? new[] { Read, Write } : Array.Empty<string>();
    public int MaxCallMs => (int)ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds + 15_000;

    private static readonly Regex Secretish = new(
        @"(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|(?i:\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S{4,}))",
        RegexOptions.Compiled);
    public static bool LooksSecret(string s) => Secretish.IsMatch(s);

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        try
        {
            var r = await RunAsync(tool, args, ctx, ct);
            if (r.Status != "ok") _logger?.LogInformation("[Clipboard] {Tool} for task {TaskId}: not performed ({Code}).", tool, ctx.TaskId, r.Error?.Code ?? r.Status);
            return r;
        }
        catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
    }

    private async Task<DesktopCallResult> RunAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (tool != Read && tool != Write) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (!_opts.Enabled) return DesktopCallResult.Fail("clipboard_disabled", "Clipboard access is switched off in this installation (AgentHost:Clipboard). Nothing was done.");
        if (args.ValueKind != JsonValueKind.Object) return DesktopCallResult.Fail("invalid_args", "arguments must be an object");
        string? text = null;
        foreach (var p in args.EnumerateObject())
        {
            if (tool == Write && p.Name == "text" && p.Value.ValueKind == JsonValueKind.String) text = p.Value.GetString();
            else return DesktopCallResult.Fail("invalid_args", tool == Write ? "only { text } is accepted" : "no arguments are accepted");
        }
        if (tool == Write)
        {
            if (string.IsNullOrEmpty(text)) return DesktopCallResult.Fail("invalid_args", "text is required");
            if (text.Length > _opts.MaxWriteLength) return DesktopCallResult.Fail("invalid_args", $"text is limited to {_opts.MaxWriteLength} characters");
            if (text.Any(c => char.IsControl(c) && c is not ('\n' or '\r' or '\t'))) return DesktopCallResult.Fail("invalid_args", "text may not contain control characters");
        }

        var parameters = tool == Write
            ? new Dictionary<string, string>
            {
                ["operation"] = "Put this text on the clipboard (replacing what is there now)",
                ["text"] = text!, ["textLength"] = text!.Length.ToString(),
                ["reversible"] = "No: whatever is on the clipboard now is replaced.",
                ["execution"] = "Done once, right after your approval; the clipboard is then read back and compared.",
            }
            : new Dictionary<string, string>
            {
                ["operation"] = "Read the text that is on your clipboard now and give it to D-ASK",
                ["limit"] = $"at most {_opts.MaxReadLength} characters; text that looks like a password, key or token is not handed over",
                ["execution"] = "Read once, right after your approval. Nothing on the clipboard is changed.",
            };
        var (request, refusal) = await _gate.RequestAsync(tool == Write ? DesktopActionTypes.ClipboardWrite : DesktopActionTypes.ClipboardRead, parameters,
            "Windows clipboard", "Clipboard", tool == Write ? "D-ASK asks to put text on your clipboard." : "D-ASK asks to read your clipboard.", ctx, ct);
        if (refusal != null) return refusal;
        if (!_gate.StillValid(request!)) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active. Nothing was done.");

        if (tool == Write)
        {
            uint before = _clip.SequenceNumber();
            bool wrote = await OnSta(() => _clip.WriteText(text!));
            var back = await OnSta(() => _clip.ReadText());
            bool verified = wrote && back.Ok && back.Text == text && _clip.SequenceNumber() != before;
            await _gate.AuditAsync(verified ? "Verified" : "Unverified", request!, ctx, $"write {text!.Length} chars; verified={verified}");
            if (!wrote) return DesktopCallResult.Fail("execution_failed", "The clipboard could not be opened (another program is holding it). Nothing was changed.");
            if (!verified) return DesktopCallResult.Fail("execution_unverified", "D-ASK wrote to the clipboard once, but reading it back did not show exactly the approved text.");
            return DesktopCallResult.Ok(new { executed = true, verified = true, textLength = text.Length, observed = "the clipboard now holds exactly the approved text (read back)" });
        }

        var (ok, value) = await OnSta(() => _clip.ReadText());
        await _gate.AuditAsync("Read", request!, ctx, ok ? $"read {(value?.Length ?? 0)} chars" : "clipboard busy");
        if (!ok) return DesktopCallResult.Fail("execution_failed", "The clipboard could not be opened (another program is holding it).");
        if (value == null) return DesktopCallResult.Ok(new { executed = true, verified = true, hasText = false, observed = "the clipboard holds no text" });
        if (LooksSecret(value)) return DesktopCallResult.Fail("secret_refused", "The clipboard text looks like a password, key or token, so D-ASK did not take it.");
        bool truncated = value.Length > _opts.MaxReadLength;
        string shown = truncated ? value[.._opts.MaxReadLength] : value;
        return DesktopCallResult.Ok(new { executed = true, verified = true, hasText = true, text = shown, length = value.Length, truncated, observed = $"read {value.Length} character(s) from the clipboard" });
    }

    /// <summary>The clipboard API wants an STA thread with a message queue; each call runs on its own short-lived STA thread.</summary>
    private static Task<T> OnSta<T>(Func<T> f)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var t = new Thread(() => { try { tcs.SetResult(f()); } catch (Exception ex) { tcs.SetException(ex); } }) { IsBackground = true, Name = "DASK-Clipboard" };
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        return tcs.Task;
    }
}

/// <summary>Win32 clipboard: CF_UNICODETEXT through a message-only owner window, with a few short retries when another program holds it.</summary>
public sealed class Win32ClipboardPlatform : IClipboardPlatform
{
    private const uint CF_UNICODETEXT = 13, GMEM_MOVEABLE = 0x0002;

    public uint SequenceNumber() => GetClipboardSequenceNumber();

    public (bool Ok, string? Text) ReadText()
    {
        if (!Open(IntPtr.Zero)) return (false, null);
        try
        {
            if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return (true, null);
            var h = GetClipboardData(CF_UNICODETEXT);
            if (h == IntPtr.Zero) return (true, null);
            var p = GlobalLock(h);
            if (p == IntPtr.Zero) return (true, null);
            try { return (true, Marshal.PtrToStringUni(p)); } finally { GlobalUnlock(h); }
        }
        finally { CloseClipboard(); }
    }

    public bool WriteText(string text)
    {
        var owner = CreateWindowEx(0, "STATIC", "DASK-Clipboard", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        try
        {
            if (!Open(owner)) return false;
            try
            {
                if (!EmptyClipboard()) return false;
                int bytes = (text.Length + 1) * 2;
                var h = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes);
                if (h == IntPtr.Zero) return false;
                var p = GlobalLock(h);
                if (p == IntPtr.Zero) { GlobalFree(h); return false; }
                try
                {
                    var chars = (text + "\0").ToCharArray();
                    Marshal.Copy(chars, 0, p, chars.Length);
                }
                finally { GlobalUnlock(h); }
                if (SetClipboardData(CF_UNICODETEXT, h) == IntPtr.Zero) { GlobalFree(h); return false; }
                return true;   // the system owns the memory now
            }
            finally { CloseClipboard(); }
        }
        finally { if (owner != IntPtr.Zero) DestroyWindow(owner); }
    }

    private static bool Open(IntPtr owner)
    {
        for (int i = 0; i < 10; i++)
        {
            if (OpenClipboard(owner)) return true;
            Thread.Sleep(30);
        }
        return false;
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern bool EmptyClipboard();
    [DllImport("user32.dll")] private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] private static extern IntPtr SetClipboardData(uint format, IntPtr mem);
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalLock(IntPtr h);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr h);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowEx(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr h);
}
