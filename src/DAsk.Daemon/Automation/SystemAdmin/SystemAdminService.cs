using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.SystemAdmin;

public sealed class SystemAdminOptions
{
    /// <summary>AgentHost:SystemAdmin. Off by default.</summary>
    public bool Enabled { get; init; } = false;
    /// <summary>Services that may be started or stopped (each after approval). Empty: list and inspect only.</summary>
    public IReadOnlyList<string> ControllableServices { get; init; } = Array.Empty<string>();
    public int MinPowerDelaySeconds { get; init; } = 30;
    public int MaxPowerDelaySeconds { get; init; } = 3600;
    /// <summary>TESTS ONLY: replaces the real sleep / sign-out call (restart and shutdown always go through shutdown.exe and can be aborted).</summary>
    public Action<string>? TestPowerSink { get; init; }
}

/// <summary>
/// Windows administration through natural-language requests. Reads (processes, services, network, radios, audio, displays, startup apps)
/// need no approval. Every change is approved in the HUD with its exact target, performed once with a legitimate Windows mechanism under the
/// user's own rights (no elevation, no UAC bypass: a change that needs administrator rights fails and is reported as such), and verified by
/// reading the real state back. Power actions are SCHEDULED (at least 30 s), can be cancelled (system.cancel_power, no approval needed) and
/// are cancelled by Emergency Stop. Nothing here runs arbitrary commands: the only programs are shutdown.exe, netsh.exe (read) and fixed
/// PowerShell scripts with validated tokens.
/// </summary>
public sealed class SystemAdminService : IDesktopActionRequestService
{
    public const string ListProcesses = "system.list_processes", ProcessInfo = "system.process_info", EndProcess = "system.end_process";
    public const string ListServices = "system.list_services", ServiceInfo = "system.service_info", ServiceControl = "system.service_control";
    public const string NetworkStatus = "system.network_status", SetRadio = "system.set_radio";
    public const string AudioStatus = "system.audio_status", SetVolume = "system.set_volume";
    public const string DisplayStatus = "system.display_status", SetBrightness = "system.set_brightness";
    public const string StartupList = "system.startup_apps", StartupToggle = "system.startup_toggle";
    public const string Power = "system.power", CancelPower = "system.cancel_power";

    private static readonly string[] ReadTools = { ListProcesses, ProcessInfo, ListServices, ServiceInfo, NetworkStatus, AudioStatus, DisplayStatus, StartupList, CancelPower };
    private static readonly string[] ChangeTools = { EndProcess, ServiceControl, SetRadio, SetVolume, SetBrightness, StartupToggle, Power };
    public static readonly IReadOnlyList<string> All = ReadTools.Concat(ChangeTools).ToArray();
    /// <summary>Reads (and cancelling a scheduled power action) do not use the task's single approval budget.</summary>
    public static bool IsUnmetered(string tool) => ReadTools.Contains(tool);

