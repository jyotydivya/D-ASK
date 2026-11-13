using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using DAsk.Daemon.Automation.Observation;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Desktop;

public sealed class WindowTextReadOptions
{
    public bool Enabled { get; init; }
    /// <summary>dask-ocr.exe (built with the HUD). Null: looked up beside the HUD build (release, then debug).</summary>
    public string? HelperPath { get; init; }
    public int TimeoutMs { get; init; } = 15_000;
    public int MaxLines { get; init; } = 300;
    public int MaxChars { get; init; } = 20_000;
}

/// <summary>
/// desktop.read_text: read-only text recognition of ONE window the user names. The window is resolved with exactly the
/// read-only tools' rules (DesktopReadService.ResolveTarget: never D-ASK's own windows or other sessions, never a sensitive
/// application, never a guess among several matches). Only that window is captured (PrintWindow, so overlapping windows
/// are not read); its identity is checked again after the capture; the image is recognised OFFLINE by dask-ocr (Windows
/// OCR, no network) and deleted. Nothing is clicked, typed or changed. Off unless AgentHost:DesktopOcr is true.
/// </summary>
public sealed class WindowTextReadService : IDesktopActionRequestService
{
    public const string ReadText = "desktop.read_text";
    public static bool IsUnmetered(string tool) => tool == ReadText;

    private readonly DesktopReadService _desktop;
    private readonly WindowTextReadOptions _opts;
    private readonly ILogger? _logger;
    private readonly string? _helper;

    public WindowTextReadService(DesktopReadService desktop, WindowTextReadOptions options, ILogger? logger = null)
    {
        _desktop = desktop; _opts = options; _logger = logger;
        _helper = options.HelperPath is { } p && File.Exists(p) ? p : FindHelper();
    }

