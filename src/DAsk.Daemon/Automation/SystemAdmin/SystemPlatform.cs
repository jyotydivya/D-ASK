using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace DAsk.Daemon.Automation.SystemAdmin;

/// <summary>
/// Fixed Windows PowerShell scripts for the few things only WinRT/CIM expose (radios, brightness, services, event log). Every script is a
/// constant; the only values ever inserted are validated tokens (closed enums, integers, service names matching a strict pattern), always
/// single-quoted. The output is JSON on stdout. No user or model text reaches a command line.
/// </summary>
public static class FixedPowerShell
{
    public static async Task<(bool Ok, JsonElement? Json, string Error)> RunAsync(string script, int timeoutMs, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
            "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -")
        {
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        using var p = Process.Start(psi)!;
        // Stdin mode runs statement by statement: the whole script is ONE try/catch statement, so the first error ends it with exit code 1.
        await p.StandardInput.WriteAsync("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\ntry {\n" + script +
            "\n} catch { $e = $_.Exception; $m = $e.Message; while ($e.InnerException) { $e = $e.InnerException; $m += ' | ' + $e.Message }; [Console]::Error.WriteLine($m); exit 1 }\n\n");
        p.StandardInput.Close();
        var outTask = p.StandardOutput.ReadToEndAsync();
        var errTask = p.StandardError.ReadToEndAsync();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeoutMs);
        try { await p.WaitForExitAsync(cts.Token); }
        catch (OperationCanceledException) { try { p.Kill(true); } catch { } return (false, null, ct.IsCancellationRequested ? "cancelled" : "timed out"); }
        string stdout = (await outTask).Trim(), stderr = (await errTask).Trim();
        if (p.ExitCode != 0) return (false, null, FirstLine(stderr.Length > 0 ? stderr : stdout));
        if (stdout.Length == 0) return (true, null, "");
        try { using var doc = JsonDocument.Parse(stdout); return (true, doc.RootElement.Clone(), ""); }
        catch { return (false, null, "unreadable output"); }
    }

    private static string FirstLine(string s) { var l = s.Split('\n').Select(x => x.Trim()).FirstOrDefault(x => x.Length > 0) ?? "failed"; return l.Length > 300 ? l[..300] : l; }

    public const string WinRtPrelude = @"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$rt) { $t = $asTask.MakeGenericMethod($rt).Invoke($null, @($op)); if (-not $t.Wait(15000)) { throw 'WinRT timeout' }; $t.Result }
[void][Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
[void][Windows.Devices.Radios.RadioAccessStatus, Windows.System.Devices, ContentType = WindowsRuntime]
[void][Windows.Devices.Radios.RadioState, Windows.System.Devices, ContentType = WindowsRuntime]
$access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
$radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
";

    public const string ListRadios = WinRtPrelude + @"
ConvertTo-Json -Compress -Depth 3 -InputObject @($radios | ForEach-Object { [pscustomobject]@{ kind = ""$($_.Kind)""; name = $_.Name; state = ""$($_.State)"" } })
";

    /// <summary>kind: WiFi | Bluetooth; desired: On | Off (validated by the caller).</summary>
    public static string SetRadio(string kind, string desired) => WinRtPrelude + $@"
if (""$access"" -ne 'Allowed') {{ throw ""radio access: $access"" }}
$r = @($radios | Where-Object {{ ""$($_.Kind)"" -eq '{kind}' }})
if ($r.Count -lt 1) {{ throw 'no {kind} radio on this computer' }}
$st = Await ($r[0].SetStateAsync([Windows.Devices.Radios.RadioState]::{desired})) ([Windows.Devices.Radios.RadioAccessStatus])
Start-Sleep -Milliseconds 600
$radios2 = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
$now = @($radios2 | Where-Object {{ ""$($_.Kind)"" -eq '{kind}' }})[0]
[pscustomobject]@{{ status = ""$st""; state = ""$($now.State)"" }} | ConvertTo-Json -Compress
";

    public const string Brightness = @"
$b = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue)
if ($b.Count -eq 0) { [pscustomobject]@{ supported = $false } | ConvertTo-Json -Compress } else { [pscustomobject]@{ supported = $true; percent = [int]$b[0].CurrentBrightness } | ConvertTo-Json -Compress }
";

    public static string SetBrightness(int percent) => $@"
$m = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods)
if ($m.Count -eq 0) {{ throw 'brightness control is not supported on this display' }}
Invoke-CimMethod -InputObject $m[0] -MethodName WmiSetBrightness -Arguments @{{ Timeout = [uint32]0; Brightness = [byte]{percent} }} | Out-Null
Start-Sleep -Milliseconds 700
[pscustomobject]@{{ percent = [int](@(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness)[0].CurrentBrightness) }} | ConvertTo-Json -Compress
";

    public const string ListServices = @"
