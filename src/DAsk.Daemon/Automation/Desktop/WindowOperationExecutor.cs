using System.Runtime.InteropServices;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;

namespace DAsk.Daemon.Automation.Desktop;

/// <summary>What one executor call did: which Win32 API was called and what it returned. Never "success" by itself:
/// success is decided only by an independent observation afterwards (<see cref="WindowOperationVerifier"/>).</summary>
public sealed record WindowOperationAttempt(string Api, bool Called, bool ApiResult, int LastError);

/// <summary>
/// Phase 7B.3 P0: performs exactly one window operation on exactly one window, with one Win32 call. It sends no
/// keyboard or mouse input, starts or ends no process, and touches no other window. It is only ever called by
/// <see cref="DesktopActionRequestService"/> after an approval was consumed and every gate passed.
/// </summary>
public interface IWindowOperationExecutor
{
    WindowOperationAttempt Apply(long hwnd, string actionType, string? state);
}

public sealed class Win32WindowOperationExecutor : IWindowOperationExecutor
{
    private const int SW_MAXIMIZE = 3, SW_MINIMIZE = 6, SW_RESTORE = 9;

    [DllImport("user32.dll", SetLastError = true)] private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetForegroundWindow(IntPtr hWnd);

    public WindowOperationAttempt Apply(long hwnd, string actionType, string? state)
    {
        var h = new IntPtr(hwnd);
        if (actionType == DesktopActionTypes.FocusWindow)
        {
            // Subject to Windows' foreground rules: it can be refused. The verifier reports that honestly.
            bool ok = SetForegroundWindow(h);
            return new WindowOperationAttempt("SetForegroundWindow", true, ok, ok ? 0 : Marshal.GetLastWin32Error());
        }
        if (actionType == DesktopActionTypes.SetWindowState)
        {
            int cmd = state switch { "minimize" => SW_MINIMIZE, "maximize" => SW_MAXIMIZE, "restore" => SW_RESTORE, _ => -1 };
            if (cmd < 0) return new WindowOperationAttempt("none", false, false, 0);
            // Async: a hung target cannot block the daemon. The return value only says the request was posted.
            bool ok = ShowWindowAsync(h, cmd);
            return new WindowOperationAttempt($"ShowWindowAsync({state})", true, ok, ok ? 0 : Marshal.GetLastWin32Error());
        }
        return new WindowOperationAttempt("none", false, false, 0);
    }
}

/// <summary>Pure: whether a fresh observation shows the approved result, on the same window.</summary>
public static class WindowOperationVerifier
{
    public static (bool Verified, string Observed) Check(string actionType, string? state, WindowIdentity approvedTarget, WindowIdentity? now)
    {
        if (now == null) return (false, "the window no longer exists");
        if (WindowIdentityRules.Mismatch(approvedTarget, now) is { } changed) return (false, $"the window is no longer the approved one ({changed})");
        string observed = $"minimized={now.Minimized}, maximized={now.Maximized}, foreground={now.Foreground}";
        bool ok = (actionType, state) switch
        {
            (DesktopActionTypes.FocusWindow, _) => now.Foreground,
            (DesktopActionTypes.SetWindowState, "minimize") => now.Minimized,
            (DesktopActionTypes.SetWindowState, "maximize") => now.Maximized && !now.Minimized,
            (DesktopActionTypes.SetWindowState, "restore") => !now.Minimized && !now.Maximized,
            _ => false,
        };
        return (ok, observed);
    }
}
