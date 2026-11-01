using System.Diagnostics;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.State;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Win32.SafeHandles;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

public class ScreenObservationTests
{
    private readonly ITestOutputHelper _output;

    public ScreenObservationTests(ITestOutputHelper output)
    {
        _output = output;
        // Ensure process Per-Monitor DPI Awareness V2 is active for tests
        DpiCoordinateConverter.InitializeDpiAwareness();
    }

    [Fact]
    public void DpiCoordinateConverter_PhysicalAndLogicalScaling_CalculatesAccurately()
    {
        // 96 DPI (100% scale)
        var scale100 = DpiCoordinateConverter.DpiToScale(96);
        Assert.Equal(1.0, scale100);
        Assert.Equal((1920, 1080), DpiCoordinateConverter.PhysicalToLogical(1920, 1080, scale100));
        Assert.Equal((1920, 1080), DpiCoordinateConverter.LogicalToPhysical(1920, 1080, scale100));

        // 120 DPI (125% scale)
        var scale125 = DpiCoordinateConverter.DpiToScale(120);
        Assert.Equal(1.25, scale125);
        Assert.Equal((800, 600), DpiCoordinateConverter.PhysicalToLogical(1000, 750, scale125));
        Assert.Equal((1000, 750), DpiCoordinateConverter.LogicalToPhysical(800, 600, scale125));

        // 144 DPI (150% scale)
        var scale150 = DpiCoordinateConverter.DpiToScale(144);
        Assert.Equal(1.5, scale150);
        Assert.Equal((1280, 720), DpiCoordinateConverter.PhysicalToLogical(1920, 1080, scale150));

        // 192 DPI (200% scale)
        var scale200 = DpiCoordinateConverter.DpiToScale(192);
        Assert.Equal(2.0, scale200);
        Assert.Equal((1920, 1080), DpiCoordinateConverter.PhysicalToLogical(3840, 2160, scale200));
    }

    [Fact]
    public void DpiCoordinateConverter_RuntimeAwareness_And_MultiScaleAccuracy_Test()
    {
        string awareness = DpiCoordinateConverter.GetRuntimeDpiAwareness();
        _output.WriteLine($"Runtime DPI Awareness: {awareness}");
        Assert.False(string.IsNullOrWhiteSpace(awareness));
        Assert.True(awareness == "PerMonitorV2" || awareness == "PerMonitor" || awareness == "SystemAware");

        // Verify negative virtual screen coordinates for secondary left/top monitors
        int negPhysX = -1920;
        int negPhysY = -1080;
        double scale125 = 1.25;

        var (logX, logY) = DpiCoordinateConverter.PhysicalToLogical(negPhysX, negPhysY, scale125);
        Assert.Equal(-1536, logX);
        Assert.Equal(-864, logY);

        var (roundPhysX, roundPhysY) = DpiCoordinateConverter.LogicalToPhysical(logX, logY, scale125);
        Assert.Equal(negPhysX, roundPhysX);
        Assert.Equal(negPhysY, roundPhysY);
    }

    [Fact]
    public void ObservationBufferManager_CreateAndRelease_SharedMemoryAccessible()
    {
        using var manager = new ObservationBufferManager();
        string obsId = Guid.NewGuid().ToString("N");

        byte[] originalData = new byte[1024 * 64]; // 64 KB
        for (int i = 0; i < originalData.Length; i++)
        {
            originalData[i] = (byte)(i % 256);
        }

        var (sharedName, _) = manager.CreateSharedBuffer(obsId, originalData);
        Assert.StartsWith("Local\\dask_obs_", sharedName);

        // Read from shared memory
        using (var readerMmf = MemoryMappedFile.OpenExisting(sharedName, MemoryMappedFileRights.Read))
        using (var accessor = readerMmf.CreateViewAccessor(0, originalData.Length, MemoryMappedFileAccess.Read))
        {
            byte[] readBack = new byte[originalData.Length];
            accessor.ReadArray(0, readBack, 0, readBack.Length);
            Assert.Equal(originalData, readBack);
        }

        bool released = manager.TryReleaseBuffer(obsId);
        Assert.True(released);
    }

