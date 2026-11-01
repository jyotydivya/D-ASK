using System.Collections.Concurrent;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Observation;

public class ObservationBufferManager : IDisposable
{
    private readonly ILogger<ObservationBufferManager>? _logger;
    private readonly ConcurrentDictionary<string, BufferEntry> _activeBuffers = new();
    private readonly Timer _cleanupTimer;
    private readonly TimeSpan _retentionPeriod = TimeSpan.FromMinutes(2);
    private bool _disposed = false;

    private sealed record BufferEntry(
        MemoryMappedFile Mmf,
        DateTimeOffset CreatedAt,
        string? SessionId,
        uint? ClientPid,
        string Name);

    #region Win32 P/Invoke for Security & Handle Duplication

    private const uint PROCESS_DUP_HANDLE = 0x0040;
    private const uint FILE_MAP_READ = 0x0004;
    private const int DACL_SECURITY_INFORMATION = 0x00000004;
    private const int PROTECTED_DACL_SECURITY_INFORMATION = unchecked((int)0x80000000);
    private const uint SDDL_REVISION_1 = 1;

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string StringSecurityDescriptor,
        uint StringSDRevision,
        out IntPtr SecurityDescriptor,
        out uint SecurityDescriptorSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetKernelObjectSecurity(
        IntPtr handle,
        int SecurityInformation,
        IntPtr pSecurityDescriptor);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint processAccess,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle,
        uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
        IntPtr hSourceProcessHandle,
        IntPtr hSourceHandle,
        IntPtr hTargetProcessHandle,
        out IntPtr lpTargetHandle,
        uint dwDesiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle,
        uint dwOptions);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    #endregion

    public ObservationBufferManager(ILogger<ObservationBufferManager>? logger = null)
    {
        _logger = logger;
        _cleanupTimer = new Timer(CleanupStaleBuffers, null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
    }

    public (string? SharedMemoryName, long? TargetHandle) CreateSharedBuffer(
        string observationId,
        ReadOnlySpan<byte> data,
        uint? clientProcessId = null,
        string? sessionId = null)
    {
        string? sharedMemoryName = null;
        long? targetHandle = null;
        MemoryMappedFile mmf;

        try
        {
            if (clientProcessId.HasValue && clientProcessId.Value > 0)
            {
                // UNNAMED SECTION OBJECT:
                // Eliminates same-user namespace write exposure completely.
                // An unnamed mapping cannot be opened by name via OpenFileMapping from any other process.
                mmf = MemoryMappedFile.CreateNew(
                    null,
                    data.Length,
                    MemoryMappedFileAccess.ReadWrite);

                // Duplicate strictly READ-ONLY handle into the verified client process
                targetHandle = DuplicateReadOnlyHandle(
                    mmf.SafeMemoryMappedFileHandle.DangerousGetHandle(),
                    clientProcessId.Value);

                if (!targetHandle.HasValue)
                {
                    mmf.Dispose();
                    throw new InvalidOperationException($"Failed to duplicate read-only handle to client process {clientProcessId.Value}.");
                }
            }
            else
            {
                // Standalone / Test fallback with cryptographically random name and protected DACL
                sharedMemoryName = $"Local\\dask_obs_{observationId}_{System.Security.Cryptography.RandomNumberGenerator.GetHexString(16)}";
                mmf = MemoryMappedFile.CreateNew(
                    sharedMemoryName,
                    data.Length,
                    MemoryMappedFileAccess.ReadWrite);

                ApplyRestrictiveDacl(mmf.SafeMemoryMappedFileHandle.DangerousGetHandle());
            }

            // Write observation frame data safely into mapped view
            using (var accessor = mmf.CreateViewAccessor(0, data.Length, MemoryMappedFileAccess.Write))
            {
                unsafe
                {
                    byte* ptr = null;
                    accessor.SafeMemoryMappedViewHandle.AcquirePointer(ref ptr);
                    try
                    {
                        fixed (byte* src = data)
                        {
                            Buffer.MemoryCopy(src, ptr, data.Length, data.Length);
                        }
                    }
                    finally
                    {
                        accessor.SafeMemoryMappedViewHandle.ReleasePointer();
                    }
                }
            }

            _activeBuffers[observationId] = new BufferEntry(
                mmf,
                DateTimeOffset.UtcNow,
                sessionId,
                clientProcessId,
                sharedMemoryName ?? "unnamed_section");

            _logger?.LogDebug(
                "Created secure shared memory buffer ({Mode}) ({Bytes} bytes). TargetHandle: {Handle}",
                sharedMemoryName ?? "unnamed_section", data.Length, targetHandle);

            return (sharedMemoryName, targetHandle);
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Failed to create secure shared memory buffer '{Name}'.", sharedMemoryName ?? "unnamed_section");
            throw;
        }
    }

    private void ApplyRestrictiveDacl(IntPtr kernelHandle)
    {
        try
        {
            string? userSid = WindowsIdentity.GetCurrent().User?.Value;
            if (string.IsNullOrEmpty(userSid)) return;

            // SDDL: DACL protected from inheritance (P). Only allow Generic All (GA) to the current user SID.
            // Denies access to all other accounts/tokens in the system.
            string sddl = $"D:P(A;;GA;;;{userSid})";

            if (ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, SDDL_REVISION_1, out var pSd, out _))
            {
                try
                {
                    int secInfo = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
                    SetKernelObjectSecurity(kernelHandle, secInfo, pSd);
                }
                finally
                {
                    LocalFree(pSd);
                }
            }
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "Failed to apply restrictive DACL to observation mapping.");
        }
    }

    private long? DuplicateReadOnlyHandle(IntPtr sourceSectionHandle, uint targetPid)
    {
        IntPtr hTargetProc = IntPtr.Zero;
        try
        {
            hTargetProc = OpenProcess(PROCESS_DUP_HANDLE, false, targetPid);
            if (hTargetProc == IntPtr.Zero)
            {
                _logger?.LogWarning("Failed to open client process {Pid} for DuplicateHandle. Error: {Err}",
                    targetPid, Marshal.GetLastWin32Error());
                return null;
            }

            // Duplicate with FILE_MAP_READ (0x0004) only, preventing client from acquiring write access
            if (DuplicateHandle(
                GetCurrentProcess(),
                sourceSectionHandle,
                hTargetProc,
                out IntPtr hTargetHandle,
                FILE_MAP_READ,
                false,
                0))
            {
                return hTargetHandle.ToInt64();
            }

            _logger?.LogWarning("DuplicateHandle failed for client process {Pid}. Error: {Err}",
                targetPid, Marshal.GetLastWin32Error());
            return null;
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "Exception duplicating handle to client process {Pid}.", targetPid);
            return null;
        }
        finally
        {
            if (hTargetProc != IntPtr.Zero)
            {
                CloseHandle(hTargetProc);
            }
        }
    }

    public bool TryReleaseBuffer(string observationId)
    {
        if (_activeBuffers.TryRemove(observationId, out var entry))
        {
            entry.Mmf.Dispose();
            return true;
        }
        return false;
    }

    public int ReleaseSessionBuffers(string sessionId)
    {
        int releasedCount = 0;
        foreach (var kvp in _activeBuffers)
        {
            if (kvp.Value.SessionId == sessionId)
            {
                if (_activeBuffers.TryRemove(kvp.Key, out var entry))
                {
                    entry.Mmf.Dispose();
                    releasedCount++;
                }
            }
        }
        if (releasedCount > 0)
        {
            _logger?.LogDebug("Released {Count} observation buffers for disconnected session '{SessionId}'.",
                releasedCount, sessionId);
        }
        return releasedCount;
    }

    private void CleanupStaleBuffers(object? state)
    {
        var cutoff = DateTimeOffset.UtcNow - _retentionPeriod;
        foreach (var kvp in _activeBuffers)
        {
            if (kvp.Value.CreatedAt < cutoff)
            {
                if (_activeBuffers.TryRemove(kvp.Key, out var entry))
                {
                    entry.Mmf.Dispose();
                    _logger?.LogDebug("Cleaned up expired observation buffer for ID '{Id}'.", kvp.Key);
                }
            }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _cleanupTimer.Dispose();
        foreach (var kvp in _activeBuffers)
        {
            kvp.Value.Mmf.Dispose();
        }
        _activeBuffers.Clear();
    }
}
