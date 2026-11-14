using System.Runtime.InteropServices;
using DAsk.Daemon.Automation.Observation;

namespace DAsk.Daemon.Automation.Input;

/// <summary>A running low-level input monitor (D-4). <see cref="Interruption"/> becomes non-null on foreign input.</summary>
public interface IUserInputMonitor : IDisposable
{
    string? Interruption { get; }
}

/// <summary>Everything guarded input needs from the OS, behind one interface so the pathway can be tested with fakes.</summary>
public interface IDesktopInputPlatform
{
    IInputInjector Injector { get; }
    /// <summary>Starts the D-4 monitor; throws if it cannot be installed (then no multi-event input may run).</summary>
    IUserInputMonitor StartMonitor();
    long ForegroundRoot();
    bool BringToForeground(long hwnd);
    (int X, int Y)? CursorPos();
    long RootWindowAt(int x, int y);
    int[]? RuntimeIdAt(int x, int y);
    int[]? FocusedRuntimeId();
    bool FocusElement(long hwnd, int[] runtimeId);
    /// <summary>Reads the element's ValuePattern. Used only to verify typing; never logged or returned to the agent.</summary>
    (bool Ok, string Value, bool ReadOnly) ReadValue(long hwnd, int[] runtimeId);
    /// <summary>Whether a popup menu (class #32768) is visible: the observable effect of a right click on most controls.</summary>
    bool MenuOpen() => false;
    /// <summary>The selected text of a TextPattern control (null: no TextPattern / unreadable). Used only to verify, never logged.</summary>
    string? ReadSelection(long hwnd, int[] runtimeId) => null;
    /// <summary>Selects all text (<paramref name="text"/> null) or the first exact occurrence of <paramref name="text"/> through TextPattern.
    /// No input is injected. Returns false when the control has no TextPattern or the text is not found.</summary>
    bool SelectText(long hwnd, int[] runtimeId, string? text) => false;
    /// <summary>The root window that is in front plus its process id (to recognise a NEW window opened by a double click).</summary>
    (long Hwnd, int Pid) ForegroundInfo() => (ForegroundRoot(), 0);
    /// <summary>Whether the element under the point IS the control or lies inside it (a button's own text, a list item's text block).
    /// Default: exact element only.</summary>
    bool PointIsOnControl(long hwnd, int x, int y, int[] runtimeId) => RuntimeIdAt(x, y) is { } h && h.AsSpan().SequenceEqual(runtimeId);
    /// <summary>How many visible top-level windows the process has (a context menu or popup is usually one more).</summary>
    int VisibleWindowsOf(int pid) => 0;
}

/// <summary>The real platform: SendInput, low-level hooks, Win32 window queries and UI Automation (COM).</summary>
public sealed class Win32DesktopInputPlatform : IDesktopInputPlatform
{
    /// <summary>dwExtraInfo on every event D-ASK injects ("DASK"), so the monitor can tell them from anything else.</summary>
    internal static readonly IntPtr Marker = new(0x4441534B);

    public IInputInjector Injector { get; } = new Win32InputInjector();
    public IUserInputMonitor StartMonitor() => LowLevelInputMonitor.Start();

    public long ForegroundRoot() { var f = N.GetForegroundWindow(); return f == IntPtr.Zero ? 0 : N.GetAncestor(f, 2).ToInt64(); }
    public bool BringToForeground(long hwnd) => N.SetForegroundWindow(new IntPtr(hwnd));
    public (int X, int Y)? CursorPos() => N.GetCursorPos(out var p) ? (p.X, p.Y) : null;
    public long RootWindowAt(int x, int y) { var w = N.WindowFromPoint(new N.POINT { X = x, Y = y }); return w == IntPtr.Zero ? 0 : N.GetAncestor(w, 2).ToInt64(); }

    public int[]? RuntimeIdAt(int x, int y) => WithUia(uia =>
    {
        long pt = (uint)x | ((long)y << 32);
        if (uia.ElementFromPoint(pt, out var el) != 0 || el == null) return null;
        try { return RuntimeId(el); } finally { Marshal.ReleaseComObject(el); }
    });

    public int[]? FocusedRuntimeId() => WithUia(uia =>
    {
        if (uia.GetFocusedElement(out var el) != 0 || el == null) return null;
        try { return RuntimeId(el); } finally { Marshal.ReleaseComObject(el); }
    });