ConvertTo-Json -Compress -Depth 3 -InputObject @(Get-Service | Sort-Object Name | ForEach-Object { [pscustomobject]@{ name = $_.Name; display = $_.DisplayName; status = ""$($_.Status)""; start = ""$($_.StartType)"" } })
";

    /// <summary>name matches ^[A-Za-z0-9_.\-]{1,80}$ (validated by the caller).</summary>
    public static string ServiceInfo(string name) => $@"
$s = Get-Service -Name '{name}'
$c = Get-CimInstance -ClassName Win32_Service -Filter ""Name='{name}'""
[pscustomobject]@{{ name = $s.Name; display = $s.DisplayName; status = ""$($s.Status)""; start = ""$($s.StartType)""; canStop = $s.CanStop; account = $c.StartName; path = $c.PathName; pid = [int]$c.ProcessId; dependents = @($s.DependentServices | ForEach-Object Name) }} | ConvertTo-Json -Compress
";

    public static string ServiceControl(string name, bool start) => $@"
{(start ? $"Start-Service -Name '{name}'" : $"Stop-Service -Name '{name}'")}
$s = Get-Service -Name '{name}'
$s.WaitForStatus('{(start ? "Running" : "Stopped")}', [TimeSpan]::FromSeconds(15))
$s.Refresh()
[pscustomobject]@{{ status = ""$((Get-Service -Name '{name}').Status)"" }} | ConvertTo-Json -Compress
";

    public const string SoundDevices = @"
ConvertTo-Json -Compress -Depth 3 -InputObject @(Get-CimInstance -ClassName Win32_SoundDevice | ForEach-Object { [pscustomobject]@{ name = $_.Name; status = $_.Status } })
";

    /// <summary>The newest System-log event 1074 (a restart/shutdown was initiated) since the given UTC time.</summary>
    public static string ShutdownEventSince(DateTime utc) => $@"
