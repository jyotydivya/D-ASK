// ─────────────────────────────────────────────────────────────────────────────
// Dedicated screen-capture LATENCY benchmark (Phase 7B.3).
//
// Measures the UNMODIFIED production Win32ScreenObservationService, using the same metric the former gating test used
// (CaptureObservationResponse.CaptureDurationMs, pure capture: no UI Automation, no thumbnail) and the same target:
//     median < 30 ms  AND  P95 < 50 ms.
// The target is not changed here and no measurement is filtered, trimmed, retried or adjusted.
//
// Two conditions are measured and reported separately:
//   COLD  : the first N captures of a FRESH process, no warm-up (the protocol of the former gating test: N = 30),
//           repeated in R fresh processes.
//   WARM  : steady state in one process, after W discarded warm-up captures, then N samples.
// "Target achieved" is claimed only if EVERY measured condition meets it. Otherwise the result is NOT ACHIEVED and the
// exit code is 1, so a failure stays visible. This is deliberately NOT run by `dotnet test`.
//
// Run:  dotnet run --project tests/DAsk.Benchmarks.ScreenCapture -c Debug -- [--cold-runs 5] [--cold-samples 30]
//                                                                           [--warmup 20] [--warm-samples 300] [--out <dir>]
// Exit codes: 0 achieved, 1 NOT achieved, 2 error.
// ─────────────────────────────────────────────────────────────────────────────

using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using DAsk.Daemon.Automation.Observation;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Win32;

internal static class Program
{
    private const double MedianBudgetMs = 30.0;
    private const double P95BudgetMs = 50.0;

#if DEBUG
    private const string Configuration = "Debug";
#else
    private const string Configuration = "Release";
#endif

    private static async Task<int> Main(string[] args)
    {
        try
        {
            var a = Args.Parse(args);
            DpiCoordinateConverter.InitializeDpiAwareness(); // as the daemon does before any capture
            if (a.ColdChild) return await ColdChildAsync(a);
            return await RunAsync(a);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("benchmark error: " + ex);
            return 2;
        }
    }

    // ── one fresh process: first N captures, no warm-up ─────────────────────
    private static async Task<int> ColdChildAsync(Args a)
    {
        using var buffers = new ObservationBufferManager();
        using var uia = new WindowsUiAutomationService();
        var service = new Win32ScreenObservationService(buffers, uia);
        var samples = new List<double>();
        int w = 0, h = 0; double scale = 0;
        for (int i = 0; i < a.ColdSamples; i++)
        {
            var r = await service.CaptureAsync(new CaptureObservationRequest { IncludeUiAutomation = false, GeneratePreviewThumbnail = false });
            if (!r.Success) { Console.Error.WriteLine("capture failed in cold child"); return 2; }
            samples.Add(r.CaptureDurationMs);
            (w, h, scale) = (r.PhysicalWidth, r.PhysicalHeight, r.DpiScale);
            buffers.TryReleaseBuffer(r.ObservationId);
        }
        Console.WriteLine(JsonSerializer.Serialize(new ColdResult(samples, w, h, scale)));
        return 0;
    }