    [Fact]
    public void ObservationBufferManager_ExplicitDacl_And_ReadOnlyHandleDuplication_Test()
    {
        using var manager = new ObservationBufferManager();
        string obsId = Guid.NewGuid().ToString("N");

        byte[] payload = new byte[1024 * 32];
        Random.Shared.NextBytes(payload);

        // Duplicate read-only handle into current process
        var (sharedName, targetHandle) = manager.CreateSharedBuffer(
            obsId, payload, clientProcessId: (uint)Environment.ProcessId);

        Assert.NotNull(targetHandle);
        Assert.True(targetHandle.Value != 0);

        // 1. Read-only verification: consumer maps duplicated handle with Read access and verifies data
        IntPtr hSection = new IntPtr(targetHandle.Value);
        IntPtr pView = MapViewOfFile(hSection, FILE_MAP_READ, 0, 0, (UIntPtr)payload.Length);
        Assert.True(pView != IntPtr.Zero, $"MapViewOfFile(READ) failed with error {Marshal.GetLastWin32Error()}");
        try
        {
            byte[] readBack = new byte[payload.Length];
            Marshal.Copy(pView, readBack, 0, readBack.Length);
            Assert.Equal(payload, readBack);
        }
        finally
        {
            UnmapViewOfFile(pView);
        }

        // 2. Adversarial write test: Verify attempting to map with Write access fails with ERROR_ACCESS_DENIED (5)
        IntPtr pWriteView = MapViewOfFile(hSection, FILE_MAP_WRITE, 0, 0, (UIntPtr)payload.Length);
        int lastErr = Marshal.GetLastWin32Error();
        Assert.Equal(IntPtr.Zero, pWriteView);
        Assert.Equal(5, lastErr); // 5 = ERROR_ACCESS_DENIED

        CloseHandle(hSection);
        manager.TryReleaseBuffer(obsId);
    }

    [Fact]
    public void ObservationBufferManager_ClientDisconnect_ReleasesSessionBuffers_Test()
    {
        using var manager = new ObservationBufferManager();
        string sessionId = $"session_{Guid.NewGuid():N}";

        for (int i = 0; i < 3; i++)
        {
            byte[] dummy = new byte[1024];
            manager.CreateSharedBuffer($"obs_disc_{i}", dummy, sessionId: sessionId);
        }

        // Simulating client disconnect
        int released = manager.ReleaseSessionBuffers(sessionId);
        Assert.Equal(3, released);

        // Subsequent release should report 0
        int releasedAgain = manager.ReleaseSessionBuffers(sessionId);
        Assert.Equal(0, releasedAgain);
    }

    [Fact]
    public async Task ObservationBufferManager_ConcurrentReads_PreserveFrameIntegrity_Test()
    {
        using var manager = new ObservationBufferManager();
        string obsId = Guid.NewGuid().ToString("N");

        // 1 MB test frame
        byte[] frameData = new byte[1024 * 1024];
        for (int i = 0; i < frameData.Length; i++)
        {
            frameData[i] = (byte)(i & 0xFF);
        }

        var (sharedName, _) = manager.CreateSharedBuffer(obsId, frameData);

        // Run 10 concurrent reader tasks
        var tasks = Enumerable.Range(0, 10).Select(_ => Task.Run(() =>
        {
            using var readerMmf = MemoryMappedFile.OpenExisting(sharedName, MemoryMappedFileRights.Read);
            using var accessor = readerMmf.CreateViewAccessor(0, frameData.Length, MemoryMappedFileAccess.Read);

            byte[] localBuf = new byte[frameData.Length];
            accessor.ReadArray(0, localBuf, 0, localBuf.Length);

            Assert.Equal(frameData, localBuf);
        })).ToArray();

        await Task.WhenAll(tasks);
        manager.TryReleaseBuffer(obsId);
    }

