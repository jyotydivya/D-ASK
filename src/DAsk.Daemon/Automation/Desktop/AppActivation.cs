using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DAsk.Daemon.Automation.Desktop;

/// <summary>How the daemon starts a discovered application. Returns the started process id when Windows reports one.</summary>
public interface IAppActivator
{
    /// <summary>
    /// Starts an installed application exactly as Windows registers it. A desktop program is started with CreateProcess (no shell, no
    /// command interpreter) and only the arguments its own Start-menu shortcut carries. If Windows answers that the program requires
    /// administrator rights, Windows' own UAC prompt is requested ("runas"): the user decides there; D-ASK never bypasses it.
    /// </summary>
    AppActivationResult Start(InstalledApp app);

    /// <summary>Opens one page of Windows Settings by its fixed ms-settings: address (protocol activation; never an arbitrary string).</summary>
    void OpenSettingsUri(string msSettingsUri);

    /// <summary>Restores a window D-ASK just opened or navigated and asks Windows to put it in front (Windows may decline).</summary>
    void BringToFront(long hwnd);
}

public sealed record AppActivationResult(int? ProcessId, bool Elevated);

public sealed class Win32AppActivator : IAppActivator
{
    private const int ErrorElevationRequired = 740;

    public AppActivationResult Start(InstalledApp app)
    {
        if (app.Kind == InstalledApp.KindPackaged)
        {
            var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
            try
            {
                int hr = mgr.ActivateApplication(app.AppUserModelId!, null, 0 /* AO_NONE */, out uint pid);
                if (hr < 0) throw new Win32Exception(hr, $"Windows could not activate {app.Name} (0x{hr:X8}).");
                return new AppActivationResult(pid == 0 ? null : (int)pid, false);
            }
            finally { Marshal.ReleaseComObject(mgr); }
        }

        string wd = app.WorkingDirectory ?? Path.GetDirectoryName(app.ExePath!)!;
        try
        {
            return new AppActivationResult(NativeLaunch.Start(app.ExePath!, app.Arguments, wd), false);
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == ErrorElevationRequired)
        {
            // Legitimate elevation: Windows shows its own consent prompt. Same file, same fixed arguments; no command string.
            var elevated = new ProcessStartInfo(app.ExePath!)
            {
                UseShellExecute = true, Verb = "runas",
                WorkingDirectory = wd, Arguments = app.Arguments ?? string.Empty,
            };
            using var p = Process.Start(elevated);
            return new AppActivationResult(p?.Id, true);
        }
    }

    public void OpenSettingsUri(string msSettingsUri)
    {
        if (!SettingsPages.IsValidUri(msSettingsUri)) throw new ArgumentException("not a known Windows Settings page");
        using var p = Process.Start(new ProcessStartInfo(msSettingsUri) { UseShellExecute = true });
    }

    public void BringToFront(long hwnd)
    {
        var h = new IntPtr(hwnd);
        if (IsIconic(h)) ShowWindowAsync(h, 9 /* SW_RESTORE */);
        SetForegroundWindow(h);
    }

    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);

    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string? arguments, int options, out uint processId);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ApplicationActivationManager { }
}

/// <summary>
/// Starts a program the way the Start menu would, not as a child of D-ASK:
///   - NO handle inheritance: the program never holds the daemon's log files or pipes open (found in the live run of 2026-11-14: a
///     launched program kept the parent's output pipe open and the parent could not finish);
///   - the user's environment WITHOUT the launching host's private variables (ELECTRON_*, VSCODE_*): an Electron program such as
///     VS Code that inherits ELECTRON_RUN_AS_NODE=1 runs as a headless Node.js process and never opens a window (same live run);
///   - CreateProcess with the program as the application name and its own fixed arguments: no shell, no command interpreter.
/// </summary>
public static class NativeLaunch
{
    private static readonly string[] HostPrivatePrefixes = { "ELECTRON_", "VSCODE_" };

    /// <summary>The environment a launched program receives: this process's environment minus host-private variables.</summary>
    public static SortedDictionary<string, string> ChildEnvironment(System.Collections.IDictionary? source = null)
    {
        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry e in source ?? Environment.GetEnvironmentVariables())
        {
            string k = (string)e.Key;
            if (k.Length == 0 || k.StartsWith('=') || HostPrivatePrefixes.Any(p => k.StartsWith(p, StringComparison.OrdinalIgnoreCase))) continue;
            env[k] = (string?)e.Value ?? "";
        }
        return env;
    }

    public static int Start(string exePath, string? arguments, string workingDirectory)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var (k, v) in ChildEnvironment()) sb.Append(k).Append('=').Append(v).Append('\0');
        sb.Append('\0');
        IntPtr envBlock = Marshal.StringToHGlobalUni(sb.ToString());
        try
        {
            // The command line is the quoted program path followed by its own registered arguments (never agent text).
            var cmd = new System.Text.StringBuilder($"\"{exePath}\"" + (string.IsNullOrEmpty(arguments) ? "" : " " + arguments));
            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>() };
            const uint CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_DEFAULT_ERROR_MODE = 0x04000000;
            if (!CreateProcessW(exePath, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT | CREATE_DEFAULT_ERROR_MODE,
                    envBlock, workingDirectory, ref si, out var pi))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return (int)pi.dwProcessId;
        }
        finally { Marshal.FreeHGlobal(envBlock); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string lpApplicationName, System.Text.StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);
}