    // ── the full benchmark ──────────────────────────────────────────────────
    private static async Task<int> RunAsync(Args a)
    {
        string stamp = DateTime.Now.ToString("yyyyMMdd'T'HHmmss", CultureInfo.InvariantCulture);
        string outDir = a.Out ?? Path.Combine(FindRepoRoot(), "results", "phase7b3", "benchmark", stamp);
        Directory.CreateDirectory(outDir);
        var report = new StringBuilder();
        void Say(string s = "") { Console.WriteLine(s); report.AppendLine(s); }

        Say("D-ASK screen-capture latency benchmark (dedicated; not part of the correctness suite)");
        Say($"started {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}");
        Say($"target: median < {MedianBudgetMs:F0} ms AND P95 < {P95BudgetMs:F0} ms (unchanged; metric = CaptureDurationMs, pure capture)");
        Say();

        var env = new Env();
        Say("ENVIRONMENT");
        foreach (var (k, v) in env.Describe()) Say($"  {k,-34} {v}");
        double cpuBefore = CpuSampler.Sample(TimeSpan.FromSeconds(2));
        Say($"  {"system CPU, 2 s before start",-34} {cpuBefore:F1} %");
        Say();

        // COLD: fresh processes, first N captures each, no warm-up.
        var cold = new List<ColdResult>();
        double cpuColdStart = CpuSampler.Now();
        Say($"COLD START: {a.ColdRuns} fresh processes x first {a.ColdSamples} captures, no warm-up");
        for (int i = 0; i < a.ColdRuns; i++)
        {
            var r = RunColdChild(a);
            cold.Add(r);
            var s = Stats.Of(r.Samples);
            Say($"  process {i + 1}: first={r.Samples[0],6:F2}  median={s.Median,6:F2}  P95={s.P95,6:F2}  max={s.Max,6:F2}  -> {(Meets(s) ? "meets" : "MISSES")} target");
        }
        double cpuColdAvg = CpuSampler.Since(cpuColdStart);
        var coldAll = cold.SelectMany(c => c.Samples).ToList();
        var coldStats = Stats.Of(coldAll);
        var firstCalls = cold.Select(c => c.Samples[0]).ToList();
        Say($"  all cold samples: n={coldAll.Count}  median={coldStats.Median:F2}  P95={coldStats.P95:F2}  max={coldStats.Max:F2}");
        Say($"  very first capture of each process: median={Stats.Of(firstCalls).Median:F2} ms  max={firstCalls.Max():F2} ms");
        bool coldAchieved = cold.All(c => Meets(Stats.Of(c.Samples)));
        Say($"  COLD result: {cold.Count(c => Meets(Stats.Of(c.Samples)))} of {cold.Count} fresh processes met the target -> {(coldAchieved ? "ACHIEVED" : "NOT ACHIEVED")}");
        Say();

        // WARM: steady state in this process.
        using var buffers = new ObservationBufferManager();
        using var uia = new WindowsUiAutomationService();
        var service = new Win32ScreenObservationService(buffers, uia);
        var req = () => new CaptureObservationRequest { IncludeUiAutomation = false, GeneratePreviewThumbnail = false };
        var warmup = new List<double>();
        for (int i = 0; i < a.Warmup; i++)
        {
            var r = await service.CaptureAsync(req());
            warmup.Add(r.CaptureDurationMs); buffers.TryReleaseBuffer(r.ObservationId);
        }
        var warm = new List<double>(); var wall = new List<double>();
        int width = 0, height = 0; double scale = 0; var sw = new Stopwatch();
        double cpuWarmStart = CpuSampler.Now();
        for (int i = 0; i < a.WarmSamples; i++)
        {
            sw.Restart();
            var r = await service.CaptureAsync(req());
            wall.Add(sw.Elapsed.TotalMilliseconds);
            if (!r.Success) throw new InvalidOperationException("capture failed during the warm run");
            warm.Add(r.CaptureDurationMs); (width, height, scale) = (r.PhysicalWidth, r.PhysicalHeight, r.DpiScale);
            buffers.TryReleaseBuffer(r.ObservationId);
        }
        double cpuWarmAvg = CpuSampler.Since(cpuWarmStart);
        var warmStats = Stats.Of(warm);
        bool warmAchieved = Meets(warmStats);
        Say($"WARM STEADY STATE: {a.Warmup} discarded warm-up captures, then n = {warm.Count} (captured {width}x{height}, DPI scale {scale:F2})");
        Say($"  warm-up (discarded) first 10: {string.Join(" ", warmup.Take(10).Select(x => x.ToString("F1", CultureInfo.InvariantCulture)))}");
        Say($"  min={warmStats.Min:F2}  median={warmStats.Median:F2}  mean={warmStats.Mean:F2}  P95={warmStats.P95:F2}  max={warmStats.Max:F2}  stdev={warmStats.Stdev:F2}  (ms)");
        Say($"  share of samples under {MedianBudgetMs:F0} ms: {warm.Count(x => x < MedianBudgetMs) * 100.0 / warm.Count:F0} %;   CaptureAsync wall-clock median {Stats.Of(wall).Median:F2} ms");
        Say("  distribution (CaptureDurationMs, 4 ms bins):");
        foreach (var line in Histogram(warm)) Say("    " + line);
        Say($"  WARM result: median {(warmStats.Median < MedianBudgetMs ? "<" : ">=")} {MedianBudgetMs:F0} ms, P95 {(warmStats.P95 < P95BudgetMs ? "<" : ">=")} {P95BudgetMs:F0} ms -> {(warmAchieved ? "ACHIEVED" : "NOT ACHIEVED")}");
        Say();

        double cpuAfter = CpuSampler.Sample(TimeSpan.FromSeconds(2));
        Say($"MACHINE LOAD: system CPU during cold phase {cpuColdAvg:F1} %, during warm phase {cpuWarmAvg:F1} %, 2 s after {cpuAfter:F1} %; running processes {Process.GetProcesses().Length}; physical memory available at end {Env.AvailableMB()} MB");
        bool achieved = coldAchieved && warmAchieved;
        Say();
        Say($"30 ms TARGET: {(achieved ? "ACHIEVED" : "NOT ACHIEVED")}   (cold: {(coldAchieved ? "achieved" : "not achieved")}; warm steady state: {(warmAchieved ? "achieved" : "not achieved")})");
        Say("This result is reported as measured. It is not part of the correctness suite, and nothing was filtered or adjusted.");

        File.WriteAllText(Path.Combine(outDir, "screen-capture-latency.txt"), report.ToString());
        File.WriteAllText(Path.Combine(outDir, "screen-capture-latency.json"), JsonSerializer.Serialize(new
        {
            startedLocal = DateTimeOffset.Now.ToString("o"),
            targetMedianMs = MedianBudgetMs, targetP95Ms = P95BudgetMs, configuration = Configuration,
            environment = env.Describe().ToDictionary(x => x.Key, x => x.Value),
            systemCpuPercent = new { before = cpuBefore, cold = cpuColdAvg, warm = cpuWarmAvg, after = cpuAfter },
            cold = new { runs = cold.Count, samplesPerRun = a.ColdSamples, perRun = cold.Select(c => new { stats = Stats.Of(c.Samples), first = c.Samples[0], meets = Meets(Stats.Of(c.Samples)) }), all = coldStats, achieved = coldAchieved },
            warm = new { warmupDiscarded = a.Warmup, samples = warm.Count, capturedWidth = width, capturedHeight = height, dpiScale = scale, stats = warmStats, achieved = warmAchieved },
            targetAchieved = achieved,
        }, new JsonSerializerOptions { WriteIndented = true }));
        File.WriteAllText(Path.Combine(outDir, "samples.csv"),
            "phase,run,index,capture_ms\n" +
            string.Join("\n", cold.SelectMany((c, r) => c.Samples.Select((v, i) => $"cold,{r + 1},{i + 1},{v.ToString("F3", CultureInfo.InvariantCulture)}")).Concat(
                warm.Select((v, i) => $"warm,1,{i + 1},{v.ToString("F3", CultureInfo.InvariantCulture)}"))));
        Console.WriteLine($"evidence written to {outDir}");
        return achieved ? 0 : 1;
    }

