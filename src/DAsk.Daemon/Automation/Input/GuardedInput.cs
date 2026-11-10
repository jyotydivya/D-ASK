using System.Security.Cryptography;
using System.Text;
using DAsk.Daemon.Automation.Observation;

namespace DAsk.Daemon.Automation.Input;

// ─────────────────────────────────────────────────────────────────────────────
// Guarded desktop input (P1 mouse + P2 keyboard/text). Platform-neutral contracts and pure rules; the Win32/UIA side is
// in Win32GuardedInput.cs, the approval pathway in GuardedInputRequestService.cs.
//
// Safety rules (safety contracts §3.3/§3.4/§6/§7, decisions D-3, D-4, D-7):
//  * The agent never supplies coordinates, handles or key codes. It names a window and ONE UI Automation element; the
//    daemon resolves exactly one element and derives the click point from that element's own bounds.
//  * Mouse and keyboard have SEPARATE execution policies (AgentHost:DesktopMouseInput / DesktopKeyboardInput), both off
//    by default in code. They share only the approval infrastructure.
//  * Every input event (or atomic pair, e.g. button down+up) is preceded by a gate: cancellation, Emergency Stop latch,
//    stop epoch, the owner HUD's lease, physical user input (low-level hook), foreground = target, unchanged identity and
//    title, and (per kind) the element under the cursor or holding keyboard focus.
//  * Pressed buttons and modifiers are always released in a finally path. Nothing is ever retried.
//  * Success is reported only when an independent post-action observation shows the expected effect.
// ─────────────────────────────────────────────────────────────────────────────

public static class GuardedInputTools
{
    public const string ClickElement = "desktop.click_element";
    public const string TypeText = "desktop.type_text";
    public const string PressKeys = "desktop.press_keys";
    public static readonly IReadOnlyList<string> All = new[] { ClickElement, TypeText, PressKeys };
}

public enum InputKind { Mouse, Keyboard }

public sealed class GuardedInputOptions
{
    /// <summary>P1: perform approved element clicks. Off by default (AgentHost:DesktopMouseInput).</summary>
    public bool MouseEnabled { get; init; } = false;
    /// <summary>P2: perform approved text entry and key chords. Off by default (AgentHost:DesktopKeyboardInput).</summary>
    public bool KeyboardEnabled { get; init; } = false;
    public TimeSpan ApprovalTtl { get; init; } = TimeSpan.FromSeconds(30);
    public int MaxTextLength { get; init; } = 200;
    /// <summary>Pause between typed characters, so the gate runs between them and the target keeps up.</summary>
    public int InterEventDelayMs { get; init; } = 15;
    public int VerifyTimeoutMs { get; init; } = 2000;
    /// <summary>Pause between the pointer move and the click, so overlays that are hit-testable only under the pointer
    /// (the HUD in Interactive mode) become pass-through before the occlusion check that precedes the button event.</summary>
    public int PointerSettleMs { get; init; } = 200;
    /// <summary>D-7: applications that never receive input (password managers, OS credential and elevation UI).</summary>
    public IReadOnlySet<string> DeniedImageNames { get; init; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "KeePass.exe", "KeePassXC.exe", "1Password.exe", "Bitwarden.exe", "LastPass.exe", "Dashlane.exe", "Enpass.exe", "RoboForm.exe",
        "CredentialUIBroker.exe", "consent.exe", "LogonUI.exe", "LockApp.exe", "mstsc.exe", "Taskmgr.exe", "regedit.exe", "mmc.exe",
    };
    /// <summary>TESTS ONLY: runs after the write-ahead record and before the first event. Never set in production.</summary>
    public Func<Task>? TestHookBeforeFirstEvent { get; init; }
    /// <summary>TESTS ONLY: runs between events (after the first). Never set in production.</summary>
    public Func<int, Task>? TestHookBetweenEvents { get; init; }
}

/// <summary>What the agent may name: a control type plus an automation id and/or a name, all exact.</summary>
public sealed record ControlSelector(string ControlType, string? AutomationId, string? Name)
{
    public string Describe() => $"{ControlType}{(AutomationId is { Length: > 0 } a ? $" #{a}" : "")}{(Name is { Length: > 0 } n ? $" \"{n}\"" : "")}";
}