    public bool FocusElement(long hwnd, int[] runtimeId) => WithUia(uia => WithElement(uia, hwnd, runtimeId, el => ((IUiaElementFull)el).SetFocus() == 0)) ;

    public (bool Ok, string Value, bool ReadOnly) ReadValue(long hwnd, int[] runtimeId) => WithUia(uia => WithElement(uia, hwnd, runtimeId, el =>
    {
        var full = (IUiaElementFull)el;
        if (full.GetCurrentPattern(UIA_ValuePatternId, out var pat) != 0 || pat == null) return (false, "", true);
        try
        {
            var vp = (IUiaValuePattern)pat;
            if (vp.get_CurrentValue(out var v) != 0) return (false, "", true);
            vp.get_CurrentIsReadOnly(out int ro);
            return (true, v ?? "", ro != 0);
        }
        finally { Marshal.ReleaseComObject(pat); }
    }));

    public bool MenuOpen()
    {
        var m = N.FindWindow("#32768", null);
        return m != IntPtr.Zero && N.IsWindowVisible(m);
    }

    public (long Hwnd, int Pid) ForegroundInfo()
    {
        var f = N.GetForegroundWindow();
        if (f == IntPtr.Zero) return (0, 0);
        var root = N.GetAncestor(f, 2);
        N.GetWindowThreadProcessId(root, out uint pid);
        return (root.ToInt64(), (int)pid);
    }

    /// <summary>The hit element must be the approved control or an element in its subtree (found from the control, by runtime id).</summary>
    public bool PointIsOnControl(long hwnd, int x, int y, int[] runtimeId) => WithUia(uia =>
    {
        var hit = RuntimeIdAtWith(uia, x, y);
        if (hit == null) return false;
        if (hit.AsSpan().SequenceEqual(runtimeId)) return true;
        return WithElement(uia, hwnd, runtimeId, ctl =>
        {
            IntPtr cond = IntPtr.Zero; IUIAutomationElementArray? all = null;
            try
            {
                if (uia.CreateTrueCondition(out cond) != 0 || cond == IntPtr.Zero) return false;
                if (ctl.FindAll(TreeScope.TreeScope_Descendants, cond, out all) != 0 || all == null) return false;
                all.get_Length(out int n);
                for (int i = 0; i < Math.Min(n, 500); i++)
                {
                    if (all.GetElement(i, out var el) != 0 || el == null) continue;
                    try { if (RuntimeId(el) is { } rid && rid.AsSpan().SequenceEqual(hit)) return true; }
                    finally { Marshal.ReleaseComObject(el); }
                }
                return false;
            }
            finally { if (all != null) Marshal.ReleaseComObject(all); if (cond != IntPtr.Zero) Marshal.Release(cond); }
        });
    });

    private static int[]? RuntimeIdAtWith(IUIAutomation uia, int x, int y)
    {
        long pt = (uint)x | ((long)y << 32);
        if (uia.ElementFromPoint(pt, out var el) != 0 || el == null) return null;
        try { return RuntimeId(el); } finally { Marshal.ReleaseComObject(el); }
    }

    public int VisibleWindowsOf(int pid)
    {
        int n = 0;
        N.EnumWindows((h, _) => { N.GetWindowThreadProcessId(h, out uint p); if (p == (uint)pid && N.IsWindowVisible(h)) n++; return true; }, IntPtr.Zero);
        return n;
    }

    public string? ReadSelection(long hwnd, int[] runtimeId) => WithUia(uia => WithElement(uia, hwnd, runtimeId, el =>
    {
        var tp = TextPatternOf(el);
        if (tp == null) return null;
        try
        {
            if (tp.GetSelection(out var arr) != 0 || arr == null) return null;
            try
            {
                arr.get_Length(out int n);
                var sb = new System.Text.StringBuilder();
                for (int i = 0; i < n && i < 16; i++)
                {
                    if (arr.GetElement(i, out var r) != 0 || r == null) continue;
                    try { if (r.GetText(100_000, out var t) == 0) sb.Append(t); } finally { Marshal.ReleaseComObject(r); }
                }
                return sb.ToString();
            }
            finally { Marshal.ReleaseComObject(arr); }
        }
        finally { Marshal.ReleaseComObject(tp); }
    }));