    private static bool Meets(Stats s) => s.Median < MedianBudgetMs && s.P95 < P95BudgetMs;

    private static ColdResult RunColdChild(Args a)
    {
        string exe = Environment.ProcessPath!;
        var psi = new ProcessStartInfo { FileName = exe, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        if (Path.GetFileNameWithoutExtension(exe).Equals("dotnet", StringComparison.OrdinalIgnoreCase)) psi.ArgumentList.Add(typeof(Program).Assembly.Location);
        psi.ArgumentList.Add("--cold-child"); psi.ArgumentList.Add("--cold-samples"); psi.ArgumentList.Add(a.ColdSamples.ToString(CultureInfo.InvariantCulture));
        using var p = Process.Start(psi)!;
        string o = p.StandardOutput.ReadToEnd(); string e = p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0) throw new InvalidOperationException($"cold child failed ({p.ExitCode}): {e}");
        return JsonSerializer.Deserialize<ColdResult>(o.Trim().Split('\n').Last())!;
    }

    private static IEnumerable<string> Histogram(List<double> v)
    {
        var bins = v.GroupBy(x => (int)(x / 4) * 4).OrderBy(g => g.Key).ToList();
        int max = bins.Max(b => b.Count());
        foreach (var b in bins) yield return $"{b.Key,3}-{b.Key + 4,-3} ms {new string('#', Math.Max(1, b.Count() * 40 / max)),-40} {b.Count()}";
    }

