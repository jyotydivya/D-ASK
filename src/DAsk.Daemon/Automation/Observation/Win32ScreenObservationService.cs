using System.Buffers;
using System.Diagnostics;
using System.Runtime.InteropServices;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Observation;

public class Win32ScreenObservationService : IScreenObservationService
{
    private readonly ILogger<Win32ScreenObservationService>? _logger;
    private readonly ObservationBufferManager _bufferManager;
    private readonly IUiAutomationService _uiAutomationService;

    public Win32ScreenObservationService(
        ObservationBufferManager bufferManager,
        IUiAutomationService uiAutomationService,
        ILogger<Win32ScreenObservationService>? logger = null)
    {
        _bufferManager = bufferManager;
        _uiAutomationService = uiAutomationService;
        _logger = logger;
    }

    #region Win32 P/Invoke & Structures

    private const int SRCCOPY = 0x00CC0020;
    private const int CAPTUREBLT = 0x40000000;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int BI_RGB = 0;
    private const int DIB_RGB_COLORS = 0;

    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateDIBSection(IntPtr hdc, [In] ref BITMAPINFO pbmi, uint pila, out IntPtr ppvBits, IntPtr hSection, uint dwOffset);

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO
    {
        public BITMAPINFOHEADER bmiHeader;
        public uint bmiColors;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumDelegate lpfnEnum, IntPtr dwData);
    private delegate bool MonitorEnumDelegate(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

    private const int CCHDEVICENAME = 32;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCHDEVICENAME)]
        public string szDevice;
    }

    private const int MONITORINFOF_PRIMARY = 0x00000001;

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    #endregion

    public IReadOnlyList<DisplayInfo> EnumerateDisplays()
    {
        var displays = new List<DisplayInfo>();
        int index = 0;

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData) =>
        {
            var mi = new MONITORINFOEX();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));

            if (GetMonitorInfo(hMonitor, ref mi))
            {
                uint dpiX = 96, dpiY = 96;
                try
                {
                    GetDpiForMonitor(hMonitor, 0 /* MDT_EFFECTIVE_DPI */, out dpiX, out dpiY);
                }
                catch
                {
                    dpiX = 96;
                    dpiY = 96;
                }

                bool isPrimary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
                int width = mi.rcMonitor.Right - mi.rcMonitor.Left;
                int height = mi.rcMonitor.Bottom - mi.rcMonitor.Top;

                displays.Add(new DisplayInfo
                {
                    Index = index++,
                    DeviceName = mi.szDevice ?? $"Display_{index}",
                    X = mi.rcMonitor.Left,
                    Y = mi.rcMonitor.Top,
                    Width = width,
                    Height = height,
                    IsPrimary = isPrimary,
                    DpiScale = DpiCoordinateConverter.DpiToScale(dpiX),
                    DpiX = dpiX,
                    DpiY = dpiY
                });
            }

            return true;
        }, IntPtr.Zero);

        if (displays.Count == 0)
        {
            // Virtual display fallback
            displays.Add(new DisplayInfo
            {
                Index = 0,
                DeviceName = "PrimaryDisplay",
                X = GetSystemMetrics(SM_XVIRTUALSCREEN),
                Y = GetSystemMetrics(SM_YVIRTUALSCREEN),
                Width = GetSystemMetrics(SM_CXVIRTUALSCREEN),
                Height = GetSystemMetrics(SM_CYVIRTUALSCREEN),
                IsPrimary = true,
                DpiScale = 1.0,
                DpiX = 96,
                DpiY = 96
            });
        }

        return displays;
    }

    public ActiveWindowMetadata? GetActiveWindow()
    {
        IntPtr hwnd = GetForegroundWindow();
        return hwnd != IntPtr.Zero ? GetWindowMetadata(hwnd) : null;
    }

    public ActiveWindowMetadata? GetWindowMetadata(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return null;

        var titleSb = new System.Text.StringBuilder(512);
        GetWindowText(hwnd, titleSb, 512);

        var classSb = new System.Text.StringBuilder(256);
        GetClassName(hwnd, classSb, 256);

        GetWindowThreadProcessId(hwnd, out uint pid);
        string processName = string.Empty;
        try
        {
            using var proc = Process.GetProcessById((int)pid);
            processName = proc.ProcessName;
        }
        catch
        {
            processName = "Unknown";
        }

        RECT frameRect;
        int hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out frameRect, Marshal.SizeOf(typeof(RECT)));
        if (hr != 0)
        {
            GetWindowRect(hwnd, out frameRect);
        }

        uint dpi = 96;
        try
        {
            dpi = GetDpiForWindow(hwnd);
        }
        catch
        {
            dpi = 96;
        }

        int physWidth = frameRect.Right - frameRect.Left;
        int physHeight = frameRect.Bottom - frameRect.Top;
        double dpiScale = DpiCoordinateConverter.DpiToScale(dpi);
        var (logX, logY) = DpiCoordinateConverter.PhysicalToLogical(frameRect.Left, frameRect.Top, dpiScale);
        var (logW, logH) = DpiCoordinateConverter.PhysicalToLogical(physWidth, physHeight, dpiScale);

        int clientX = 0, clientY = 0, clientW = 0, clientH = 0;
        if (GetClientRect(hwnd, out var clientRect))
        {
            var pt = new POINT { X = clientRect.Left, Y = clientRect.Top };
            if (ClientToScreen(hwnd, ref pt))
            {
                clientX = pt.X;
                clientY = pt.Y;
                clientW = clientRect.Right - clientRect.Left;
                clientH = clientRect.Bottom - clientRect.Top;
            }
        }

        return new ActiveWindowMetadata
        {
            Hwnd = hwnd.ToInt64(),
            Title = titleSb.ToString(),
            ProcessName = processName,
            ProcessId = (int)pid,
            ClassName = classSb.ToString(),
            X = frameRect.Left,
            Y = frameRect.Top,
            Width = physWidth,
            Height = physHeight,
            IsMinimized = IsIconic(hwnd),
            IsMaximized = IsZoomed(hwnd),
            DpiScale = dpiScale,
            LogicalX = logX,
            LogicalY = logY,
            LogicalWidth = logW,
            LogicalHeight = logH,
            ClientX = clientX,
            ClientY = clientY,
            ClientWidth = clientW,
            ClientHeight = clientH
        };
    }

    public int ReleaseSessionBuffers(string sessionId) => _bufferManager.ReleaseSessionBuffers(sessionId);

    public async Task<CaptureObservationResponse> CaptureAsync(
        CaptureObservationRequest request,
        uint? clientProcessId = null,
        string? sessionId = null,
        CancellationToken cancellationToken = default)
    {
        string observationId = Guid.NewGuid().ToString("N");
        var totalSw = Stopwatch.StartNew();
        var captureSw = Stopwatch.StartNew();

        var displays = EnumerateDisplays();
        DisplayInfo targetDisplay = displays.FirstOrDefault(d => d.IsPrimary) ?? displays[0];

        if (request.TargetDisplayIndex.HasValue && request.TargetDisplayIndex.Value >= 0 && request.TargetDisplayIndex.Value < displays.Count)
        {
            targetDisplay = displays[request.TargetDisplayIndex.Value];
        }

        int captureX = targetDisplay.X;
        int captureY = targetDisplay.Y;
        int captureWidth = targetDisplay.Width;
        int captureHeight = targetDisplay.Height;

        // Perform GDI Screen Capture using DIBSection
        IntPtr hdcScreen = GetDC(IntPtr.Zero);
        IntPtr hdcMem = CreateCompatibleDC(hdcScreen);

        IntPtr hBitmap = IntPtr.Zero;
        IntPtr pBits = IntPtr.Zero;
        IntPtr hOldBitmap = IntPtr.Zero;

        int rowBytes = ((captureWidth * 32 + 31) / 32) * 4;
        int totalImageBytes = rowBytes * captureHeight;

        string sharedMemoryName = string.Empty;
        long? targetHandle = null;
        string? previewThumbnailBase64 = null;
        double captureDurationMs = 0;

        try
        {
            var bmi = new BITMAPINFO();
            bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
            bmi.bmiHeader.biWidth = captureWidth;
            bmi.bmiHeader.biHeight = -captureHeight; // Top-down DIB
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB;
            bmi.bmiHeader.biSizeImage = (uint)totalImageBytes;

            hBitmap = CreateDIBSection(hdcMem, ref bmi, DIB_RGB_COLORS, out pBits, IntPtr.Zero, 0);
            if (hBitmap == IntPtr.Zero || pBits == IntPtr.Zero)
            {
                throw new InvalidOperationException("Failed to allocate DIBSection for screen capture.");
            }

            hOldBitmap = SelectObject(hdcMem, hBitmap);

            // BitBlt with SRCCOPY | CAPTUREBLT for accurate layered window capture
            bool bitBltSuccess = BitBlt(
                hdcMem, 0, 0, captureWidth, captureHeight,
                hdcScreen, captureX, captureY,
                SRCCOPY | CAPTUREBLT);

            if (!bitBltSuccess)
            {
                // Fallback without CAPTUREBLT
                BitBlt(hdcMem, 0, 0, captureWidth, captureHeight, hdcScreen, captureX, captureY, SRCCOPY);
            }

            captureDurationMs = captureSw.Elapsed.TotalMilliseconds;

            // Copy pixel data to Shared Memory via non-async helper
            (sharedMemoryName, targetHandle) = CopyToSharedBuffer(
                observationId, pBits, totalImageBytes, clientProcessId, sessionId);

            // Optional bounded thumbnail creation
            if (request.GeneratePreviewThumbnail)
            {
                previewThumbnailBase64 = GenerateCompactBmpThumbnail(
                    pBits, captureWidth, captureHeight,
                    Math.Min(request.PreviewMaxWidth, 160),
                    Math.Min(request.PreviewMaxHeight, 90));
            }
        }
        finally
        {
            if (hOldBitmap != IntPtr.Zero) SelectObject(hdcMem, hOldBitmap);
            if (hBitmap != IntPtr.Zero) DeleteObject(hBitmap);
            if (hdcMem != IntPtr.Zero) DeleteDC(hdcMem);
            if (hdcScreen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, hdcScreen);
        }

        // Active Window & UI Automation
        IntPtr targetHwnd = request.TargetHwnd.HasValue && request.TargetHwnd.Value != 0
            ? new IntPtr(request.TargetHwnd.Value)
            : GetForegroundWindow();

        var activeWindow = targetHwnd != IntPtr.Zero ? GetWindowMetadata(targetHwnd) : null;
        IReadOnlyList<UiElementInfo> uiElements = Array.Empty<UiElementInfo>();
        string uiaStatus = "Skipped";
        double uiaDurationMs = 0;

        if (request.IncludeUiAutomation && targetHwnd != IntPtr.Zero)
        {
            var uiaSw = Stopwatch.StartNew();
            var uiaResult = await _uiAutomationService.InspectWindowAsync(
                targetHwnd,
                request.UiaTimeoutMs,
                100,
                cancellationToken);

            uiElements = uiaResult.Elements;
            uiaStatus = uiaResult.Status;
            uiaDurationMs = uiaSw.Elapsed.TotalMilliseconds;
        }

        string overallStatus = uiaStatus == "PartialUiaTimeout" ? "PartialUiaTimeout" : "Captured";

        return new CaptureObservationResponse
        {
            RequestId = request.RequestId,
            ObservationId = observationId,
            Timestamp = DateTimeOffset.UtcNow,
            Success = true,
            Status = overallStatus,
            DisplayIndex = targetDisplay.Index,
            PhysicalWidth = captureWidth,
            PhysicalHeight = captureHeight,
            DpiScale = targetDisplay.DpiScale,
            SharedMemoryName = sharedMemoryName ?? string.Empty,
            TargetHandle = targetHandle,
            DataSizeBytes = totalImageBytes,
            Format = "raw_bgra32",
            ActiveWindow = activeWindow,
            UiElements = uiElements,
            AllDisplays = displays,
            CaptureDurationMs = captureDurationMs,
            UiaDurationMs = uiaDurationMs,
            PreviewThumbnailBase64 = previewThumbnailBase64
        };
    }

    private (string? SharedMemoryName, long? TargetHandle) CopyToSharedBuffer(
        string observationId, IntPtr pBits, int totalBytes, uint? clientProcessId, string? sessionId)
    {
        unsafe
        {
            var span = new ReadOnlySpan<byte>(pBits.ToPointer(), totalBytes);
            return _bufferManager.CreateSharedBuffer(observationId, span, clientProcessId, sessionId);
        }
    }

    private static string? GenerateCompactBmpThumbnail(
        IntPtr pBits, int srcWidth, int srcHeight, int maxWidth, int maxHeight)
    {
        try
        {
            double ratioX = (double)maxWidth / srcWidth;
            double ratioY = (double)maxHeight / srcHeight;
            double ratio = Math.Min(ratioX, ratioY);

            int thumbWidth = Math.Max(1, (int)(srcWidth * ratio));
            int thumbHeight = Math.Max(1, (int)(srcHeight * ratio));

            // Standard 24-bit BMP row width (padded to multiple of 4 bytes)
            int rowStride = ((thumbWidth * 3 + 3) / 4) * 4;
            int pixelDataSize = rowStride * thumbHeight;
            int totalFileSize = 54 + pixelDataSize;

            byte[] bmpBytes = new byte[totalFileSize];

            // 14-byte BITMAPFILEHEADER
            bmpBytes[0] = (byte)'B';
            bmpBytes[1] = (byte)'M';
            BitConverter.TryWriteBytes(bmpBytes.AsSpan(2, 4), (uint)totalFileSize);
            BitConverter.TryWriteBytes(bmpBytes.AsSpan(10, 4), 54u); // Pixel data offset

            // 40-byte BITMAPINFOHEADER
            BitConverter.TryWriteBytes(bmpBytes.AsSpan(14, 4), 40u); // Header size
            BitConverter.TryWriteBytes(bmpBytes.AsSpan(18, 4), thumbWidth);
            BitConverter.TryWriteBytes(bmpBytes.AsSpan(22, 4), thumbHeight); // Bottom-up BMP
            BitConverter.TryWriteBytes(bmpBytes.AsSpan(26, 2), (ushort)1); // Planes
            BitConverter.TryWriteBytes(bmpBytes.AsSpan(28, 2), (ushort)24); // 24 bpp (BGR)
            BitConverter.TryWriteBytes(bmpBytes.AsSpan(30, 4), 0u); // Compression = BI_RGB
            BitConverter.TryWriteBytes(bmpBytes.AsSpan(34, 4), (uint)pixelDataSize);

            // Nearest-neighbor / box sampling from 32-bit BGRA to 24-bit BGR
            unsafe
            {
                byte* srcPtr = (byte*)pBits.ToPointer();
                for (int ty = 0; ty < thumbHeight; ty++)
                {
                    // Map bottom-up BMP ty to top-down source sy
                    int sy = (int)((thumbHeight - 1 - ty) / ratio);
                    if (sy >= srcHeight) sy = srcHeight - 1;

                    int destRowOffset = 54 + ty * rowStride;
                    int srcRowOffset = sy * srcWidth * 4;

                    for (int tx = 0; tx < thumbWidth; tx++)
                    {
                        int sx = (int)(tx / ratio);
                        if (sx >= srcWidth) sx = srcWidth - 1;

                        int srcPixelOffset = srcRowOffset + sx * 4;
                        int destPixelOffset = destRowOffset + tx * 3;

                        // BGR copy
                        bmpBytes[destPixelOffset] = srcPtr[srcPixelOffset];         // B
                        bmpBytes[destPixelOffset + 1] = srcPtr[srcPixelOffset + 1]; // G
                        bmpBytes[destPixelOffset + 2] = srcPtr[srcPixelOffset + 2]; // R
                    }
                }
            }

            // Guardrail check: Ensure under 32 KB
            if (bmpBytes.Length <= 32 * 1024)
            {
                return Convert.ToBase64String(bmpBytes);
            }

            return null;
        }
        catch
        {
            return null;
        }
    }
}