    public bool SelectText(long hwnd, int[] runtimeId, string? text) => WithUia(uia => WithElement(uia, hwnd, runtimeId, el =>
    {
        var tp = TextPatternOf(el);
        if (tp == null) return false;
        try
        {
            if (tp.get_DocumentRange(out var doc) != 0 || doc == null) return false;
            try
            {
                if (text == null) return doc.Select() == 0;
                if (doc.FindText(text, 0, 0, out var hit) != 0 || hit == null) return false;
                try { return hit.Select() == 0; } finally { Marshal.ReleaseComObject(hit); }
            }
            finally { Marshal.ReleaseComObject(doc); }
        }
        finally { Marshal.ReleaseComObject(tp); }
    }));

    private const int UIA_TextPatternId = 10014;
    private static IUiaTextPattern? TextPatternOf(IUIAutomationElement el)
    {
        if (((IUiaElementFull)el).GetCurrentPattern(UIA_TextPatternId, out var pat) != 0 || pat == null) return null;
        return pat as IUiaTextPattern;
    }

    // ── UIA helpers ──────────────────────────────────────────────────────────
    private const int UIA_RuntimeIdPropertyId = 30000;
    private const int UIA_ValuePatternId = 10002;

    private static T WithUia<T>(Func<IUIAutomation, T> f)
    {
        IUIAutomation? uia = null;
        try { uia = (IUIAutomation)new CUIAutomation(); return f(uia); }
        catch (COMException) { return default!; }
        catch (InvalidCastException) { return default!; }
        finally { if (uia != null && Marshal.IsComObject(uia)) Marshal.ReleaseComObject(uia); }
    }

    private static int[]? RuntimeId(IUIAutomationElement el) =>
        el.GetCurrentPropertyValue(UIA_RuntimeIdPropertyId, out var v) == 0 ? v as int[] : null;

    /// <summary>Finds the element with this runtime id under the window and runs <paramref name="f"/> on it.</summary>
    private static T WithElement<T>(IUIAutomation uia, long hwnd, int[] runtimeId, Func<IUIAutomationElement, T> f)
    {
        if (uia.ElementFromHandle(new IntPtr(hwnd), out var root) != 0 || root == null) return default!;
        IntPtr cond = IntPtr.Zero;
        IUIAutomationElementArray? all = null;
        try
        {
            if (uia.CreateTrueCondition(out cond) != 0 || cond == IntPtr.Zero) return default!;
            if (root.FindAll(TreeScope.TreeScope_Descendants, cond, out all) != 0 || all == null) return default!;
            all.get_Length(out int n);
            for (int i = 0; i < Math.Min(n, 2000); i++)
            {
                if (all.GetElement(i, out var el) != 0 || el == null) continue;
                try { if (RuntimeId(el) is { } rid && rid.AsSpan().SequenceEqual(runtimeId)) return f(el); }
                finally { Marshal.ReleaseComObject(el); }
            }
            return default!;
        }
        finally
        {
            if (all != null) Marshal.ReleaseComObject(all);
            if (cond != IntPtr.Zero) Marshal.Release(cond);
            Marshal.ReleaseComObject(root);
        }
    }

    internal static class N
    {
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string? cls, string? title);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        public delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    }
}

