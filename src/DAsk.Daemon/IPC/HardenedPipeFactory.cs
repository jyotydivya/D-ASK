using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace DAsk.Daemon.IPC;

/// <summary>
/// Creates server pipe instances through CreateNamedPipeW so that properties .NET does not expose can be set:
///   * PIPE_REJECT_REMOTE_CLIENTS: SMB/network opens fail outright. (A NETWORK-SID deny ACE is NOT enough:
///     measured on this machine, a same-user loopback SMB token carries no NETWORK SID.)
///   * an explicit security descriptor on every instance (no default DACL, no fallback),
///   * FILE_FLAG_FIRST_PIPE_INSTANCE only when requested (the initial instance).
/// The handle is then wrapped in an ordinary <see cref="NamedPipeServerStream"/>.
/// </summary>
internal static class HardenedPipeFactory
{
    private const uint PIPE_ACCESS_DUPLEX = 0x00000003;
    private const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
    private const uint FILE_FLAG_OVERLAPPED = 0x40000000;
    private const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
    private const uint PIPE_TYPE_BYTE = 0x0;
    private const uint PIPE_READMODE_BYTE = 0x0;
    private const uint PIPE_WAIT = 0x0;
    private const uint PIPE_REJECT_REMOTE_CLIENTS = 0x8;

    private const int ERROR_ACCESS_DENIED = 5;
    private const int ERROR_PIPE_BUSY = 231;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafePipeHandle CreateNamedPipeW(
        string name, uint openMode, uint pipeMode, uint maxInstances,
        uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SECURITY_ATTRIBUTES securityAttributes);

    /// <exception cref="UnauthorizedAccessException">The name is already owned by another instance set (squatting) when <paramref name="firstInstance"/>.</exception>
    /// <exception cref="IOException">HRESULT 0x800700E7 when all <paramref name="maxInstances"/> instances are in use.</exception>
    public static NamedPipeServerStream Create(string pipeName, int maxInstances, PipeSecurity security, bool firstInstance)
    {
        if (maxInstances < 1 || maxInstances > 254)
            throw new ArgumentOutOfRangeException(nameof(maxInstances), "MaxConnectedClients must be between 1 and 254.");

        byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
        GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try
        {
            var attributes = new SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(),
                lpSecurityDescriptor = pinned.AddrOfPinnedObject(),
                bInheritHandle = 0,
            };

            uint openMode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_WRITE_THROUGH
                            | (firstInstance ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
            uint pipeMode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;

            SafePipeHandle handle = CreateNamedPipeW(
                @"\\.\pipe\" + pipeName, openMode, pipeMode, (uint)maxInstances, 0, 0, 0, ref attributes);

            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw error switch
                {
                    ERROR_ACCESS_DENIED => new UnauthorizedAccessException(
                        "Access to the pipe name is denied: it already exists and is not ours.", new Win32Exception(error)),
                    ERROR_PIPE_BUSY => new IOException(
                        "All pipe instances are busy.", unchecked((int)0x80070000 | error)),
                    _ => new IOException(new Win32Exception(error).Message, unchecked((int)0x80070000 | error)),
                };
            }

            try
            {
                return new NamedPipeServerStream(PipeDirection.InOut, isAsync: true, isConnected: false, handle);
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }
        finally
        {
            pinned.Free();
        }
    }
}
