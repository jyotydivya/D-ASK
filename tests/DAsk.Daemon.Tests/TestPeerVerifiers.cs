using System.IO.Pipes;
using System.Runtime.InteropServices;
using DAsk.Daemon.IPC;
using Microsoft.Win32.SafeHandles;

namespace DAsk.Daemon.Tests;

/// <summary>
/// TEST-ONLY peer verifier. It exists solely in the test assembly so that production code has no
/// permissive verifier to reach for: DAsk.Daemon.dll constructs sessions only with
/// <see cref="WindowsPipePeerVerifier"/> (which fails closed). In-process engine tests that drive an
/// <see cref="IpcClientSession"/> directly over a private pipe pass this explicitly.
/// </summary>
internal sealed class AllowAnyPeerVerifierForTests : IPipePeerVerifier
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);

    public PeerVerificationResult Verify(NamedPipeServerStream pipe, long acceptedAtFileTimeUtc)
    {
        uint pid = GetNamedPipeClientProcessId(pipe.SafePipeHandle, out uint p) ? p : 0;
        return PeerVerificationResult.Success(new VerifiedPeer(pid, "test-only", "test-only", null));
    }
}

internal static class TestPeerVerifiers
{
    public static readonly IPipePeerVerifier AllowAll = new AllowAnyPeerVerifierForTests();
}