/// <summary>Safety contracts §3.3: control identity, resolved by the daemon from one UI Automation inspection.</summary>
public sealed record ControlIdentity(
    int[] RuntimeId, string ControlType, string AutomationId, string Name, string ControlPathHash,
    bool IsPassword, int[] Bounds, bool IsEnabled, bool IsOffscreen, bool IsKeyboardFocusable, IReadOnlyList<string> Patterns)
{
    public (int X, int Y) Center => ((Bounds[0] + Bounds[2]) / 2, (Bounds[1] + Bounds[3]) / 2);
    public bool HasArea => Bounds.Length == 4 && Bounds[2] - Bounds[0] >= 2 && Bounds[3] - Bounds[1] >= 2;
}

public sealed record InputRefusal(string Code, string Message);

public static class ControlResolver
{
    public const int MaxDepth = 12;
    public const int MaxElements = 600;

    public static string ControlPathHash(IReadOnlyList<UiaNode> nodes, int index)
    {
        var chain = new List<string>();
        for (int i = index, guard = 0; i >= 0 && guard < 64; i = nodes[i].ParentIndex, guard++)
            chain.Add($"{nodes[i].ControlType}|{nodes[i].Name}|{nodes[i].AutomationId}");
        chain.Reverse();
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("/", chain))));
    }

    /// <summary>Common names for UI Automation control types (a model or a person may say "text box" for an Edit).</summary>
    private static readonly Dictionary<string, string> TypeAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["TextBox"] = "Edit", ["Text box"] = "Edit", ["TextField"] = "Edit", ["Text field"] = "Edit", ["Field"] = "Edit", ["Input"] = "Edit",
        ["Check box"] = "CheckBox", ["Link"] = "Hyperlink", ["Radio button"] = "RadioButton", ["Menu item"] = "MenuItem", ["Tab"] = "TabItem",
    };

    public static string NormalizeType(string t) => TypeAliases.TryGetValue(t.Trim(), out var v) ? v : t.Trim();

    /// <summary>
    /// Exact matching. When the selector gives only ONE identifier, it may be the control's name or its automation id
    /// (both exact); a value matching different controls in the two ways is simply two matches, i.e. ambiguous.
    /// </summary>
    private static bool Matches(UiaNode n, ControlSelector s)
    {
        if (!string.Equals(n.ControlType, NormalizeType(s.ControlType), StringComparison.OrdinalIgnoreCase)) return false;
        bool hasA = s.AutomationId is { Length: > 0 }, hasN = s.Name is { Length: > 0 };
        if (hasA && hasN) return string.Equals(n.AutomationId, s.AutomationId, StringComparison.Ordinal) && string.Equals(n.Name, s.Name, StringComparison.Ordinal);
        string id = hasA ? s.AutomationId! : s.Name!;
        return string.Equals(n.AutomationId, id, StringComparison.Ordinal) || string.Equals(n.Name, id, StringComparison.Ordinal);
    }

    private static ControlIdentity ToIdentity(IReadOnlyList<UiaNode> nodes, int i)
    {
        var n = nodes[i];
        return new ControlIdentity(n.RuntimeId!, n.ControlType, n.AutomationId, n.Name, ControlPathHash(nodes, i),
            n.IsPassword, n.Bounds, n.IsEnabled, n.IsOffscreen, n.IsKeyboardFocusable, n.Patterns);
    }

    /// <summary>Exactly one element must match; an incomplete inspection cannot prove uniqueness and is refused.</summary>
    public static InputRefusal? Resolve(UiaInspection inspection, ControlSelector selector, out ControlIdentity? control)
    {
        control = null;
        if (inspection.Status != "ok")
            return new("target_uncertain", $"The window's controls could not be read completely ({inspection.Status}), so the control cannot be identified uniquely.");
        if (string.IsNullOrWhiteSpace(selector.ControlType) || (string.IsNullOrEmpty(selector.AutomationId) && string.IsNullOrEmpty(selector.Name)))
            return new("invalid_args", "Name the control by its type and its automation id or name (as listed by desktop.inspect_window).");
        var hits = new List<int>();
        for (int i = 0; i < inspection.Nodes.Count; i++) if (i > 0 && Matches(inspection.Nodes[i], selector)) hits.Add(i);
        if (hits.Count == 0) return new("target_not_found", $"No control {selector.Describe()} was found in the window.");
        if (hits.Count > 1) return new("ambiguous_target", $"{hits.Count} controls match {selector.Describe()}; name it more precisely (automation id).");
        var node = inspection.Nodes[hits[0]];
        if (node.RuntimeId is not { Length: > 0 }) return new("identity_incomplete", "The control has no UI Automation runtime id, so its identity cannot be established.");
        control = ToIdentity(inspection.Nodes, hits[0]);
        return null;
    }

    /// <summary>The same element, re-read: same runtime id, path, type, ids; usable and on screen.</summary>
    public static InputRefusal? Revalidate(ControlIdentity expected, UiaInspection now, out ControlIdentity? current)
    {
        current = null;
        if (now.Status != "ok") return new("target_uncertain", $"The window's controls could not be re-read completely ({now.Status}).");
        for (int i = 1; i < now.Nodes.Count; i++)
        {
            var n = now.Nodes[i];
            if (n.RuntimeId is not { Length: > 0 } rid || !rid.AsSpan().SequenceEqual(expected.RuntimeId)) continue;
            var c = ToIdentity(now.Nodes, i);
            if (c.ControlPathHash != expected.ControlPathHash || c.ControlType != expected.ControlType || c.AutomationId != expected.AutomationId || c.Name != expected.Name)
                return new("target_changed", "The control changed after the approval (its position in the window, type, id or name).");
            if (c.IsPassword != expected.IsPassword) return new("target_changed", "The control's password state changed.");
            if (!c.IsEnabled) return new("target_unusable", "The control is disabled.");
            if (c.IsOffscreen || !c.HasArea) return new("target_unusable", "The control is not visible on screen.");
            current = c;
            return null;
        }
        return new("target_disappeared", "The approved control no longer exists.");
    }

    /// <summary>A coarse signature of what the window shows; a click or key chord is verified by a change in it.</summary>
    public static string Signature(UiaInspection insp)
    {
        var sb = new StringBuilder();
        foreach (var n in insp.Nodes) sb.Append(n.ControlType).Append('|').Append(n.Name).Append('|').Append(n.AutomationId).Append('|').Append(n.IsEnabled ? '1' : '0').Append('\n');
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString())));
    }
}