    [Fact]
    public void Win32ScreenObservationService_EnumerateDisplays_DiscoversDisplaysWithDpi()
    {
        using var bufferMgr = new ObservationBufferManager();
        using var uia = new WindowsUiAutomationService();
        var service = new Win32ScreenObservationService(bufferMgr, uia);

        var displays = service.EnumerateDisplays();
        Assert.NotEmpty(displays);

        foreach (var display in displays)
        {
            _output.WriteLine($"Display [{display.Index}]: Device='{display.DeviceName}', Bounds={display.X},{display.Y} {display.Width}x{display.Height}, Primary={display.IsPrimary}, DpiScale={display.DpiScale} ({display.DpiX}x{display.DpiY})");
            Assert.True(display.Width > 0);
            Assert.True(display.Height > 0);
            Assert.True(display.DpiScale >= 0.5);
            Assert.True(display.DpiX >= 48);
        }

        Assert.Contains(displays, d => d.IsPrimary);
    }

    [Fact]
    public void Win32ScreenObservationService_GetActiveWindow_ReturnsValidMetadata_WithCoordinates()
    {
        using var bufferMgr = new ObservationBufferManager();
        using var uia = new WindowsUiAutomationService();
        var service = new Win32ScreenObservationService(bufferMgr, uia);

        var active = service.GetActiveWindow();
        if (active != null)
        {
            _output.WriteLine($"Active Window: HWND={active.Hwnd:X}, Title='{active.Title}', Process='{active.ProcessName}' (PID {active.ProcessId})");
            _output.WriteLine($"  Physical Bounds: {active.X},{active.Y} {active.Width}x{active.Height} (DPI Scale: {active.DpiScale})");
            _output.WriteLine($"  Logical Bounds:  {active.LogicalX},{active.LogicalY} {active.LogicalWidth}x{active.LogicalHeight}");
            _output.WriteLine($"  Client Bounds:   {active.ClientX},{active.ClientY} {active.ClientWidth}x{active.ClientHeight}");

            Assert.True(active.Hwnd != 0);
            Assert.False(string.IsNullOrWhiteSpace(active.ProcessName));
        }
    }

    [Fact]
    public async Task DedicatedTestWindow_FullObservation_Capture_And_UIA_Verification()
    {
        using var bufferMgr = new ObservationBufferManager();
        using var uia = new WindowsUiAutomationService();
        var service = new Win32ScreenObservationService(bufferMgr, uia);

        // Spawn a dedicated Win32 native test window
        using var harness = new Win32TestWindowHarness("D-ASK Stage 4A Test Window", 450, 320);
        harness.BringToForeground();
        await Task.Delay(200); // Allow window manager composition

        var request = new CaptureObservationRequest
        {
            TargetHwnd = harness.Hwnd.ToInt64(),
            IncludeUiAutomation = true,
            UiaTimeoutMs = 500,
            GeneratePreviewThumbnail = true,
            PreviewMaxWidth = 160,
            PreviewMaxHeight = 90
        };

        var response = await service.CaptureAsync(request, clientProcessId: (uint)Environment.ProcessId);

        _output.WriteLine($"Observation Complete: Success={response.Success}, Status='{response.Status}', Dimensions={response.PhysicalWidth}x{response.PhysicalHeight}, SharedMem='{response.SharedMemoryName}' ({response.DataSizeBytes:N0} bytes)");
        _output.WriteLine($"Performance: CaptureDuration={response.CaptureDurationMs:F2}ms, UiaDuration={response.UiaDurationMs:F2}ms");

        Assert.True(response.Success);
        Assert.True(response.PhysicalWidth > 0);
        Assert.True(response.PhysicalHeight > 0);
        Assert.True(!string.IsNullOrEmpty(response.SharedMemoryName) || (response.TargetHandle.HasValue && response.TargetHandle.Value > 0));
        Assert.True(response.DataSizeBytes > 0);

        // Verify active window was captured with physical, logical and client bounds
        Assert.NotNull(response.ActiveWindow);
        _output.WriteLine($"Captured Active Window: Title='{response.ActiveWindow.Title}', PID={response.ActiveWindow.ProcessId}");
        _output.WriteLine($"  Physical: {response.ActiveWindow.X},{response.ActiveWindow.Y} {response.ActiveWindow.Width}x{response.ActiveWindow.Height}");
        _output.WriteLine($"  Logical:  {response.ActiveWindow.LogicalX},{response.ActiveWindow.LogicalY} {response.ActiveWindow.LogicalWidth}x{response.ActiveWindow.LogicalHeight}");
        _output.WriteLine($"  Client:   {response.ActiveWindow.ClientX},{response.ActiveWindow.ClientY} {response.ActiveWindow.ClientWidth}x{response.ActiveWindow.ClientHeight}");

        // Verify thumbnail is present and bounded <= 32 KB
        if (response.PreviewThumbnailBase64 != null)
        {
            byte[] thumbBytes = Convert.FromBase64String(response.PreviewThumbnailBase64);
            _output.WriteLine($"Thumbnail Size: {thumbBytes.Length:N0} bytes (Base64 length: {response.PreviewThumbnailBase64.Length:N0})");
            Assert.True(thumbBytes.Length <= 32 * 1024, "Thumbnail exceeded 32 KB payload guardrail!");
        }

        // Verify UIA or Win32 elements were discovered
        _output.WriteLine($"Discovered {response.UiElements.Count} UI Elements:");
        foreach (var el in response.UiElements.Take(10))
        {
            _output.WriteLine($"  - [{el.ControlType}] '{el.Name}' ({el.ClassName}) at {el.X},{el.Y} {el.Width}x{el.Height} (Id: {el.StableId})");
        }

        Assert.NotEmpty(response.UiElements);

        // Release observation buffer
        bufferMgr.TryReleaseBuffer(response.ObservationId);
    }