    private static string FindRepoRoot()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, "src", "DAsk.Daemon")) && Directory.Exists(Path.Combine(d.FullName, "tests"))) return d.FullName;
        return Directory.GetCurrentDirectory();
    }
}

internal sealed record ColdResult(List<double> Samples, int Width, int Height, double Scale);

internal sealed record Stats(int N, double Min, double Median, double Mean, double P95, double Max, double Stdev)
{
    public static Stats Of(List<double> v)
    {
        var s = v.OrderBy(x => x).ToList();
        double mean = s.Average();
        return new Stats(s.Count, s[0], s[s.Count / 2], mean, s[Math.Min(s.Count - 1, (int)(s.Count * 0.95))], s[^1], Math.Sqrt(s.Sum(x => (x - mean) * (x - mean)) / s.Count));
    }
}

internal sealed class Args
{
    public int ColdRuns = 5, ColdSamples = 30, Warmup = 20, WarmSamples = 300;
    public string? Out; public bool ColdChild;
    public static Args Parse(string[] a)
    {
        var r = new Args();
        for (int i = 0; i < a.Length; i++)
        {
            switch (a[i])
            {
                case "--cold-runs": r.ColdRuns = int.Parse(a[++i], CultureInfo.InvariantCulture); break;
                case "--cold-samples": r.ColdSamples = int.Parse(a[++i], CultureInfo.InvariantCulture); break;
                case "--warmup": r.Warmup = int.Parse(a[++i], CultureInfo.InvariantCulture); break;
                case "--warm-samples": r.WarmSamples = int.Parse(a[++i], CultureInfo.InvariantCulture); break;
                case "--out": r.Out = a[++i]; break;
                case "--cold-child": r.ColdChild = true; break;
                default: throw new ArgumentException("unknown argument " + a[i]);
            }
        }
        return r;
    }
}

/// <summary>System CPU utilisation from GetSystemTimes deltas.</summary>
internal static class CpuSampler
{
    [DllImport("kernel32.dll")] private static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
    private static (long idle, long total) Read() { GetSystemTimes(out var i, out var k, out var u); return (i, k + u); }
    private static readonly Dictionary<double, (long, long)> Marks = new();
    private static double _next = 1;
    public static double Now() { var (i, t) = Read(); double id = _next++; Marks[id] = (i, t); return id; }
    public static double Since(double id) { var (i0, t0) = Marks[id]; var (i1, t1) = Read(); return t1 == t0 ? 0 : (1.0 - (double)(i1 - i0) / (t1 - t0)) * 100.0; }
    public static double Sample(TimeSpan d) { double m = Now(); Thread.Sleep(d); return Since(m); }
}