/// <summary>
/// The Windows Settings pages D-ASK can open, by spoken name. A FIXED table: only these ms-settings: addresses are ever opened.
/// Opening a page changes nothing by itself (the user changes settings there), so it is a low-risk, audited, not-approved action.
/// </summary>
public static class SettingsPages
{
    public static readonly IReadOnlyDictionary<string, (string Title, string Uri)> All = new Dictionary<string, (string, string)>(StringComparer.Ordinal)
    {
        ["home"] = ("Settings", "ms-settings:"),
        ["display"] = ("Display", "ms-settings:display"),
        ["sound"] = ("Sound", "ms-settings:sound"),
        ["bluetooth"] = ("Bluetooth & devices", "ms-settings:bluetooth"),
        ["wifi"] = ("Wi-Fi", "ms-settings:network-wifi"),
        ["network"] = ("Network & internet", "ms-settings:network-status"),
        ["power"] = ("Power & battery", "ms-settings:powersleep"),
        ["battery"] = ("Battery saver", "ms-settings:batterysaver"),
        ["about"] = ("About", "ms-settings:about"),
        ["apps"] = ("Installed apps", "ms-settings:appsfeatures"),
        ["startup"] = ("Startup apps", "ms-settings:startupapps"),
        ["default apps"] = ("Default apps", "ms-settings:defaultapps"),
        ["notifications"] = ("Notifications", "ms-settings:notifications"),
        ["personalization"] = ("Personalization", "ms-settings:personalization"),
        ["background"] = ("Background", "ms-settings:personalization-background"),
        ["colors"] = ("Colors", "ms-settings:colors"),
        ["storage"] = ("Storage", "ms-settings:storagesense"),
        ["windows update"] = ("Windows Update", "ms-settings:windowsupdate"),
        ["privacy"] = ("Privacy & security", "ms-settings:privacy"),
        ["mouse"] = ("Mouse", "ms-settings:mousetouchpad"),
        ["keyboard"] = ("Typing", "ms-settings:typing"),
        ["date and time"] = ("Date & time", "ms-settings:dateandtime"),
        ["language"] = ("Language & region", "ms-settings:regionlanguage"),
        ["accounts"] = ("Accounts", "ms-settings:yourinfo"),
        ["accessibility"] = ("Accessibility", "ms-settings:easeofaccess"),
        ["printers"] = ("Printers & scanners", "ms-settings:printers"),
        ["multitasking"] = ("Multitasking", "ms-settings:multitasking"),
        ["night light"] = ("Night light", "ms-settings:nightlight"),
        ["vpn"] = ("VPN", "ms-settings:network-vpn"),
        ["airplane mode"] = ("Airplane mode", "ms-settings:network-airplanemode"),
    };

    private static readonly IReadOnlyDictionary<string, string> Aliases = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["screen"] = "display", ["monitor"] = "display", ["brightness"] = "display", ["resolution"] = "display",
        ["audio"] = "sound", ["volume"] = "sound", ["devices"] = "bluetooth", ["wi fi"] = "wifi", ["wireless"] = "wifi",
        ["internet"] = "network", ["sleep"] = "power", ["power and sleep"] = "power", ["system"] = "about", ["device info"] = "about",
        ["installed apps"] = "apps", ["apps and features"] = "apps", ["startup apps"] = "startup", ["update"] = "windows update",
        ["updates"] = "windows update", ["wallpaper"] = "background", ["theme"] = "personalization", ["typing"] = "keyboard",
        ["time"] = "date and time", ["region"] = "language", ["ease of access"] = "accessibility", ["printer"] = "printers",
        ["settings"] = "home", ["main"] = "home",
    };

    public static (string Key, string Title, string Uri)? Find(string? page)
    {
        string k = InstalledAppCatalog.Normalize(page ?? "");
        if (k.EndsWith(" settings")) k = k[..^" settings".Length];
        if (k.Length == 0) k = "home";
        if (Aliases.TryGetValue(k, out var a)) k = a;
        return All.TryGetValue(k, out var v) ? (k, v.Title, v.Uri) : null;
    }

    public static bool IsValidUri(string uri) => All.Values.Any(v => v.Uri == uri);
}
