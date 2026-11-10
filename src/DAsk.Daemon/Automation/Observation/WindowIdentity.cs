using System.Runtime.InteropServices;
using System.Text;
using DAsk.Daemon.IPC;

namespace DAsk.Daemon.Automation.Observation;

/// <summary>
/// Phase 7B.1b: the identity of one top-level window, read from the operating system only. HWND alone is never an
/// identity: a handle value can be reused. The mandatory fields together (HWND, PID, process creation time, canonical
/// image path, window class, logon session) identify one window of one process instance.
/// </summary>
public sealed record WindowIdentity
{
    public required long Hwnd { get; init; }
    public required int ProcessId { get; init; }
    public required int ThreadId { get; init; }
    /// <summary>FILETIME (UTC) of the owning process's creation; distinguishes a reused PID.</summary>
    public required long ProcessCreationFileTime { get; init; }
    public required string ImagePath { get; init; }
    public required string WindowClass { get; init; }
    public required uint SessionId { get; init; }
    public required string Title { get; init; }
    public required bool Visible { get; init; }
    public required bool Minimized { get; init; }
    public required bool Maximized { get; init; }
    public required bool Foreground { get; init; }
    /// <summary>Physical pixels (the daemon is Per-Monitor V2 DPI aware): left, top, right, bottom.</summary>
    public required int[] Bounds { get; init; }
    public required string DisplayDevice { get; init; }
    public required int DisplayIndex { get; init; }
    public required bool DisplayIsPrimary { get; init; }
    /// <summary>Effective DPI of the display containing the window (GetDpiForMonitor), not the window's own.</summary>
    public required uint Dpi { get; init; }
    /// <summary>The DPI the window itself runs at (GetDpiForWindow). 96 on a scaled display means a DPI-unaware window
    /// that Windows stretches; its UI Automation and window bounds are still reported in physical pixels.</summary>
    public uint WindowDpi { get; init; }

    public string ImageName => Path.GetFileName(ImagePath);
}

public static class WindowIdentityRules
{
    /// <summary>Why a candidate identity is incomplete, or null. Zero or missing mandatory fields are never accepted.</summary>
    public static string? Incomplete(WindowIdentity w)
    {
        if (w.Hwnd == 0) return "window handle is zero";
        if (w.ProcessId == 0) return "process id is zero";
        if (w.ProcessCreationFileTime == 0) return "process creation time unavailable";
        if (string.IsNullOrWhiteSpace(w.ImagePath)) return "process image path unavailable";
        if (string.IsNullOrWhiteSpace(w.WindowClass)) return "window class unavailable";
        if (w.SessionId == uint.MaxValue) return "logon session unavailable";
        return null;
    }

    /// <summary>
    /// Whether <paramref name="current"/> (re-read from the OS now) is the same window as <paramref name="expected"/>.
    /// A different PID, creation time, image or class means the handle was reused or the process replaced. The title is
    /// not part of identity (applications change it), so a title change is reported separately, not as a mismatch.
    /// </summary>
    public static string? Mismatch(WindowIdentity expected, WindowIdentity? current)
    {
        if (current == null) return "the window no longer exists";
        if (Incomplete(current) is { } why) return $"identity can no longer be established ({why})";
        if (current.Hwnd != expected.Hwnd) return "a different window handle";
        if (current.ProcessId != expected.ProcessId) return "the window handle now belongs to a different process (handle reused)";
        if (current.ProcessCreationFileTime != expected.ProcessCreationFileTime) return "the owning process was replaced (process id reused)";
        if (!string.Equals(current.ImagePath, expected.ImagePath, StringComparison.OrdinalIgnoreCase)) return "the owning process image changed";
        if (!string.Equals(current.WindowClass, expected.WindowClass, StringComparison.Ordinal)) return "the window class changed (handle reused)";
        if (current.ThreadId != expected.ThreadId) return "the owning thread changed (handle reused)";
        return null;
    }
}

/// <summary>Reads windows from the OS. Abstracted so identity rules can be tested without real windows.</summary>
public interface IWindowSource
{
    /// <summary>Top-level, visible, uncloaked, unowned application windows of this logon session.</summary>
    IReadOnlyList<WindowIdentity> Enumerate(out int excludedIncomplete);
    /// <summary>The window's identity re-read now, or null if the window no longer exists.</summary>
    WindowIdentity? Read(long hwnd);
}