/// <summary>SendInput with absolute virtual-desktop coordinates, Unicode characters and virtual keys.</summary>
internal sealed class Win32InputInjector : IInputInjector
{
    private const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004, MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x01000;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion u; }

    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int i);

    private static bool Extended(ushort vk) => vk is >= 0x21 and <= 0x28 or 0x2D or 0x2E;

    public int Send(IReadOnlyList<InputEvent> events)
    {
        if (events.Count == 0) return 0;
        var arr = new INPUT[events.Count];
        for (int i = 0; i < events.Count; i++) arr[i] = Build(events[i]);
        return (int)SendInput((uint)arr.Length, arr, Marshal.SizeOf<INPUT>());
    }

    private static INPUT Build(InputEvent e)
    {
        var x = Win32DesktopInputPlatform.Marker;
        switch (e)
        {
            case MouseMoveTo m:
            {
                int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = Math.Max(2, GetSystemMetrics(78)), vh = Math.Max(2, GetSystemMetrics(79));
                int nx = (int)Math.Round((m.X - vx) * 65535.0 / (vw - 1)), ny = (int)Math.Round((m.Y - vy) * 65535.0 / (vh - 1));
                return new INPUT { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { dx = nx, dy = ny, dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, dwExtraInfo = x } } };
            }
            case MouseLeft b:
                return new INPUT { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { dwFlags = b.Down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP, dwExtraInfo = x } } };
            case MouseRight b:
                return new INPUT { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { dwFlags = b.Down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP, dwExtraInfo = x } } };
            case MouseWheel w:
                return new INPUT { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { mouseData = unchecked((uint)w.Delta), dwFlags = w.Horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, dwExtraInfo = x } } };
            case UnicodeChar c:
                return new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c.Unit, dwFlags = KEYEVENTF_UNICODE | (c.Down ? 0 : KEYEVENTF_KEYUP), dwExtraInfo = x } } };
            case VirtualKey k:
                return new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = k.Vk, dwFlags = (Extended(k.Vk) ? KEYEVENTF_EXTENDEDKEY : 0) | (k.Down ? 0 : KEYEVENTF_KEYUP), dwExtraInfo = x } } };
            default:
                throw new ArgumentException("unknown input event");
        }
    }
}

/// <summary>
/// D-4: a daemon-owned second stop path while input runs. Low-level keyboard and mouse hooks on a dedicated message-loop
/// thread. Any event that is not one of D-ASK's own (physical input by the user, or input injected by another program)
/// sets <see cref="Interruption"/>, and the per-event gate stops the sequence. Installed only for one execution.
/// </summary>
internal sealed class LowLevelInputMonitor : IUserInputMonitor
{
    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] private struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct MSLLHOOKSTRUCT { public int x, y; public uint mouseData, flags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr hMod, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? name);

    private const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
    private const uint LLKHF_INJECTED = 0x10, LLMHF_INJECTED = 0x01, WM_QUIT = 0x0012;

    private readonly HookProc _kb, _ms;   // kept alive for the hooks' lifetime
    private IntPtr _kbHook, _msHook;
    private uint _threadId;
    private Thread? _thread;
    private volatile string? _interruption;
    public string? Interruption => _interruption;

    private LowLevelInputMonitor() { _kb = OnKeyboard; _ms = OnMouse; }

    public static LowLevelInputMonitor Start()
    {
        var m = new LowLevelInputMonitor();
        var ready = new ManualResetEventSlim();
        string? error = null;
        m._thread = new Thread(() =>
        {
            m._threadId = GetCurrentThreadId();
            var mod = GetModuleHandle(null);
            m._kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, m._kb, mod, 0);
            m._msHook = SetWindowsHookEx(WH_MOUSE_LL, m._ms, mod, 0);
            if (m._kbHook == IntPtr.Zero || m._msHook == IntPtr.Zero) error = $"low-level hooks could not be installed (Win32 error {Marshal.GetLastWin32Error()})";
            ready.Set();
            if (error != null) return;
            while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0) { }
        }) { IsBackground = true, Name = "DASK-InputMonitor" };
        m._thread.Start();
        if (!ready.Wait(3000)) error ??= "the input monitor did not start";
        if (error != null) { m.Dispose(); throw new InvalidOperationException(error); }
        return m;
    }

    private IntPtr OnKeyboard(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0)
        {
            var k = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(l);
            if ((k.flags & LLKHF_INJECTED) == 0) _interruption ??= "you pressed a key";
            else if (k.dwExtraInfo != Win32DesktopInputPlatform.Marker) _interruption ??= "another program sent keyboard input";
        }
        return CallNextHookEx(_kbHook, code, w, l);
    }

    private IntPtr OnMouse(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0)
        {
            var m = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(l);
            if ((m.flags & LLMHF_INJECTED) == 0) _interruption ??= $"you used the mouse (message 0x{w.ToInt64():X}, flags 0x{m.flags:X})";
            else if (m.dwExtraInfo != Win32DesktopInputPlatform.Marker) _interruption ??= "another program sent mouse input";
        }
        return CallNextHookEx(_msHook, code, w, l);
    }

    public void Dispose()
    {
        if (_kbHook != IntPtr.Zero) { UnhookWindowsHookEx(_kbHook); _kbHook = IntPtr.Zero; }
        if (_msHook != IntPtr.Zero) { UnhookWindowsHookEx(_msHook); _msHook = IntPtr.Zero; }
        if (_threadId != 0) PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        _thread?.Join(1000);
    }
}