/// <summary>P2: the only key chords the agent may request. No Windows key, no Alt+F4/Alt+Tab, no Ctrl+Alt, no close/quit.</summary>
public static class KeyChords
{
    public sealed record Chord(string Canonical, IReadOnlyList<ushort> Modifiers, ushort Key);

    private const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11;
    private static readonly Dictionary<string, ushort> Keys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Enter"] = 0x0D, ["Tab"] = 0x09, ["Escape"] = 0x1B, ["Backspace"] = 0x08, ["Delete"] = 0x2E, ["Space"] = 0x20,
        ["Up"] = 0x26, ["Down"] = 0x28, ["Left"] = 0x25, ["Right"] = 0x27, ["Home"] = 0x24, ["End"] = 0x23,
        ["PageUp"] = 0x21, ["PageDown"] = 0x22, ["F2"] = 0x71,
        ["A"] = 0x41, ["C"] = 0x43, ["V"] = 0x56, ["X"] = 0x58, ["Y"] = 0x59, ["Z"] = 0x5A,
    };

    public static readonly IReadOnlySet<string> Allowed = new HashSet<string>(StringComparer.Ordinal)
    {
        "Enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "Space", "Up", "Down", "Left", "Right", "Home", "End",
        "PageUp", "PageDown", "F2", "Ctrl+A", "Ctrl+C", "Ctrl+X", "Ctrl+V", "Ctrl+Z", "Ctrl+Y", "Ctrl+Home", "Ctrl+End",
        "Shift+Home", "Shift+End", "Shift+Left", "Shift+Right",
    };

    /// <summary>Parses "Ctrl+A" style text into an allow-listed chord (canonical order Ctrl, Shift), or explains why not.</summary>
    public static string? Parse(string? text, out Chord? chord)
    {
        chord = null;
        if (string.IsNullOrWhiteSpace(text) || text.Length > 32) return "keys must be a short chord such as \"Enter\" or \"Ctrl+A\"";
        var parts = text.Split('+', StringSplitOptions.TrimEntries);
        bool ctrl = false, shift = false; string? key = null;
        foreach (var p in parts)
        {
            if (p.Equals("Ctrl", StringComparison.OrdinalIgnoreCase) || p.Equals("Control", StringComparison.OrdinalIgnoreCase)) { if (ctrl) return "a modifier is repeated"; ctrl = true; }
            else if (p.Equals("Shift", StringComparison.OrdinalIgnoreCase)) { if (shift) return "a modifier is repeated"; shift = true; }
            else if (key == null && Keys.ContainsKey(p)) key = Keys.Keys.First(k => k.Equals(p, StringComparison.OrdinalIgnoreCase));
            else return $"'{(p.Length > 16 ? p[..16] : p)}' is not an allowed key";
        }
        if (key == null) return "the chord has no key";
        string canonical = (ctrl ? "Ctrl+" : "") + (shift ? "Shift+" : "") + key;
        if (!Allowed.Contains(canonical)) return $"{canonical} is not an allowed key chord";
        var mods = new List<ushort>(); if (ctrl) mods.Add(VK_CONTROL); if (shift) mods.Add(VK_SHIFT);
        chord = new Chord(canonical, mods, Keys[key]);
        return null;
    }
}