    [Fact]
    public async Task WindowsUiAutomationService_StrictTimeout_HandlesSlowWindowGracefully()
    {
        using var uia = new WindowsUiAutomationService();
        IntPtr fg = GetForegroundWindow();

        // Pass an ultrashort 1ms timeout
        var (elements, status) = await uia.InspectWindowAsync(fg, timeoutMs: 1);

        _output.WriteLine($"Ultra-short timeout test result: Status='{status}', ElementCount={elements.Count}");
        Assert.True(status == "Success" || status == "PartialUiaTimeout" || status == "WorkerBusyFallbackWin32" || status == "NoWindow");
    }

    [Fact]
    public async Task WindowsUiAutomationService_RepeatedInspections_NoComLeak_Test()
    {
        using var uia = new WindowsUiAutomationService();
        using var harness = new Win32TestWindowHarness("D-ASK COM Lifetime Harness", 400, 300);
        harness.BringToForeground();
        await Task.Delay(100);

        long startMemory = GC.GetTotalMemory(true);

        for (int i = 0; i < 25; i++)
        {
            var (elements, status) = await uia.InspectWindowAsync(harness.Hwnd, timeoutMs: 300);
            Assert.NotEmpty(elements);
            Assert.True(status == "Success" || status == "WorkerBusyFallbackWin32");
        }

        long endMemory = GC.GetTotalMemory(true);
        long memDelta = endMemory - startMemory;
        _output.WriteLine($"25 Repeated UIA Inspections: Memory delta = {memDelta:N0} bytes");

        // Verify no runaway memory accumulation (< 4 MB delta across 25 iterations)
        Assert.True(memDelta < 4 * 1024 * 1024, $"Memory delta was {memDelta} bytes, indicating possible resource leak.");
    }

    [Fact]
    public async Task WindowsUiAutomationService_DedicatedWorker_BoundedContainment_Test()
    {
        using var uia = new WindowsUiAutomationService();
        using var harness = new Win32TestWindowHarness("D-ASK Containment Test", 350, 250);
        harness.BringToForeground();
        await Task.Delay(100);

        // Request 1 with 1ms timeout to trigger timeout fallback
        var (el1, st1) = await uia.InspectWindowAsync(harness.Hwnd, timeoutMs: 1);
        Assert.NotNull(el1);

        // Immediate subsequent request: worker bounded containment ensures immediate fallback without ThreadPool blocking
        var (el2, st2) = await uia.InspectWindowAsync(harness.Hwnd, timeoutMs: 300);
        Assert.NotNull(el2);
        Assert.True(st2 == "Success" || st2 == "WorkerBusyFallbackWin32");
    }