internal sealed class Env
{
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern int GetDeviceCaps(IntPtr dc, int index);
    [StructLayout(LayoutKind.Sequential)] private struct PowerStatus { public byte AC, Flag, Percent, Saver; public int LifeTime, FullLifeTime; }
    [DllImport("kernel32.dll")] private static extern bool GetSystemPowerStatus(out PowerStatus s);

    public IEnumerable<KeyValuePair<string, string>> Describe()
    {
        var l = new List<KeyValuePair<string, string>>();
        void Add(string k, string v) => l.Add(new(k, v));
        Add("OS", RuntimeInformation.OSDescription);
        Add(".NET runtime / build configuration", $"{RuntimeInformation.FrameworkDescription} / {Configuration()}");
        Add("measured DAsk.Daemon.dll build", DaemonBuild());
        Add("physical memory available / total", $"{AvailableMB()} MB / {TotalMB()} MB");
        Add("CPU", Reg(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString") + $" ({Environment.ProcessorCount} logical)");
        Add("GPU", string.Join(", ", Enumerable.Range(0, 4).Select(i => Reg($@"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{{4d36e968-e325-11ce-bfc1-08002be10318}}\{i:D4}", "DriverDesc")).Where(x => x != "?")));
        Add("process DPI awareness", DpiCoordinateConverter.GetRuntimeDpiAwareness());
        IntPtr dc = GetDC(IntPtr.Zero);
        try { Add("display refresh rate", GetDeviceCaps(dc, 116) + " Hz"); } finally { ReleaseDC(IntPtr.Zero, dc); }
        if (GetSystemPowerStatus(out var p)) Add("power source", (p.AC == 1 ? "AC" : p.AC == 0 ? "battery" : "unknown") + (p.Percent <= 100 ? $", battery {p.Percent} %" : "") + (p.Saver == 1 ? ", battery saver ON" : ""));
        Add("active power plan", PowerPlan());
        Add("process priority / our PID", $"{Process.GetCurrentProcess().PriorityClass} / {Environment.ProcessId}");
        Add("running processes at start", Process.GetProcesses().Length.ToString(CultureInfo.InvariantCulture));
        return l;
    }

    private static string Configuration() =>
#if DEBUG
        "Debug";
#else
        "Release";
#endif

    /// <summary>Whether the loaded daemon assembly is an optimised (Release) or a debug build, from its DebuggableAttribute.</summary>
    private static string DaemonBuild()
    {
        var asm = typeof(Win32ScreenObservationService).Assembly;
        var d = (DebuggableAttribute?)Attribute.GetCustomAttribute(asm, typeof(DebuggableAttribute));
        bool optimised = d == null || !d.IsJITOptimizerDisabled;
        return $"{(optimised ? "Release (JIT-optimised)" : "Debug (JIT optimisation disabled)")}: {asm.Location}";
    }

    [StructLayout(LayoutKind.Sequential)] private struct MemStatus { public uint Length, Load; public ulong TotalPhys, AvailPhys, TotalPage, AvailPage, TotalVirt, AvailVirt, AvailExt; }
    [DllImport("kernel32.dll")] private static extern bool GlobalMemoryStatusEx(ref MemStatus m);
    private static MemStatus Mem() { var m = new MemStatus { Length = (uint)Marshal.SizeOf<MemStatus>() }; GlobalMemoryStatusEx(ref m); return m; }
    public static ulong AvailableMB() => Mem().AvailPhys / 1048576;
    private static ulong TotalMB() => Mem().TotalPhys / 1048576;

    private static string Reg(string key, string name) { try { return Registry.GetValue(key, name, null)?.ToString()?.Trim() ?? "?"; } catch { return "?"; } }

    private static string PowerPlan()
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo("powercfg", "/getactivescheme") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true })!;
            string o = p.StandardOutput.ReadToEnd().Trim(); p.WaitForExit(3000);
            int i = o.IndexOf('('); return i >= 0 ? o[(i + 1)..].TrimEnd(')') : o;
        }
        catch { return "unknown"; }
    }
}