public static class TextRules
{
    /// <summary>Printable text only: no control characters (no Enter/Tab: those are explicit key chords), no lone surrogates.</summary>
    public static string? Validate(string? text, int maxLength)
    {
        if (string.IsNullOrEmpty(text)) return "text is required";
        if (text.Length > maxLength) return $"text is limited to {maxLength} characters";
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (char.IsControl(c)) return "text may not contain control characters (use desktop.press_keys for Enter or Tab)";
            if (char.IsHighSurrogate(c)) { if (i + 1 >= text.Length || !char.IsLowSurrogate(text[i + 1])) return "text contains an invalid character"; i++; continue; }
            if (char.IsLowSurrogate(c)) return "text contains an invalid character";
        }
        return null;
    }

    /// <summary>Verification of typing: the value after must be the value before with exactly the text inserted once.</summary>
    public static bool IsExactInsertion(string before, string after, string text)
    {
        if (after.Length != before.Length + text.Length) return false;
        for (int at = after.IndexOf(text, StringComparison.Ordinal); at >= 0; at = after.IndexOf(text, at + 1, StringComparison.Ordinal))
            if (string.Equals(after.Remove(at, text.Length), before, StringComparison.Ordinal)) return true;
        return false;
    }

    public static string Sha256(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s)));
}

/// <summary>One step of an input sequence: an atomic batch the injector sends with a single SendInput call.</summary>
public sealed record InputStep(string Label, IReadOnlyList<InputEvent> Events);

public abstract record InputEvent;
public sealed record MouseMoveTo(int X, int Y) : InputEvent;
public sealed record MouseLeft(bool Down) : InputEvent;
public sealed record UnicodeChar(char Unit, bool Down) : InputEvent;
public sealed record VirtualKey(ushort Vk, bool Down) : InputEvent;

/// <summary>Sends input to the OS. Implementations track nothing; <see cref="GuardedInputSequencer"/> tracks what is held.</summary>
public interface IInputInjector
{
    /// <summary>Sends the events in one call; returns how many the OS accepted.</summary>
    int Send(IReadOnlyList<InputEvent> events);
}

public sealed record SequenceOutcome(int StepsSent, int StepsTotal, string? AbortCode, string? AbortMessage, bool ReleaseNeeded, bool ReleaseSucceeded);