/// <summary>Native implementation (EnumWindows and friends). Read-only: no window or process is ever changed.</summary>
public sealed class Win32WindowSource : IWindowSource
{
    /// <summary>Window bounds are read Per-Monitor-V2 aware so they are physical pixels in any hosting process.</summary>
    private static T PhysicalPixels<T>(Func<T> read)
    {
        IntPtr old = IntPtr.Zero;
        try { old = N.SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        try { return read(); }
        finally { if (old != IntPtr.Zero) N.SetThreadDpiAwarenessContext(old); }
    }

    public IReadOnlyList<WindowIdentity> Enumerate(out int excludedIncomplete)
    {
        int inc = 0;
        var result = PhysicalPixels(() => EnumerateCore(out inc));
        excludedIncomplete = inc;
        return result;
    }

    private IReadOnlyList<WindowIdentity> EnumerateCore(out int excludedIncomplete)
    {
        var handles = new List<IntPtr>();
        N.EnumWindows((h, _) => { handles.Add(h); return true; }, IntPtr.Zero);
        var displays = Displays();
        uint mySession = N.ProcessIdToSessionId((uint)Environment.ProcessId, out uint s) ? s : uint.MaxValue;
        var list = new List<WindowIdentity>();
        int incomplete = 0;
        foreach (var h in handles)
        {
            if (!IsApplicationWindow(h)) continue;
            var w = ReadCore(h, displays);
            if (w == null) continue;
            if (w.SessionId != mySession && w.SessionId != uint.MaxValue) continue; // another logon session is never observed
            if (WindowIdentityRules.Incomplete(w) != null) { incomplete++; continue; }
            list.Add(w);
        }
        excludedIncomplete = incomplete;
        return list;
    }

    public WindowIdentity? Read(long hwnd)
    {
        var h = new IntPtr(hwnd);
        if (hwnd == 0 || !N.IsWindow(h)) return null;
        return PhysicalPixels(() => ReadCore(h, Displays()));
    }

    private static bool IsApplicationWindow(IntPtr h)
    {
        if (!N.IsWindowVisible(h)) return false;
        if (N.GetWindow(h, 4 /* GW_OWNER */) != IntPtr.Zero) return false;
        long ex = N.GetWindowLongPtr(h, -20).ToInt64();
        const long WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000;
        if ((ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0) return false;
        if (N.DwmGetWindowAttribute(h, 14 /* DWMWA_CLOAKED */, out int cloaked, sizeof(int)) == 0 && cloaked != 0) return false;
        return N.GetWindowTextLength(h) > 0;
    }

    private sealed record Display(IntPtr Handle, string Device, int Index, bool Primary);

    private static List<Display> Displays()
    {
        var list = new List<Display>();
        N.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hm, IntPtr hdc, ref N.RECT r, IntPtr d) =>
        {
            var mi = new N.MONITORINFOEX { cbSize = Marshal.SizeOf<N.MONITORINFOEX>() };
            if (N.GetMonitorInfo(hm, ref mi)) list.Add(new Display(hm, mi.szDevice ?? string.Empty, list.Count, (mi.dwFlags & 1) != 0));
            return true;
        }, IntPtr.Zero);
        return list;
    }

    private static WindowIdentity? ReadCore(IntPtr h, List<Display> displays)
    {
        uint tid = N.GetWindowThreadProcessId(h, out uint pid);
        if (tid == 0) return null;

        long created = 0;
        string image = string.Empty;
        IntPtr proc = N.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (proc != IntPtr.Zero)
        {
            try
            {
                if (N.GetProcessTimes(proc, out long c, out _, out _, out _)) created = c;
                var sb = new StringBuilder(1024);
                uint size = (uint)sb.Capacity;
                if (N.QueryFullProcessImageNameW(proc, 0, sb, ref size))
                    image = PipePeerNative.TryCanonicalizePath(sb.ToString()) ?? sb.ToString();
            }
            finally { N.CloseHandle(proc); }
        }
        uint session = N.ProcessIdToSessionId(pid, out uint ps) ? ps : uint.MaxValue;

        var cls = new StringBuilder(256);
        N.GetClassName(h, cls, cls.Capacity);
        int len = Math.Min(N.GetWindowTextLength(h), 1024);
        var title = new StringBuilder(len + 1);
        N.GetWindowText(h, title, title.Capacity);

        if (N.DwmGetWindowAttribute(h, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out N.RECT rect, Marshal.SizeOf<N.RECT>()) != 0)
            N.GetWindowRect(h, out rect);
        IntPtr monitor = N.MonitorFromWindow(h, 2 /* MONITOR_DEFAULTTONEAREST */);
        var display = displays.FirstOrDefault(d => d.Handle == monitor);
        uint windowDpi = 0, dpi = 0;
        try { windowDpi = N.GetDpiForWindow(h); } catch { }
        try { if (N.GetDpiForMonitor(monitor, 0 /* MDT_EFFECTIVE_DPI */, out uint dx, out _) == 0) dpi = dx; } catch { }
        if (dpi == 0) dpi = windowDpi;

        return new WindowIdentity
        {
            Hwnd = h.ToInt64(),
            ProcessId = (int)pid,
            ThreadId = (int)tid,
            ProcessCreationFileTime = created,
            ImagePath = image,
            WindowClass = cls.ToString(),
            SessionId = session,
            Title = title.ToString(),
            Visible = N.IsWindowVisible(h),
            Minimized = N.IsIconic(h),
            Maximized = N.IsZoomed(h),
            Foreground = N.GetForegroundWindow() == h,
            Bounds = new[] { rect.Left, rect.Top, rect.Right, rect.Bottom },
            DisplayDevice = display?.Device ?? string.Empty,
            DisplayIndex = display?.Index ?? -1,
            DisplayIsPrimary = display?.Primary ?? false,
            Dpi = dpi == 0 ? 96 : dpi,
            WindowDpi = windowDpi == 0 ? 96 : windowDpi,
        };
    }

    private static class N
    {
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        public struct MONITORINFOEX
        {
            public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
        }
        public delegate bool EnumProc(IntPtr h, IntPtr l);
        public delegate bool MonitorProc(IntPtr hm, IntPtr hdc, ref RECT r, IntPtr d);

        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr hm, ref MONITORINFOEX mi);
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorProc f, IntPtr d);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmonitor, int type, out uint dpiX, out uint dpiY);
        [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll")] public static extern bool GetProcessTimes(IntPtr p, out long c, out long e, out long k, out long u);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr p, uint f, StringBuilder s, ref uint n);
        [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
    }
}
