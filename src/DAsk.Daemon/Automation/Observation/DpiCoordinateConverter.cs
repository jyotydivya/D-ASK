using System.Runtime.InteropServices;

namespace DAsk.Daemon.Automation.Observation;

public static class DpiCoordinateConverter
{
    public const double StandardDpi = 96.0;

    #region Win32 DPI Awareness Context Constants & P/Invoke

    // DPI_AWARENESS_CONTEXT values
    // -1 = Unaware
    // -2 = System Aware
    // -3 = Per-Monitor Aware
    // -4 = Per-Monitor Aware V2 (Windows 10 1703+)
    // -5 = Unaware (GDIScaled)
    public static readonly IntPtr DPI_AWARENESS_CONTEXT_UNAWARE = new(-1);
    public static readonly IntPtr DPI_AWARENESS_CONTEXT_SYSTEM_AWARE = new(-2);
    public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE = new(-3);
    public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new(-4);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("shcore.dll", SetLastError = true)]
    private static extern int GetProcessDpiAwareness(IntPtr hprocess, out int awareness);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    #endregion

    /// <summary>
    /// Establishes Per-Monitor DPI Awareness V2 programmatically before any GDI or window creation operations.
    /// </summary>
    public static bool InitializeDpiAwareness()
    {
        try
        {
            return SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Inspects and returns the actual runtime DPI awareness of the current process.
    /// </summary>
    public static string GetRuntimeDpiAwareness()
    {
        try
        {
            int hr = GetProcessDpiAwareness(GetCurrentProcess(), out int awareness);
            if (hr == 0)
            {
                return awareness switch
                {
                    2 => "PerMonitorV2",
                    1 => "SystemAware",
                    0 => "Unaware",
                    _ => $"Awareness_{awareness}"
                };
            }
            return $"HResult_{hr:X}";
        }
        catch (Exception ex)
        {
            return $"Error: {ex.Message}";
        }
    }

    public static (int X, int Y) PhysicalToLogical(int physicalX, int physicalY, double dpiScale)
    {
        if (dpiScale <= 0) dpiScale = 1.0;
        return ((int)Math.Round(physicalX / dpiScale), (int)Math.Round(physicalY / dpiScale));
    }

    public static (int X, int Y) LogicalToPhysical(int logicalX, int logicalY, double dpiScale)
    {
        if (dpiScale <= 0) dpiScale = 1.0;
        return ((int)Math.Round(logicalX * dpiScale), (int)Math.Round(logicalY * dpiScale));
    }

    public static (int Width, int Height) ScaleDimensions(int width, int height, double dpiScale)
    {
        if (dpiScale <= 0) dpiScale = 1.0;
        return ((int)Math.Round(width * dpiScale), (int)Math.Round(height * dpiScale));
    }

    public static double DpiToScale(uint dpi)
    {
        if (dpi == 0) return 1.0;
        return Math.Round(dpi / StandardDpi, 4);
    }
}