    /// <summary>Processes D-ASK never ends: Windows' own core, security software, and D-ASK itself.</summary>
    private static readonly HashSet<string> ProtectedProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "System", "Idle", "Registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso", "svchost", "fontdrvhost", "dwm", "explorer",
        "sihost", "ctfmon", "audiodg", "MsMpEng", "NisSrv", "SecurityHealthService", "SecurityHealthSystray", "MpDefenderCoreService", "spoolsv", "taskhostw",
        "LogonUI", "consent", "userinit", "WUDFHost", "conhost", "dllhost", "StartMenuExperienceHost", "ShellExperienceHost", "SearchHost", "TextInputHost",
        "DAsk.Daemon", "hud-native", "llama-server", "dask-ocr",
    };
    private static readonly Regex ServiceName = new(@"^[A-Za-z0-9_.\-]{1,80}$", RegexOptions.Compiled);

    private readonly ApprovalGate _gate;
    private readonly SystemAdminOptions _opts;
    private readonly ILogger? _logger;
    private readonly HashSet<string> _services;

    // One scheduled power action at a time.
    private readonly object _powerLock = new();
    private PendingPower? _pending;
    private sealed record PendingPower(string Action, DateTimeOffset At, CancellationTokenSource Cts, bool ViaShutdownExe);

    public SystemAdminService(ApprovalGate gate, SystemAdminOptions options, ILogger? logger = null)
    {
        _gate = gate; _opts = options; _logger = logger;
        _services = new HashSet<string>(options.ControllableServices.Where(s => ServiceName.IsMatch(s)), StringComparer.OrdinalIgnoreCase);
    }

    public IReadOnlyList<string> Tools => _opts.Enabled && _gate.Available ? All : Array.Empty<string>();
    public int MaxCallMs => (int)ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds + 45_000;

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        try
        {
            if (!All.Contains(tool)) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
            if (!_opts.Enabled) return DesktopCallResult.Fail("system_disabled", "Windows administration is switched off in this installation (AgentHost:SystemAdmin). Nothing was done.");
            if (args.ValueKind != JsonValueKind.Object) return DesktopCallResult.Fail("invalid_args", "arguments must be an object");
            var r = await RunAsync(tool, args, ctx, ct);
            if (r.Status != "ok") _logger?.LogInformation("[System] {Tool} for task {TaskId}: {Code}.", tool, ctx.TaskId, r.Error?.Code ?? r.Status);
            return r;
        }
        catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
    }

    // ── argument helpers (strict: unknown fields are refused) ──
    private static string? Str(JsonElement a, string name) => a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static int? Int(JsonElement a, string name) => a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out int i) ? i : null;
    private static bool? Bool(JsonElement a, string name) => a.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;
    private static string? Unknown(JsonElement a, params string[] allowed) => a.EnumerateObject().Select(p => p.Name).FirstOrDefault(n => !allowed.Contains(n));

    private async Task<DesktopCallResult> RunAsync(string tool, JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        switch (tool)
        {
            case ListProcesses:
            {
                if (Unknown(a, "filter") is { } u) return Bad(u);
                string? filter = Str(a, "filter");
                var rows = Process.GetProcesses().Select(p => { try { return new { name = p.ProcessName, pid = p.Id, memoryMb = p.WorkingSet64 / (1024 * 1024), window = p.MainWindowTitle, session = p.SessionId }; } catch { return null; } finally { p.Dispose(); } })
                    .Where(x => x != null && (filter == null || x.name.Contains(filter, StringComparison.OrdinalIgnoreCase) || x.window.Contains(filter, StringComparison.OrdinalIgnoreCase)))
                    .OrderByDescending(x => x!.memoryMb).ToList();
                return DesktopCallResult.Ok(new { verified = true, count = rows.Count, shown = Math.Min(rows.Count, 40), processes = rows.Take(40), observed = $"{rows.Count} running process(es){(filter != null ? $" matching \"{filter}\"" : "")}, largest memory first" });
            }
            case ProcessInfo:
            {
                if (Unknown(a, "pid", "name") is { } u) return Bad(u);
                var procs = Int(a, "pid") is int pid ? TryGet(pid) is { } one ? new List<Process> { one } : new List<Process>()
                    : Str(a, "name") is { Length: > 0 } nm ? Process.GetProcessesByName(nm.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? nm[..^4] : nm).ToList() : null!;
                if (procs == null) return Bad("pid or name is required");
                if (procs.Count == 0) return DesktopCallResult.Fail("not_found", "No such process is running.");
                var info = procs.Take(10).Select(Describe).ToList();
                procs.ForEach(p => p.Dispose());
                return DesktopCallResult.Ok(new { verified = true, count = procs.Count, processes = info, observed = $"{procs.Count} matching process(es)" });
            }
            case EndProcess: return await EndProcessAsync(a, ctx, ct);
            case ListServices:
            {
                if (Unknown(a, "filter") is { } u) return Bad(u);
                var (ok, json, err) = await FixedPowerShell.RunAsync(FixedPowerShell.ListServices, 30_000, ct);
                if (!ok || json is not { ValueKind: JsonValueKind.Array } arr) return DesktopCallResult.Fail("read_failed", $"The services could not be listed ({err}).");
                string? filter = Str(a, "filter");
                var rows = arr.EnumerateArray().Where(s => filter == null || (s.GetProperty("name").GetString() ?? "").Contains(filter, StringComparison.OrdinalIgnoreCase) || (s.GetProperty("display").GetString() ?? "").Contains(filter, StringComparison.OrdinalIgnoreCase)).ToList();
                return DesktopCallResult.Ok(new { verified = true, count = rows.Count, running = rows.Count(r => r.GetProperty("status").GetString() == "Running"), services = rows.Take(60), controllable = _services.ToArray(),
                    observed = $"{rows.Count} service(s){(filter != null ? $" matching \"{filter}\"" : "")}" });
            }
            case ServiceInfo:
            {
                if (Unknown(a, "name") is { } u) return Bad(u);
                if (Str(a, "name") is not { } name || !ServiceName.IsMatch(name)) return Bad("name must be a service name (letters, digits, _ . -)");
                var (ok, json, err) = await FixedPowerShell.RunAsync(FixedPowerShell.ServiceInfo(name), 20_000, ct);
                if (!ok || json == null) return DesktopCallResult.Fail("not_found", $"The service {name} could not be read ({err}).");
                return DesktopCallResult.Ok(new { verified = true, service = json, controllable = _services.Contains(name), observed = $"{name} is {json.Value.GetProperty("status").GetString()}" });
            }
            case ServiceControl: return await ServiceControlAsync(a, ctx, ct);
            case NetworkStatus:
            {
                if (Unknown(a) is { } u) return Bad(u);
                var radios = await FixedPowerShell.RunAsync(FixedPowerShell.ListRadios, 25_000, ct);
                var wifi = await NetworkInfo.WifiConnection(ct);
                return DesktopCallResult.Ok(new { verified = true, adapters = NetworkInfo.Adapters(), wifi, radios = radios.Ok ? radios.Json : null, radiosError = radios.Ok ? null : radios.Error,
                    observed = "adapters, Wi-Fi connection and radio states read from Windows" });
            }
            case SetRadio: return await SetRadioAsync(a, ctx, ct);
            case AudioStatus:
            {
                if (Unknown(a) is { } u) return Bad(u);
                var vol = CoreAudio.Read();
                var devices = await FixedPowerShell.RunAsync(FixedPowerShell.SoundDevices, 20_000, ct);
                return DesktopCallResult.Ok(new { verified = true, hasOutput = vol != null, volumePercent = vol?.Percent, muted = vol?.Muted, devices = devices.Ok ? devices.Json : null,
                    observed = vol is { } v ? $"volume {v.Percent}%{(v.Muted ? " (muted)" : "")}" : "no default audio output device" });
            }
            case SetVolume: return await SetVolumeAsync(a, ctx, ct);
            case DisplayStatus:
            {
                if (Unknown(a) is { } u) return Bad(u);
                var b = await FixedPowerShell.RunAsync(FixedPowerShell.Brightness, 20_000, ct);
                bool supported = b.Ok && b.Json is { } bj && bj.GetProperty("supported").GetBoolean();
                return DesktopCallResult.Ok(new { verified = true, displays = Displays.List(), brightnessSupported = supported, brightnessPercent = supported ? b.Json!.Value.GetProperty("percent").GetInt32() : (int?)null,
                    observed = "displays and brightness read from Windows" });
            }
            case SetBrightness: return await SetBrightnessAsync(a, ctx, ct);
            case StartupList:
            {
                if (Unknown(a) is { } u) return Bad(u);
                var list = StartupApps.List();
                return DesktopCallResult.Ok(new { verified = true, count = list.Count, enabled = list.Count(e => e.Enabled), apps = list.Select(e => new { name = e.Name, source = e.Source, command = e.Command, enabled = e.Enabled, canToggle = e.CanToggle }),
                    observed = $"{list.Count} startup app(s), {list.Count(e => e.Enabled)} enabled" });
            }
            case StartupToggle: return await StartupToggleAsync(a, ctx, ct);
            case Power: return await PowerAsync(a, ctx, ct);
            case CancelPower: return await CancelPowerAsync("you asked to cancel it", ct);
        }
        return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
    }

    private static DesktopCallResult Bad(string what) => DesktopCallResult.Fail("invalid_args", what.Contains(' ') ? what : $"unknown argument '{what}'");
    private static Process? TryGet(int pid) { try { return Process.GetProcessById(pid); } catch { return null; } }

    private static object Describe(Process p)
    {
        string? path = null; DateTime? started = null;
        try { path = p.MainModule?.FileName; } catch { }
        try { started = p.StartTime; } catch { }
        return new { name = p.ProcessName, pid = p.Id, path, started = started?.ToString("O"), memoryMb = p.WorkingSet64 / (1024 * 1024), window = p.MainWindowTitle, session = p.SessionId, responding = SafeResponding(p) };
    }
    private static bool? SafeResponding(Process p) { try { return p.Responding; } catch { return null; } }

    // ── changes (each approved, performed once, verified) ──

    private async Task<DesktopCallResult> EndProcessAsync(JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        if (Unknown(a, "pid") is { } u) return Bad(u);
        if (Int(a, "pid") is not int pid) return Bad("pid is required (find it with system.list_processes)");
        using var p = TryGet(pid);
        if (p == null) return DesktopCallResult.Fail("not_found", "No process with that id is running. Nothing was done.");
        string name = p.ProcessName;
        if (ProtectedProcesses.Contains(name) || pid == Environment.ProcessId || pid <= 4)
            return DesktopCallResult.Fail("target_forbidden", $"{name} is part of Windows, security software or D-ASK itself; D-ASK never ends it.");
        if (p.SessionId != Process.GetCurrentProcess().SessionId) return DesktopCallResult.Fail("target_forbidden", "That process belongs to another session or user; D-ASK only ends your own programs.");
        DateTime started; string path;
        try { started = p.StartTime; path = p.MainModule?.FileName ?? name; }
        catch { return DesktopCallResult.Fail("access_denied", $"Windows does not let D-ASK inspect {name} (it probably runs with administrator rights). Nothing was done."); }
        var parameters = new Dictionary<string, string>
        {
            ["operation"] = $"End the program {name} (process {pid}) now",
            ["process"] = name, ["pid"] = pid.ToString(), ["path"] = path, ["started"] = started.ToString("O"), ["window"] = p.MainWindowTitle,
            ["warning"] = "Unsaved work in that program is lost.",
            ["execution"] = "Ended once, right after your approval; D-ASK then checks that the process is gone.",
        };
        var (req, refusal) = await _gate.RequestAsync(DesktopActionTypes.ProcessEnd, parameters, name, p.MainWindowTitle, $"D-ASK asks to end {name}.", ctx, ct);
        if (refusal != null) return refusal;
        using var again = TryGet(pid);
        if (again == null) return DesktopCallResult.Ok(new { executed = false, verified = true, observed = $"{name} had already exited before D-ASK acted" });
        DateTime againStarted; try { againStarted = again.StartTime; } catch { againStarted = default; }
        if (again.ProcessName != name || againStarted != started) return DesktopCallResult.Fail("target_changed", "The process id now belongs to a different program; nothing was done.");
        try { again.Kill(entireProcessTree: false); }
        catch (Exception ex) { await _gate.AuditAsync("Failed", req!, ctx, ex.GetType().Name); return DesktopCallResult.Fail("access_denied", $"Windows refused to end {name} ({ex.Message}). Nothing else was done."); }
        bool gone = again.WaitForExit(5000);
        bool reused = TryGet(pid) is { } after && SafeStart(after) == started;
        bool verified = gone && !reused;
        await _gate.AuditAsync(verified ? "Verified" : "Unverified", req!, ctx, $"end {name} pid {pid}: exited={gone}");
        return verified ? DesktopCallResult.Ok(new { executed = true, verified = true, process = name, pid, observed = $"{name} (process {pid}) is no longer running" })
            : DesktopCallResult.Fail("execution_unverified", $"D-ASK asked Windows once to end {name}, but it is still running.");
    }
    private static DateTime? SafeStart(Process p) { try { return p.StartTime; } catch { return null; } finally { p.Dispose(); } }

    private async Task<DesktopCallResult> ServiceControlAsync(JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        if (Unknown(a, "name", "action") is { } u) return Bad(u);
        if (Str(a, "name") is not { } name || !ServiceName.IsMatch(name)) return Bad("name must be a service name");
        if (Str(a, "action") is not ("start" or "stop") || Str(a, "action") is not { } action) return Bad("action must be start or stop");
        if (!_services.Contains(name)) return DesktopCallResult.Fail("service_not_allowed", $"{name} is not one of the services D-ASK may start or stop (AgentHost:SystemAdminServices). It can only be listed and inspected.");
        var (ok, info, err) = await FixedPowerShell.RunAsync(FixedPowerShell.ServiceInfo(name), 20_000, ct);
        if (!ok || info == null) return DesktopCallResult.Fail("not_found", $"The service {name} could not be read ({err}). Nothing was done.");
        string before = info.Value.GetProperty("status").GetString() ?? "";
        string want = action == "start" ? "Running" : "Stopped";
        if (before == want) return DesktopCallResult.Ok(new { executed = false, verified = true, status = before, observed = $"{name} is already {before}; nothing to do" });
        var parameters = new Dictionary<string, string>
        {
            ["operation"] = $"{(action == "start" ? "Start" : "Stop")} the Windows service {name}",
            ["service"] = name, ["display"] = info.Value.GetProperty("display").GetString() ?? "", ["currently"] = before,
            ["rights"] = "Runs with your rights. If Windows requires administrator rights for this service, it is refused and reported; D-ASK never bypasses UAC.",
            ["execution"] = "Done once, right after your approval; the service's status is then read back.",
        };
        var (req, refusal) = await _gate.RequestAsync(DesktopActionTypes.ServiceControl, parameters, name, name, $"D-ASK asks to {action} the service {name}.", ctx, ct);
        if (refusal != null) return refusal;
        var (done, json, perr) = await FixedPowerShell.RunAsync(FixedPowerShell.ServiceControl(name, action == "start"), 40_000, ct);
        var (_, after, _) = await FixedPowerShell.RunAsync(FixedPowerShell.ServiceInfo(name), 20_000, ct);
        string now = after?.GetProperty("status").GetString() ?? "unknown";
        bool verified = now == want;
        await _gate.AuditAsync(verified ? "Verified" : "Unverified", req!, ctx, $"{action} {name}: {before} -> {now}{(done ? "" : $" ({perr})")}");
        if (verified) return DesktopCallResult.Ok(new { executed = true, verified = true, service = name, status = now, observed = $"{name} is now {now} (read back from Windows)" });
        bool denied = perr.Contains("denied", StringComparison.OrdinalIgnoreCase) || perr.Contains("cannot open", StringComparison.OrdinalIgnoreCase);
        return DesktopCallResult.Fail(denied ? "access_denied" : "execution_unverified",
            denied ? $"Windows refused: changing {name} needs administrator rights (UAC). D-ASK does not bypass that. The service is still {now}."
                   : $"D-ASK asked Windows once to {action} {name}, but it is {now} ({perr}).");
    }

    private async Task<DesktopCallResult> SetRadioAsync(JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        if (Unknown(a, "radio", "state") is { } u) return Bad(u);
        string? kind = Str(a, "radio")?.ToLowerInvariant() switch { "wifi" or "wi-fi" => "WiFi", "bluetooth" => "Bluetooth", _ => null };
        string? desired = Str(a, "state")?.ToLowerInvariant() switch { "on" => "On", "off" => "Off", _ => null };
        if (kind == null || desired == null) return Bad("radio must be wifi or bluetooth and state on or off");
        var cur = await FixedPowerShell.RunAsync(FixedPowerShell.ListRadios, 25_000, ct);
        if (!cur.Ok || cur.Json is not { ValueKind: JsonValueKind.Array } arr) return DesktopCallResult.Fail("read_failed", $"The radios could not be read ({cur.Error}). Nothing was done.");
        var radio = arr.EnumerateArray().FirstOrDefault(r => r.GetProperty("kind").GetString() == kind);
        if (radio.ValueKind != JsonValueKind.Object) return DesktopCallResult.Fail("not_supported", $"This computer has no {kind} radio that Windows lets apps control.");
        string before = radio.GetProperty("state").GetString() ?? "";
        if (before == desired) return DesktopCallResult.Ok(new { executed = false, verified = true, state = before, observed = $"{kind} is already {before}" });
        var parameters = new Dictionary<string, string>
        {
            ["operation"] = $"Turn {(kind == "WiFi" ? "Wi-Fi" : "Bluetooth")} {desired.ToLowerInvariant()}",
            ["radio"] = radio.GetProperty("name").GetString() ?? kind, ["currently"] = before,
            ["effect"] = kind == "WiFi" && desired == "Off" ? "Your computer goes offline until Wi-Fi is turned on again (D-ASK keeps working offline)." : $"{kind} devices {(desired == "Off" ? "disconnect" : "can connect again")}.",
            ["execution"] = "Done once through Windows' radio control, right after your approval; the radio state is then read back.",
        };
        var (req, refusal) = await _gate.RequestAsync(DesktopActionTypes.RadioToggle, parameters, kind, kind, $"D-ASK asks to turn {kind} {desired.ToLowerInvariant()}.", ctx, ct);
        if (refusal != null) return refusal;
        var (ok, json, err) = await FixedPowerShell.RunAsync(FixedPowerShell.SetRadio(kind, desired), 30_000, ct);
        string now = json?.GetProperty("state").GetString() ?? "unknown";
        bool verified = ok && now == desired;
        await _gate.AuditAsync(verified ? "Verified" : "Unverified", req!, ctx, $"{kind} {before} -> {now}");
        return verified ? DesktopCallResult.Ok(new { executed = true, verified = true, radio = kind, state = now, observed = $"{kind} is now {now} (read back from Windows)" })
            : DesktopCallResult.Fail("execution_unverified", $"D-ASK asked Windows once to turn {kind} {desired.ToLowerInvariant()}, but it reads {now} ({err}).");
    }

    private async Task<DesktopCallResult> SetVolumeAsync(JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        if (Unknown(a, "percent", "mute") is { } u) return Bad(u);
        int? percent = Int(a, "percent"); bool? mute = Bool(a, "mute");
        if (percent == null && mute == null) return Bad("give percent (0-100) and/or mute (true/false)");
        if (percent is < 0 or > 100) return Bad("percent must be 0-100");
        var before = CoreAudio.Read();
        if (before == null) return DesktopCallResult.Fail("not_supported", "There is no default audio output device. Nothing was done.");
        var parameters = new Dictionary<string, string>
        {
            ["operation"] = percent != null ? $"Set the volume to {percent}%{(mute is bool m1 ? (m1 ? " and mute" : " and unmute") : "")}" : (mute == true ? "Mute the sound" : "Unmute the sound"),
            ["currently"] = $"{before.Value.Percent}%{(before.Value.Muted ? " (muted)" : "")}",
            ["execution"] = "Done once, right after your approval; the volume is then read back.",
        };
        var (req, refusal) = await _gate.RequestAsync(DesktopActionTypes.VolumeSet, parameters, "Audio", "Default output", "D-ASK asks to change the volume.", ctx, ct);
        if (refusal != null) return refusal;
        CoreAudio.Set(percent, mute);
        var now = CoreAudio.Read();
        bool verified = now != null && (percent == null || Math.Abs(now.Value.Percent - percent.Value) <= 1) && (mute == null || now.Value.Muted == mute);
        await _gate.AuditAsync(verified ? "Verified" : "Unverified", req!, ctx, $"volume {before.Value.Percent} -> {now?.Percent}, muted {now?.Muted}");
        return verified ? DesktopCallResult.Ok(new { executed = true, verified = true, volumePercent = now!.Value.Percent, muted = now.Value.Muted, observed = $"the volume is now {now.Value.Percent}%{(now.Value.Muted ? " (muted)" : "")} (read back)" })
            : DesktopCallResult.Fail("execution_unverified", "D-ASK set the volume once, but reading it back shows a different value.");
    }

    private async Task<DesktopCallResult> SetBrightnessAsync(JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        if (Unknown(a, "percent") is { } u) return Bad(u);
        if (Int(a, "percent") is not int percent || percent is < 0 or > 100) return Bad("percent must be 0-100");
        var b = await FixedPowerShell.RunAsync(FixedPowerShell.Brightness, 20_000, ct);
        if (!b.Ok || b.Json is not { } bj || !bj.GetProperty("supported").GetBoolean()) return DesktopCallResult.Fail("not_supported", "This display does not let Windows apps change its brightness. Nothing was done.");
        int before = bj.GetProperty("percent").GetInt32();
        var parameters = new Dictionary<string, string>
        {
            ["operation"] = $"Set the screen brightness to {percent}%", ["currently"] = $"{before}%",
            ["execution"] = "Done once, right after your approval; the brightness is then read back.",
        };
        var (req, refusal) = await _gate.RequestAsync(DesktopActionTypes.BrightnessSet, parameters, "Display", "Built-in display", "D-ASK asks to change the brightness.", ctx, ct);
        if (refusal != null) return refusal;
        var (ok, json, err) = await FixedPowerShell.RunAsync(FixedPowerShell.SetBrightness(percent), 20_000, ct);
        int now = json?.GetProperty("percent").GetInt32() ?? -1;
        bool verified = ok && Math.Abs(now - percent) <= 1;
        await _gate.AuditAsync(verified ? "Verified" : "Unverified", req!, ctx, $"brightness {before} -> {now}");
        return verified ? DesktopCallResult.Ok(new { executed = true, verified = true, brightnessPercent = now, observed = $"the brightness is now {now}% (read back)" })
            : DesktopCallResult.Fail("execution_unverified", $"D-ASK set the brightness once, but it reads {now}% ({err}).");
    }

    private async Task<DesktopCallResult> StartupToggleAsync(JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        if (Unknown(a, "name", "enabled") is { } u) return Bad(u);
        if (Str(a, "name") is not { Length: > 0 } name || Bool(a, "enabled") is not bool enabled) return Bad("name and enabled (true/false) are required");
        var matches = StartupApps.List().Where(e => string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase)).ToList();
        if (matches.Count == 0) return DesktopCallResult.Fail("not_found", $"There is no startup app named \"{name}\".");
        if (matches.Count > 1) return DesktopCallResult.Fail("ambiguous_target", $"{matches.Count} startup entries are named \"{name}\".");
        var e = matches[0];
        if (!e.CanToggle) return DesktopCallResult.Fail("access_denied", $"\"{e.Name}\" starts for all users; changing it needs administrator rights, which D-ASK does not bypass.");
        if (e.Enabled == enabled) return DesktopCallResult.Ok(new { executed = false, verified = true, enabled, observed = $"\"{e.Name}\" is already {(enabled ? "enabled" : "disabled")}" });
        var parameters = new Dictionary<string, string>
        {
            ["operation"] = $"{(enabled ? "Enable" : "Disable")} the startup app \"{e.Name}\"",
            ["entry"] = e.Name, ["source"] = e.Source, ["command"] = e.Command, ["currently"] = e.Enabled ? "enabled" : "disabled",
            ["how"] = "Same switch as Task Manager's Startup apps page; the entry itself is not deleted or edited, and it can be switched back.",
            ["execution"] = "Done once, right after your approval; the state is then read back.",
        };
        var (req, refusal) = await _gate.RequestAsync(DesktopActionTypes.StartupToggle, parameters, e.Name, e.Source, $"D-ASK asks to {(enabled ? "enable" : "disable")} a startup app.", ctx, ct);
        if (refusal != null) return refusal;
        StartupApps.SetEnabled(e, enabled);
        bool now = StartupApps.List().First(x => x.Name == e.Name && x.Source == e.Source).Enabled;
        await _gate.AuditAsync(now == enabled ? "Verified" : "Unverified", req!, ctx, $"{e.Name}: {e.Enabled} -> {now}");
        return now == enabled ? DesktopCallResult.Ok(new { executed = true, verified = true, name = e.Name, enabled = now, observed = $"\"{e.Name}\" is now {(now ? "enabled" : "disabled")} at startup (read back)" })
            : DesktopCallResult.Fail("execution_unverified", "D-ASK changed the startup state once, but reading it back shows no change.");
    }

    // ── power: always scheduled (>= MinPowerDelaySeconds), cancellable, cancelled by Emergency Stop ──

    private async Task<DesktopCallResult> PowerAsync(JsonElement a, DesktopActionContext ctx, CancellationToken ct)
    {
        if (Unknown(a, "action", "delaySeconds") is { } u) return Bad(u);
        string? action = Str(a, "action")?.ToLowerInvariant() switch { "sleep" => "sleep", "restart" => "restart", "shutdown" or "shut down" => "shutdown", "signout" or "sign out" or "logoff" => "signout", _ => null };
        if (action == null) return Bad("action must be sleep, restart, shutdown or signout");
        int delay = Int(a, "delaySeconds") ?? 60;
        if (delay < _opts.MinPowerDelaySeconds || delay > _opts.MaxPowerDelaySeconds) return Bad($"delaySeconds must be {_opts.MinPowerDelaySeconds}-{_opts.MaxPowerDelaySeconds} (power actions are always scheduled so they can be cancelled)");
        lock (_powerLock) if (_pending != null) return DesktopCallResult.Fail("already_scheduled", $"A {_pending.Action} is already scheduled for {_pending.At:HH:mm:ss}. Cancel it first.");
        string verb = action switch { "sleep" => "Put the computer to sleep", "restart" => "Restart the computer", "shutdown" => "Shut down the computer", _ => "Sign you out of Windows" };
        var parameters = new Dictionary<string, string>
        {
            ["operation"] = $"{verb} in {delay} seconds",
            ["delaySeconds"] = delay.ToString(),
            ["warning"] = action == "sleep" ? "Open programs stay open." : "Unsaved work in open programs may be lost.",
            ["cancel"] = "Until then you can cancel it: ask D-ASK to cancel, press Emergency Stop" + (action is "restart" or "shutdown" ? ", or run shutdown /a." : "."),
            ["execution"] = action is "restart" or "shutdown" ? "Scheduled once with Windows' own shutdown.exe right after your approval; Windows records it in its event log, which D-ASK reads back."
                : "Scheduled once inside D-ASK right after your approval; D-ASK performs it when the time comes unless it was cancelled.",
        };
        var (req, refusal) = await _gate.RequestAsync(DesktopActionTypes.PowerAction, parameters, "Windows", verb, $"D-ASK asks to {verb.ToLowerInvariant()}.", ctx, ct);
        if (refusal != null) return refusal;
        var at = DateTimeOffset.Now.AddSeconds(delay);
        var cts = new CancellationTokenSource();
        if (action is "restart" or "shutdown")
        {
            var t0 = DateTime.UtcNow.AddSeconds(-2);
            int code = await RunShutdownExe($"/{(action == "restart" ? "r" : "s")} /t {delay} /c \"D-ASK: scheduled after your approval. To cancel: ask D-ASK, press Emergency Stop, or run shutdown /a.\"", ct);
            if (code != 0) { await _gate.AuditAsync("Failed", req!, ctx, $"shutdown.exe exit {code}"); return DesktopCallResult.Fail("execution_failed", $"Windows refused to schedule the {action} (shutdown.exe exit code {code}). Nothing is scheduled."); }
            lock (_powerLock) _pending = new PendingPower(action, at, cts, true);
            StartStopWatch(cts);
            // Windows writes event 1074 shortly after shutdown.exe returns: read it back for a few seconds.
            bool logged = false;
            for (int i = 0; i < 6 && !logged; i++)
            {
                if (i > 0) await Task.Delay(1000, CancellationToken.None);
                var ev = await FixedPowerShell.RunAsync(FixedPowerShell.ShutdownEventSince(t0), 20_000, CancellationToken.None);
                logged = ev.Ok && ev.Json is { } ej && ej.GetProperty("found").GetBoolean();
            }
            await _gate.AuditAsync(logged ? "Verified" : "Unverified", req!, ctx, $"{action} scheduled for {at:O}; event 1074 found={logged}");
            return DesktopCallResult.Ok(new { executed = true, verified = logged, action, scheduledFor = at.ToString("O"), delaySeconds = delay,
                observed = logged ? $"Windows recorded the scheduled {action} (System event 1074); it happens at {at:HH:mm:ss} unless cancelled" : $"shutdown.exe accepted the {action} for {at:HH:mm:ss}, but its event-log record was not found" });
        }
        lock (_powerLock) _pending = new PendingPower(action, at, cts, false);
        StartStopWatch(cts);
        _ = Task.Run(async () =>
        {
            try { await Task.Delay(TimeSpan.FromSeconds(delay), cts.Token); }
            catch (OperationCanceledException) { return; }
            lock (_powerLock) { if (_pending?.Cts != cts) return; _pending = null; }
            if (_gate.Stopped) return;
            _logger?.LogWarning("[System] Performing the approved {Action} now.", action);
            if (_opts.TestPowerSink != null) { _opts.TestPowerSink(action); return; }
            if (action == "sleep") SetSuspendState(false, false, false);
            else ExitWindowsEx(0 /* EWX_LOGOFF */, 0);
        });
        await _gate.AuditAsync("Scheduled", req!, ctx, $"{action} scheduled for {at:O}");
        return DesktopCallResult.Ok(new { executed = true, verified = true, action, scheduledFor = at.ToString("O"), delaySeconds = delay, observed = $"the {action} is scheduled inside D-ASK for {at:HH:mm:ss} unless cancelled" });
    }

    /// <summary>Emergency Stop cancels a scheduled power action (and aborts a Windows-scheduled restart/shutdown).</summary>
    private void StartStopWatch(CancellationTokenSource cts) => _ = Task.Run(async () =>
    {
        while (!cts.IsCancellationRequested)
        {
            try { await Task.Delay(400, cts.Token); } catch (OperationCanceledException) { return; }
            if (_gate.Stopped) { _logger?.LogWarning("[System] Emergency Stop: cancelling the scheduled power action."); await CancelPowerAsync("Emergency Stop", CancellationToken.None); return; }
        }
    });

    public bool PowerPending { get { lock (_powerLock) return _pending != null; } }

    private async Task<DesktopCallResult> CancelPowerAsync(string why, CancellationToken ct)
    {
        PendingPower? p;
        lock (_powerLock) { p = _pending; _pending = null; }
        p?.Cts.Cancel();
        // A Windows-scheduled restart/shutdown (from D-ASK or anything else): shutdown /a; exit 0 = one was pending and is now aborted.
        int code = await RunShutdownExe("/a", ct);
        bool aborted = code == 0;
        int again = aborted ? await RunShutdownExe("/a", ct) : code;   // nothing must be pending any more (1116 = none in progress)
        if (p == null && !aborted) return DesktopCallResult.Ok(new { executed = false, verified = true, observed = "no restart, shutdown, sleep or sign-out was scheduled" });
        bool verified = (p == null || !p.ViaShutdownExe || aborted) && again != 0;
        _logger?.LogInformation("[System] Power action cancelled ({Why}): pending={Pending}, shutdown /a exit {Code}, then {Again}.", why, p?.Action ?? "none", code, again);
        return verified ? DesktopCallResult.Ok(new { executed = true, verified = true, cancelled = p?.Action ?? "a Windows shutdown", observed = $"cancelled ({why}); Windows reports nothing pending any more" })
            : DesktopCallResult.Fail("execution_unverified", $"D-ASK tried to cancel the {p?.Action}, but Windows did not confirm it (shutdown /a exit {code}). Run shutdown /a yourself.");
    }

    private static async Task<int> RunShutdownExe(string args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "shutdown.exe"), args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
        using var p = Process.Start(psi)!;
        await p.WaitForExitAsync(ct);
        return p.ExitCode;
    }

    [DllImport("powrprof.dll")] private static extern bool SetSuspendState(bool hibernate, bool force, bool disableWake);
    [DllImport("user32.dll")] private static extern bool ExitWindowsEx(uint flags, uint reason);
}