    private static string? FindHelper()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
            foreach (var cfg in new[] { "release", "debug" })
            {
                var p = Path.Combine(d.FullName, "src", "hud-native", "target", cfg, "dask-ocr.exe");
                if (File.Exists(p)) return p;
            }
        return null;
    }

    public IReadOnlyList<string> Tools => _opts.Enabled && _helper != null ? new[] { ReadText } : Array.Empty<string>();
    public int MaxCallMs => _opts.TimeoutMs + 5_000;

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (!Tools.Contains(tool)) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (args.ValueKind != JsonValueKind.Object || args.EnumerateObject().Any(p => p.Name is not ("process" or "titleContains")))
            return DesktopCallResult.Fail("invalid_args", "read_text takes only process and/or titleContains");
        string? S(string n) => args.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        string? process = S("process"), title = S("titleContains");
        if (DesktopReadService.ValidateSelector(process, title) is { } bad) return DesktopCallResult.Fail("invalid_args", bad);
        if (_desktop.ResolveTarget(process, title, "read", out var target) is { } refused) return refused;
        if (target!.Minimized) return DesktopCallResult.Fail("window_minimized", $"The window \"{target.Title}\" is minimized; restore it first.");

        string file = Path.Combine(Path.GetTempPath(), $"dask-ocr-{Guid.NewGuid():N}.bmp");
        try
        {
            if (Capture(new IntPtr(target.Hwnd), file, out int w, out int h) is { } capErr) return DesktopCallResult.Fail("capture_failed", capErr);
            // The window must still be the one resolved (same handle, process and process start) after the capture.
            var again = _desktop.ReadNow(target.Hwnd);
            if (again == null || again.ProcessId != target.ProcessId || again.ProcessCreationFileTime != target.ProcessCreationFileTime)
                return DesktopCallResult.Fail("target_changed", "The window closed or changed while it was being read; nothing is reported.");
            var sw = Stopwatch.StartNew();
            var (ok, json, err) = await RunHelperAsync(file, ct);
            if (!ok) return DesktopCallResult.Fail("ocr_failed", err ?? "Text recognition failed.");
            using var doc = JsonDocument.Parse(json!);
            var root = doc.RootElement;
            if (!root.TryGetProperty("ok", out var okEl) || !okEl.GetBoolean())
                return DesktopCallResult.Fail("ocr_failed", root.TryGetProperty("error", out var e) ? e.GetString() ?? "Text recognition failed." : "Text recognition failed.");
            var lines = new List<object>(); int chars = 0; bool truncated = false;
            foreach (var l in root.GetProperty("lines").EnumerateArray())
            {
                var text = l.GetProperty("text").GetString() ?? "";
                if (lines.Count >= _opts.MaxLines || chars + text.Length > _opts.MaxChars) { truncated = true; break; }
                chars += text.Length;
                lines.Add(new { text, box = l.GetProperty("box").EnumerateArray().Select(x => x.GetInt64()).ToArray() });
            }
            _logger?.LogInformation("[DesktopOcr] read_text for task {TaskId}: {Lines} line(s) from {Process} in {Ms} ms.", ctx.TaskId, lines.Count, target.ImageName, sw.ElapsedMilliseconds);
            return DesktopCallResult.Ok(new
            {
                window = new { process = target.ImageName, title = target.Title, pid = target.ProcessId },
                language = root.TryGetProperty("language", out var lang) ? lang.GetString() : null,
                imageSize = new[] { w, h }, lines, lineCount = lines.Count, truncated, engine = "Windows OCR (offline)",
                capturedAtUtc = DateTimeOffset.UtcNow,
            });
        }
        finally { try { File.Delete(file); } catch { } }
    }

    private async Task<(bool ok, string? json, string? error)> RunHelperAsync(string image, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(_helper!) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        psi.ArgumentList.Add(image);
        using var p = Process.Start(psi);
        if (p == null) return (false, null, "The text recognizer could not start.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(_opts.TimeoutMs);
        try
        {
            var outTask = p.StandardOutput.ReadToEndAsync(timeout.Token);
            await p.WaitForExitAsync(timeout.Token);
            var line = (await outTask).Split('\n').FirstOrDefault(l => l.TrimStart().StartsWith('{'));
            return line == null ? (false, null, "The text recognizer returned nothing.") : (true, line, null);
        }
        catch (OperationCanceledException)
        {
            try { p.Kill(true); } catch { }
            return (false, null, ct.IsCancellationRequested ? "Cancelled." : $"Text recognition took longer than {_opts.TimeoutMs} ms.");
        }
    }

    // ── Capture of one window (PrintWindow: the window's own content, not what covers it) ──────────────────────────

    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr hdc);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct BITMAPINFOHEADER { public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount; public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant; }
    [StructLayout(LayoutKind.Sequential)] private struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public uint bmiColors; }
    private const uint PW_RENDERFULLCONTENT = 0x2;

    public static string? Capture(IntPtr hwnd, string file, out int width, out int height)
    {
        width = height = 0;
        if (!GetWindowRect(hwnd, out var r)) return "The window's size could not be read.";
        width = r.Right - r.Left; height = r.Bottom - r.Top;
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return "The window has no readable area.";
        IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen), bits;
        var bmi = new BITMAPINFO { bmiHeader = new BITMAPINFOHEADER { biSize = 40, biWidth = width, biHeight = -height, biPlanes = 1, biBitCount = 32, biCompression = 0 } };
        IntPtr dib = CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0);
        try
        {
            if (dib == IntPtr.Zero) return "No memory for the capture.";
            var old = SelectObject(mem, dib);
            bool ok = PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT);
            SelectObject(mem, old);
            if (!ok) return "The window could not be captured.";
            int stride = width * 4, size = stride * height;
            var pixels = new byte[size];
            Marshal.Copy(bits, pixels, 0, size);
            using var fs = File.Create(file);
            using var bw = new BinaryWriter(fs);
            bw.Write((ushort)0x4D42); bw.Write(54 + size); bw.Write(0); bw.Write(54);                       // BITMAPFILEHEADER
            bw.Write(40); bw.Write(width); bw.Write(-height); bw.Write((ushort)1); bw.Write((ushort)32);     // BITMAPINFOHEADER (top-down)
            bw.Write(0); bw.Write(size); bw.Write(2835); bw.Write(2835); bw.Write(0); bw.Write(0);
            bw.Write(pixels);
            return null;
        }
        finally { if (dib != IntPtr.Zero) DeleteObject(dib); DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen); }
    }
}
