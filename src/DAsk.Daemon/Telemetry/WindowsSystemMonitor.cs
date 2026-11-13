using System.Diagnostics;
using System.Runtime.InteropServices;
using DAsk.Protocol.IPC.Messages;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Telemetry;

public class WindowsSystemMonitor : ISystemMonitor
{
    private readonly ILogger<WindowsSystemMonitor> _logger;
    private readonly IntelGpuMonitor _gpuMonitor;
    private DateTimeOffset _lastCpuSampleTime = DateTimeOffset.UtcNow;
    private TimeSpan _lastProcessCpuTime = Process.GetCurrentProcess().TotalProcessorTime;
    private FILETIME _lastIdleTime;
    private FILETIME _lastKernelTime;
    private FILETIME _lastUserTime;
    private bool _cpuInitialized = false;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;

        public ulong ToUInt64() => ((ulong)dwHighDateTime << 32) | dwLowDateTime;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemTimes(out FILETIME lpIdleTime, out FILETIME lpKernelTime, out FILETIME lpUserTime);

    public WindowsSystemMonitor(ILogger<WindowsSystemMonitor> logger, IntelGpuMonitor gpuMonitor)
    {
        _logger = logger;
        _gpuMonitor = gpuMonitor;
        InitCpuTracking();
    }

    private void InitCpuTracking()
    {
        if (GetSystemTimes(out _lastIdleTime, out _lastKernelTime, out _lastUserTime))
        {
            _cpuInitialized = true;
        }
    }

    public Task<SystemRamMetrics> GetRamMetricsAsync(CancellationToken cancellationToken = default)
    {
        var memStatus = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        if (GlobalMemoryStatusEx(ref memStatus))
        {
            ulong total = memStatus.ullTotalPhys;
            ulong available = memStatus.ullAvailPhys;
            ulong used = total > available ? total - available : 0;
            double loadPct = memStatus.dwMemoryLoad;

            return Task.FromResult(new SystemRamMetrics
            {
                TotalBytes = total,
                AvailableBytes = available,
                UsedBytes = used,
                LoadPercentage = loadPct
            });
        }

        _logger.LogWarning("GlobalMemoryStatusEx call failed, falling back to GC memory info.");
        var gcInfo = GC.GetGCMemoryInfo();
        return Task.FromResult(new SystemRamMetrics
        {
            TotalBytes = (ulong)gcInfo.TotalAvailableMemoryBytes,
            AvailableBytes = (ulong)(gcInfo.TotalAvailableMemoryBytes - gcInfo.MemoryLoadBytes),
            UsedBytes = (ulong)gcInfo.MemoryLoadBytes,
            LoadPercentage = gcInfo.TotalAvailableMemoryBytes > 0 
                ? (double)gcInfo.MemoryLoadBytes / gcInfo.TotalAvailableMemoryBytes * 100.0 
                : 0.0
        });
    }

    public Task<CpuMetrics> GetCpuMetricsAsync(CancellationToken cancellationToken = default)
    {
        double totalCpu = 0.0;
        double processCpu = 0.0;

        if (_cpuInitialized && GetSystemTimes(out var newIdle, out var newKernel, out var newUser))
        {
            ulong idleDiff = newIdle.ToUInt64() - _lastIdleTime.ToUInt64();
            ulong kernelDiff = newKernel.ToUInt64() - _lastKernelTime.ToUInt64();
            ulong userDiff = newUser.ToUInt64() - _lastUserTime.ToUInt64();
            ulong totalSysDiff = kernelDiff + userDiff;

            if (totalSysDiff > 0)
            {
                totalCpu = (1.0 - ((double)idleDiff / totalSysDiff)) * 100.0;
                totalCpu = Math.Clamp(totalCpu, 0.0, 100.0);
            }

            _lastIdleTime = newIdle;
            _lastKernelTime = newKernel;
            _lastUserTime = newUser;
        }

        // Process CPU
        var now = DateTimeOffset.UtcNow;
        var elapsed = now - _lastCpuSampleTime;
        if (elapsed.TotalMilliseconds > 100)
        {
            try
            {
                var curProc = Process.GetCurrentProcess();
                var curCpuTime = curProc.TotalProcessorTime;
                var procDiff = curCpuTime - _lastProcessCpuTime;
                processCpu = (procDiff.TotalMilliseconds / (elapsed.TotalMilliseconds * Environment.ProcessorCount)) * 100.0;
                processCpu = Math.Clamp(processCpu, 0.0, 100.0);

                _lastProcessCpuTime = curCpuTime;
                _lastCpuSampleTime = now;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Failed to read process CPU.");
            }
        }

        return Task.FromResult(new CpuMetrics
        {
            TotalUsagePercent = Math.Round(totalCpu, 1),
            ProcessUsagePercent = Math.Round(processCpu, 1)
        });
    }

    public Task<GpuMetrics> GetGpuMetricsAsync(CancellationToken cancellationToken = default)
    {
        return _gpuMonitor.GetGpuMetricsAsync(cancellationToken);
    }

    public ProcessMemoryMetrics GetProcessMemoryMetrics()
    {
        var proc = Process.GetCurrentProcess();
        proc.Refresh();

        return new ProcessMemoryMetrics
        {
            WorkingSetBytes = proc.WorkingSet64,
            PrivateBytes = proc.PrivateMemorySize64
        };
    }

    public async Task<TelemetryUpdate> CaptureCompleteTelemetryAsync(string resourceStatus, CancellationToken cancellationToken = default)
    {
        var ram = await GetRamMetricsAsync(cancellationToken);
        var cpu = await GetCpuMetricsAsync(cancellationToken);
        var gpu = await GetGpuMetricsAsync(cancellationToken);
        var procMem = GetProcessMemoryMetrics();

        return new TelemetryUpdate
        {
            SystemRam = ram,
            Cpu = cpu,
            Gpu = gpu,
            ProcessMemory = procMem,
            ResourceStatus = resourceStatus,
            Timestamp = DateTimeOffset.UtcNow
        };
    }
}