// ── COM declarations with the full vtable prefix needed here (same IIDs as the observation service's subsets) ──

[ComImport]
[Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUiaElementFull
{
    [PreserveSig] int SetFocus();
    [PreserveSig] int GetRuntimeId(out IntPtr runtimeId);
    [PreserveSig] int FindFirst(TreeScope scope, IntPtr condition, out IUIAutomationElement found);
    [PreserveSig] int FindAll(TreeScope scope, IntPtr condition, out IUIAutomationElementArray found);
    [PreserveSig] int FindFirstBuildCache(TreeScope scope, IntPtr condition, IntPtr cacheRequest, out IUIAutomationElement found);
    [PreserveSig] int FindAllBuildCache(TreeScope scope, IntPtr condition, IntPtr cacheRequest, out IUIAutomationElementArray found);
    [PreserveSig] int BuildUpdatedCache(IntPtr cacheRequest, out IUIAutomationElement updatedElement);
    [PreserveSig] int GetCurrentPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object retVal);
    [PreserveSig] int GetCurrentPropertyValueEx(int propertyId, int ignoreDefaultValue, [MarshalAs(UnmanagedType.Struct)] out object retVal);
    [PreserveSig] int GetCachedPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object retVal);
    [PreserveSig] int GetCachedPropertyValueEx(int propertyId, int ignoreDefaultValue, [MarshalAs(UnmanagedType.Struct)] out object retVal);
    [PreserveSig] int GetCurrentPatternAs(int patternId, ref Guid riid, out IntPtr patternObject);
    [PreserveSig] int GetCachedPatternAs(int patternId, ref Guid riid, out IntPtr patternObject);
    [PreserveSig] int GetCurrentPattern(int patternId, [MarshalAs(UnmanagedType.IUnknown)] out object patternObject);
}

[ComImport]
[Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUiaValuePattern
{
    [PreserveSig] int SetValue([MarshalAs(UnmanagedType.BStr)] string val);
    [PreserveSig] int get_CurrentValue([MarshalAs(UnmanagedType.BStr)] out string retVal);
    [PreserveSig] int get_CurrentIsReadOnly(out int retVal);
}

// UI Automation TextPattern (selection by pattern call, no synthetic input). Only the slots called are typed; the others are
// placeholders that keep the vtable order (they are never called).
[ComImport]
[Guid("32eba289-3583-42c9-9c59-3b6d9a1e9b6a")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUiaTextPattern
{
    [PreserveSig] int RangeFromPoint_Unused();
    [PreserveSig] int RangeFromChild_Unused();
    [PreserveSig] int GetSelection(out IUiaTextRangeArray ranges);
    [PreserveSig] int GetVisibleRanges(out IUiaTextRangeArray ranges);
    [PreserveSig] int get_DocumentRange(out IUiaTextRange range);
}

[ComImport]
[Guid("ce4ae76a-e717-4c98-81ea-47371d028eb6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUiaTextRangeArray
{
    [PreserveSig] int get_Length(out int length);
    [PreserveSig] int GetElement(int index, out IUiaTextRange element);
}

[ComImport]
[Guid("a543cc6a-f4ae-494b-8239-c814481187a8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUiaTextRange
{
    [PreserveSig] int Clone_Unused();
    [PreserveSig] int Compare_Unused();
    [PreserveSig] int CompareEndpoints_Unused();
    [PreserveSig] int ExpandToEnclosingUnit_Unused();
    [PreserveSig] int FindAttribute_Unused();
    [PreserveSig] int FindText([MarshalAs(UnmanagedType.BStr)] string text, int backward, int ignoreCase, out IUiaTextRange found);
    [PreserveSig] int GetAttributeValue_Unused();
    [PreserveSig] int GetBoundingRectangles_Unused();
    [PreserveSig] int GetEnclosingElement_Unused();
    [PreserveSig] int GetText(int maxLength, [MarshalAs(UnmanagedType.BStr)] out string text);
    [PreserveSig] int Move_Unused();
    [PreserveSig] int MoveEndpointByUnit_Unused();
    [PreserveSig] int MoveEndpointByRange_Unused();
    [PreserveSig] int Select();
}