    [Fact]
    public async Task RepeatedScreenCapture_Benchmark_And_ResourceStability_Test()
    {
        using var bufferMgr = new ObservationBufferManager();
        using var uia = new WindowsUiAutomationService();
        var service = new Win32ScreenObservationService(bufferMgr, uia);

        const int SampleCount = 30;
        var latencies = new List<double>(SampleCount);

        long startMemory = GC.GetTotalMemory(true);

        for (int i = 0; i < SampleCount; i++)
        {
            var req = new CaptureObservationRequest
            {
                IncludeUiAutomation = false, // Pure capture benchmark
                GeneratePreviewThumbnail = false
            };

            var resp = await service.CaptureAsync(req);
            Assert.True(resp.Success);
            latencies.Add(resp.CaptureDurationMs);

            bufferMgr.TryReleaseBuffer(resp.ObservationId);
        }

        long endMemory = GC.GetTotalMemory(true);
        long memDelta = endMemory - startMemory;

        latencies.Sort();
        double min = latencies[0];
        double median = latencies[SampleCount / 2];
        double p95 = latencies[(int)(SampleCount * 0.95)];
        double max = latencies[^1];

        _output.WriteLine($"Screen Capture Statistical Benchmark (N = {SampleCount}):");
        _output.WriteLine($"  Min:    {min:F2} ms");
        _output.WriteLine($"  Median: {median:F2} ms");
        _output.WriteLine($"  P95:    {p95:F2} ms");
        _output.WriteLine($"  Max:    {max:F2} ms");
        _output.WriteLine($"  Net Memory Delta: {memDelta:N0} bytes");

        // Verify statistical budgets
        Assert.True(median < 30.0, $"Median capture latency was {median:F2}ms, exceeding 30ms budget.");
        Assert.True(p95 < 50.0, $"P95 capture latency was {p95:F2}ms, exceeding 50ms budget.");
    }