$e = Get-WinEvent -FilterHashtable @{{ LogName = 'System'; Id = 1074; StartTime = [DateTime]::Parse('{utc:O}').ToLocalTime() }} -MaxEvents 1 -ErrorAction SilentlyContinue
if ($e) {{ [pscustomobject]@{{ found = $true; time = $e.TimeCreated.ToString('o'); message = ($e.Message -split ""`n"")[0] }} | ConvertTo-Json -Compress }} else {{ [pscustomobject]@{{ found = $false }} | ConvertTo-Json -Compress }}
";
}

/// <summary>Default audio output volume through Core Audio (IAudioEndpointVolume). No PowerShell, no input.</summary>
public static class CoreAudio
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] private class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr n);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr n);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid ctx);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
        [PreserveSig] int GetMasterVolumeLevel(out float db);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
        [PreserveSig] int GetChannelVolumeLevel(uint ch, out float db);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    private static T OnMta<T>(Func<T> f)
    {
        T result = default!; Exception? err = null;
        var t = new Thread(() => { try { result = f(); } catch (Exception ex) { err = ex; } }) { IsBackground = true };
        t.SetApartmentState(ApartmentState.MTA); t.Start(); t.Join(5000);
        if (err != null) throw err;
        return result;
    }

    private static IAudioEndpointVolume Endpoint()
    {
        var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
        Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0 /* render */, 1 /* multimedia */, out var dev));
        var iid = typeof(IAudioEndpointVolume).GUID;
        Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 0x17 /* CLSCTX_ALL */, IntPtr.Zero, out var o));
        return (IAudioEndpointVolume)o;
    }

    /// <summary>(percent 0..100, muted), or null when there is no default output device.</summary>
    public static (int Percent, bool Muted)? Read() => OnMta<(int, bool)?>(() =>
    {
        try
        {
            var v = Endpoint();
            Marshal.ThrowExceptionForHR(v.GetMasterVolumeLevelScalar(out float level));
            Marshal.ThrowExceptionForHR(v.GetMute(out bool muted));
            return ((int)Math.Round(level * 100), muted);
        }
        catch (COMException) { return null; }
    });

    public static bool Set(int? percent, bool? mute) => OnMta(() =>
    {
        var v = Endpoint();
        var ctx = Guid.Empty;
        if (percent is int p) Marshal.ThrowExceptionForHR(v.SetMasterVolumeLevelScalar(p / 100f, ref ctx));
        if (mute is bool m) Marshal.ThrowExceptionForHR(v.SetMute(m, ref ctx));
        return true;
    });
}

/// <summary>Monitors, resolutions, refresh rates and DPI (read-only), from the Win32 display APIs.</summary>
public static class Displays
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DISPLAY_DEVICE { public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString; public int StateFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
        public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool EnumDisplayDevices(string? device, uint i, ref DISPLAY_DEVICE dd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);

    public static List<object> List()
    {
        var list = new List<object>();
        for (uint i = 0; i < 16; i++)
        {
            var dd = new DISPLAY_DEVICE { cb = Marshal.SizeOf<DISPLAY_DEVICE>() };
            if (!EnumDisplayDevices(null, i, ref dd, 0)) break;
            if ((dd.StateFlags & 0x1) == 0) continue;   // attached to the desktop
            var dm = new DEVMODE { dmSize = (short)Marshal.SizeOf<DEVMODE>() };
            if (!EnumDisplaySettings(dd.DeviceName, -1, ref dm)) continue;
            var mon = new DISPLAY_DEVICE { cb = Marshal.SizeOf<DISPLAY_DEVICE>() };
            string monitor = EnumDisplayDevices(dd.DeviceName, 0, ref mon, 0) ? mon.DeviceString : "";
            list.Add(new { device = dd.DeviceName, adapter = dd.DeviceString, monitor, primary = (dd.StateFlags & 0x4) != 0, width = dm.dmPelsWidth, height = dm.dmPelsHeight, refreshHz = dm.dmDisplayFrequency, bitsPerPixel = dm.dmBitsPerPel, x = dm.dmPositionX, y = dm.dmPositionY });
        }
        return list;
    }
}

/// <summary>Startup apps of the CURRENT user (HKCU Run + Startup folder) with the enabled/disabled state Task Manager uses (StartupApproved).</summary>
public static class StartupApps
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ApprovedRun = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    private const string ApprovedFolder = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";

    public sealed record Entry(string Name, string Source, string Command, bool Enabled, bool CanToggle);

    private static bool EnabledIn(string approvedKey, string name, RegistryKey hive)
    {
        using var k = hive.OpenSubKey(approvedKey);
        return k?.GetValue(name) is not byte[] b || b.Length == 0 || (b[0] & 1) == 0;   // 02/06 enabled, 03/07 disabled
    }

    public static List<Entry> List()
    {
        var list = new List<Entry>();
        using (var k = Registry.CurrentUser.OpenSubKey(RunKey))
            foreach (var n in k?.GetValueNames() ?? Array.Empty<string>())
                list.Add(new Entry(n, "HKCU Run", k!.GetValue(n)?.ToString() ?? "", EnabledIn(ApprovedRun, n, Registry.CurrentUser), true));
        using (var k = Registry.LocalMachine.OpenSubKey(RunKey))
            foreach (var n in k?.GetValueNames() ?? Array.Empty<string>())
                list.Add(new Entry(n, "HKLM Run (all users; changing it needs administrator rights)", k!.GetValue(n)?.ToString() ?? "", EnabledIn(ApprovedRun, n, Registry.LocalMachine), false));
        string folder = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        if (Directory.Exists(folder))
            foreach (var f in Directory.EnumerateFiles(folder).Where(f => !f.EndsWith("desktop.ini", StringComparison.OrdinalIgnoreCase)))
                list.Add(new Entry(Path.GetFileName(f), "Startup folder", f, EnabledIn(ApprovedFolder, Path.GetFileName(f), Registry.CurrentUser), true));
        return list;
    }

    /// <summary>Sets the Task-Manager state (the entry itself is never deleted or edited). Only current-user entries.</summary>
    public static void SetEnabled(Entry e, bool enabled)
    {
        string key = e.Source == "Startup folder" ? ApprovedFolder : ApprovedRun;
        using var k = Registry.CurrentUser.CreateSubKey(key, true);
        var data = new byte[12];
        data[0] = (byte)(enabled ? 0x02 : 0x03);
        if (!enabled) BitConverter.GetBytes(DateTime.UtcNow.ToFileTimeUtc()).CopyTo(data, 4);
        k.SetValue(e.Name, data, RegistryValueKind.Binary);
    }
}

public static class NetworkInfo
{
    public static List<object> Adapters() => NetworkInterface.GetAllNetworkInterfaces()
        .Where(n => n.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
        .Select(n => (object)new
        {
            name = n.Name, description = n.Description, type = n.NetworkInterfaceType.ToString(), status = n.OperationalStatus.ToString(),
            speedMbps = n.OperationalStatus == OperationalStatus.Up && n.Speed > 0 ? n.Speed / 1_000_000 : 0,
            ipv4 = n.OperationalStatus == OperationalStatus.Up ? n.GetIPProperties().UnicastAddresses.Where(a => a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork).Select(a => a.Address.ToString()).ToArray() : Array.Empty<string>(),
        }).ToList();

    /// <summary>"netsh wlan show interfaces" (fixed command, read-only): the connected SSID and signal, if any.</summary>
    public static async Task<object?> WifiConnection(CancellationToken ct)
    {
        try
        {
            var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "netsh.exe"), "wlan show interfaces") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
            using var p = Process.Start(psi)!;
            string text = await p.StandardOutput.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct);
            string? Field(string label) => text.Split('\n').Select(l => l.Trim()).Where(l => l.StartsWith(label, StringComparison.OrdinalIgnoreCase) && l.Contains(':'))
                .Select(l => l[(l.IndexOf(':') + 1)..].Trim()).FirstOrDefault();
            return new { state = Field("State"), ssid = Field("SSID"), signal = Field("Signal"), radioType = Field("Radio type") };
        }
        catch { return null; }
    }
}