/// <summary>
/// Runs an input sequence step by step with a gate before every step, and releases anything still held in a finally path.
/// A step is an atomic batch (e.g. button down+up, or modifiers+key+release) so that a held state never spans a gate.
/// </summary>
public static class GuardedInputSequencer
{
    public static async Task<SequenceOutcome> RunAsync(IInputInjector injector, IReadOnlyList<InputStep> steps,
        Func<int, InputRefusal?> gate, int interStepDelayMs, Func<int, Task>? betweenStepsHook, CancellationToken ct)
    {
        var heldButtons = new HashSet<string>();
        var heldKeys = new HashSet<ushort>();
        int sent = 0;
        string? code = null, msg = null;
        bool releaseNeeded = false, releaseOk = true;
        try
        {
            for (int i = 0; i < steps.Count; i++)
            {
                if (i > 0)
                {
                    if (betweenStepsHook != null) await betweenStepsHook(i);
                    if (interStepDelayMs > 0) { try { await Task.Delay(interStepDelayMs, ct); } catch (OperationCanceledException) { code = "cancelled"; msg = "The request was cancelled during the action."; break; } }
                }
                if (gate(i) is { } refusal) { code = refusal.Code; msg = refusal.Message; break; }
                var evs = steps[i].Events;
                int accepted = injector.Send(evs);
                for (int k = 0; k < Math.Min(accepted, evs.Count); k++) Track(evs[k], heldButtons, heldKeys);
                if (accepted != evs.Count) { code = "input_blocked"; msg = $"Windows accepted {accepted} of {evs.Count} input events (blocked by another program or a higher-integrity window)."; break; }
                sent++;
            }
        }
        finally
        {
            if (heldButtons.Count > 0 || heldKeys.Count > 0)
            {
                releaseNeeded = true;
                var release = new List<InputEvent>();
                if (heldButtons.Contains("left")) release.Add(new MouseLeft(false));
                foreach (var vk in heldKeys) release.Add(new VirtualKey(vk, false));
                try { releaseOk = injector.Send(release) == release.Count; } catch { releaseOk = false; }
            }
        }
        return new SequenceOutcome(sent, steps.Count, code, msg, releaseNeeded, releaseOk);
    }

    private static void Track(InputEvent e, HashSet<string> buttons, HashSet<ushort> keys)
    {
        switch (e)
        {
            case MouseLeft { Down: true }: buttons.Add("left"); break;
            case MouseLeft { Down: false }: buttons.Remove("left"); break;
            case VirtualKey { Down: true } k: keys.Add(k.Vk); break;
            case VirtualKey { Down: false } k: keys.Remove(k.Vk); break;
        }
    }

    public static IReadOnlyList<InputStep> Click((int X, int Y) at) => new[]
    {
        new InputStep("move", new InputEvent[] { new MouseMoveTo(at.X, at.Y) }),
        new InputStep("click", new InputEvent[] { new MouseLeft(true), new MouseLeft(false) }),
    };

    public static IReadOnlyList<InputStep> Type(string text)
    {
        var steps = new List<InputStep>();
        for (int i = 0; i < text.Length; i++)
        {
            if (char.IsHighSurrogate(text[i]) && i + 1 < text.Length)
            {
                steps.Add(new InputStep("char", new InputEvent[] { new UnicodeChar(text[i], true), new UnicodeChar(text[i + 1], true), new UnicodeChar(text[i], false), new UnicodeChar(text[i + 1], false) }));
                i++;
            }
            else steps.Add(new InputStep("char", new InputEvent[] { new UnicodeChar(text[i], true), new UnicodeChar(text[i], false) }));
        }
        return steps;
    }

    public static IReadOnlyList<InputStep> Chord(KeyChords.Chord chord)
    {
        var evs = new List<InputEvent>();
        foreach (var m in chord.Modifiers) evs.Add(new VirtualKey(m, true));
        evs.Add(new VirtualKey(chord.Key, true));
        evs.Add(new VirtualKey(chord.Key, false));
        for (int i = chord.Modifiers.Count - 1; i >= 0; i--) evs.Add(new VirtualKey(chord.Modifiers[i], false));
        return new[] { new InputStep("chord", evs) };
    }
}