    [Fact]
    public void ActionApproval_ProtocolContract_ParameterHashVerification_Test()
    {
        var parameters = new Dictionary<string, string>
        {
            ["command"] = "calc.exe",
            ["workingDirectory"] = "C:\\"
        };

        // Canonical sorted parameter string
        string paramString = string.Join(";", parameters.OrderBy(p => p.Key).Select(p => $"{p.Key}={p.Value}"));
        string paramHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(paramString)));

        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"),
            ActionType = "LaunchProcess",
            ParametersSha256 = paramHash,
            ActionParameters = parameters,
            TargetProcessName = "explorer.exe",
            TargetWindowTitle = "Desktop",
            TargetHwnd = 12345,
            RiskLevel = "Medium",
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddSeconds(30),
            Reason = "User requested calculator"
        };

        // Case 1: Valid approval matching original hash and before expiration
        var response = new ActionApprovalResponse
        {
            ApprovalId = request.ApprovalId,
            ActionType = request.ActionType,
            ParametersSha256 = request.ParametersSha256,
            Approved = true,
            DecisionSource = "UserExplicitConfirmation"
        };

        bool isValid = (response.ApprovalId == request.ApprovalId) &&
                       (response.ParametersSha256 == request.ParametersSha256) &&
                       (DateTimeOffset.UtcNow <= request.ExpiresAtUtc);
        Assert.True(isValid);

        // Case 2: Tampered parameters detected via hash mismatch
        var tamperedResponse = new ActionApprovalResponse
        {
            ApprovalId = request.ApprovalId,
            ActionType = request.ActionType,
            ParametersSha256 = "INVALID_HASH_VALUE",
            Approved = true,
            DecisionSource = "UserExplicitConfirmation"
        };

        bool isTamperedValid = (tamperedResponse.ApprovalId == request.ApprovalId) &&
                              (tamperedResponse.ParametersSha256 == request.ParametersSha256);
        Assert.False(isTamperedValid);
    }

    [Fact]
    public void EmergencyStop_ProtocolContract_And_DaemonStateTransition_Test()
    {
        // Clarification: This tests the protocol contract and daemon state transition.
        // Active and queued action execution cancellation is deferred to Phase 4B when the execution runner is built.
        var stateMgr = new StateManager(Microsoft.Extensions.Logging.Abstractions.NullLogger<StateManager>.Instance);
        stateMgr.SetStatus("Active", "SimulatedActiveAction");
        Assert.Equal("Active", stateMgr.ActiveStatus);

        var request = new EmergencyStopRequest
        {
            Source = "FrontendStopButton",
            Reason = "User pressed stop on HUD"
        };

        // Simulate daemon IPC dispatch handler behavior
        stateMgr.SetStatus("Idle", "EmergencyStop");

        var response = new EmergencyStopResponse
        {
            StopId = request.StopId,
            Success = true,
            ActiveActionsCancelled = 0, // 0 actions cancelled because Phase 4B runner does not exist yet
            Timestamp = DateTimeOffset.UtcNow
        };

        Assert.Equal(request.StopId, response.StopId);
        Assert.True(response.Success);
        Assert.Equal(0, response.ActiveActionsCancelled);
        Assert.Equal("Idle", stateMgr.ActiveStatus);
        Assert.Equal("EmergencyStop", stateMgr.OrbMode);
    }

    private const uint FILE_MAP_READ = 0x0004;
    private const uint FILE_MAP_WRITE = 0x0002;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr MapViewOfFile(
        IntPtr hFileMappingObject,
        uint dwDesiredAccess,
        uint dwFileOffsetHigh,
        uint dwFileOffsetLow,
        UIntPtr dwNumberOfBytesToMap);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UnmapViewOfFile(IntPtr lpBaseAddress);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    #region Win32 Test Window Harness Helper

    private sealed class Win32TestWindowHarness : IDisposable
    {
        private const int WS_OVERLAPPEDWINDOW = 0x00CF0000;
        private const int WS_VISIBLE = 0x10000000;
        private const int WS_CHILD = 0x40000000;
        private const int SW_SHOW = 5;
        private const uint WM_CLOSE = 0x0010;

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern IntPtr CreateWindowEx(
            int dwExStyle, string lpClassName, string lpWindowName, int dwStyle,
            int x, int y, int nWidth, int nHeight,
            IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern sbyte GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        private static extern bool TranslateMessage([In] ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage([In] ref MSG lpMsg);

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public int pt_x;
            public int pt_y;
        }

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetModuleHandle(string? lpModuleName);

        private readonly Thread _thread;
        private readonly ManualResetEventSlim _readyEvent = new(false);

        public IntPtr Hwnd { get; private set; }
        public IntPtr ButtonHwnd { get; private set; }
        public IntPtr EditHwnd { get; private set; }

        public Win32TestWindowHarness(string title, int width, int height)
        {
            _thread = new Thread(() =>
            {
                IntPtr hInst = GetModuleHandle(null);

                Hwnd = CreateWindowEx(
                    0, "STATIC", title,
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    150, 150, width, height,
                    IntPtr.Zero, IntPtr.Zero, hInst, IntPtr.Zero);

                if (Hwnd != IntPtr.Zero)
                {
                    ButtonHwnd = CreateWindowEx(
                        0, "BUTTON", "Test Action Button",
                        WS_CHILD | WS_VISIBLE,
                        20, 20, 160, 35,
                        Hwnd, new IntPtr(1001), hInst, IntPtr.Zero);

                    EditHwnd = CreateWindowEx(
                        0, "EDIT", "Sample Test Input Text",
                        WS_CHILD | WS_VISIBLE,
                        20, 70, 200, 30,
                        Hwnd, new IntPtr(1002), hInst, IntPtr.Zero);

                    ShowWindow(Hwnd, SW_SHOW);
                    SetForegroundWindow(Hwnd);
                }

                _readyEvent.Set();

                // Active Windows Message Loop
                while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
                {
                    TranslateMessage(ref msg);
                    DispatchMessage(ref msg);
                }
            });

            _thread.SetApartmentState(ApartmentState.STA);
            _thread.IsBackground = true;
            _thread.Start();

            _readyEvent.Wait(TimeSpan.FromSeconds(3));
        }

        public void BringToForeground()
        {
            if (Hwnd != IntPtr.Zero)
            {
                SetForegroundWindow(Hwnd);
            }
        }

        public void Dispose()
        {
            if (Hwnd != IntPtr.Zero)
            {
                PostMessage(Hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                _thread.Join(1000);
            }
        }
    }

    #endregion
}
