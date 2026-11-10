using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Win32.SafeHandles;

namespace DAsk.Daemon.IPC;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4B-1R.8 (H3): verify WHO is on the other end of the pipe before any byte is read.
//
// Limits (do not oversell): an exact-image-path allowlist is defense-in-depth. It does NOT stop
// same-user malware, code injected into an allowed process, or replacement of an allowed
// executable in a user-writable directory.
// ─────────────────────────────────────────────────────────────────────────────

/// <summary>Facts gathered about the pipe peer, kept separate from the decision so the policy is unit-testable.</summary>
public sealed record PeerSnapshot
{
    public uint Pid { get; init; }
    /// <summary>True when the client reached the pipe over the network (SMB), including loopback SMB.</summary>
    public bool IsRemoteClient { get; init; }
    /// <summary>Canonicalized image path, or null when it could not be determined.</summary>
    public string? ImagePath { get; init; }
    public string? UserSid { get; init; }
    public uint? SessionId { get; init; }
    /// <summary>Process creation time (FILETIME, UTC); 0 when unknown.</summary>
    public long CreationFileTime { get; init; }
    public bool ProcessExited { get; init; }
    public bool PipeStillConnected { get; init; }
    /// <summary>The pipe still reports the same client PID after we hold a handle to that process.</summary>
    public bool PidStableAfterHandleOpen { get; init; }
}

public sealed record PeerExpectation
{
    public required string UserSid { get; init; }
    public required uint SessionId { get; init; }
    public required IReadOnlyCollection<string> AllowedCanonicalImagePaths { get; init; }
    /// <summary>FILETIME (UTC) captured as soon as the server accepted the connection.</summary>
    public required long AcceptedAtFileTime { get; init; }
}

public static class PeerPolicy
{
    /// <returns>null when the peer is acceptable; otherwise the reason it was rejected.</returns>
    public static string? Evaluate(PeerSnapshot s, PeerExpectation e)
    {
        if (e.AllowedCanonicalImagePaths.Count == 0)
            return "no allowed client image paths are configured or resolvable (fail closed)";
        if (s.IsRemoteClient) return "peer is a remote (network/SMB) client";
        if (s.Pid == 0) return "peer PID unavailable";
        if (!s.PidStableAfterHandleOpen) return "pipe client PID changed while opening the process (race)";
        if (s.ProcessExited) return "peer process has already exited (PID may be reused)";
        if (!s.PipeStillConnected) return "pipe is no longer connected after the process handle was acquired";
        if (s.CreationFileTime == 0) return "peer process creation time unavailable";

        // A process that existed when the connection was accepted was created before that moment.
        // A PID-reuse successor can only have been created after the original client exited.
        if (s.CreationFileTime > e.AcceptedAtFileTime)
            return "peer process was created after the connection was accepted (PID reuse)";

        if (!string.Equals(s.UserSid, e.UserSid, StringComparison.OrdinalIgnoreCase))
            return $"peer runs as a different user ({s.UserSid ?? "unknown"})";
        if (s.SessionId is null || s.SessionId.Value != e.SessionId)
            return $"peer is in a different logon session ({s.SessionId?.ToString() ?? "unknown"})";
        if (s.ImagePath is null) return "peer image path unavailable";
        if (!e.AllowedCanonicalImagePaths.Contains(s.ImagePath, StringComparer.OrdinalIgnoreCase))
            return $"peer image '{s.ImagePath}' is not in the allowed client list";
        return null;
    }
}

/// <summary>A peer that passed verification. Holding the process handle prevents its PID from being reused.</summary>
public sealed class VerifiedPeer : IDisposable
{
    private readonly SafeHandle? _processHandle;

    public uint Pid { get; }
    public string ImagePath { get; }
    public string UserSid { get; }

    public VerifiedPeer(uint pid, string imagePath, string userSid, SafeHandle? processHandle)
    {
        Pid = pid;
        ImagePath = imagePath;
        UserSid = userSid;
        _processHandle = processHandle;
    }

    public void Dispose() => _processHandle?.Dispose();
}

public readonly record struct PeerVerificationResult(VerifiedPeer? Peer, string? FailureReason)
{
    public bool Ok => Peer != null;
    public static PeerVerificationResult Success(VerifiedPeer peer) => new(peer, null);
    public static PeerVerificationResult Fail(string reason) => new(null, reason);
}

public interface IPipePeerVerifier
{
    /// <summary>Must fail closed: any error or uncertainty is a rejection.</summary>
    PeerVerificationResult Verify(NamedPipeServerStream pipe, long acceptedAtFileTimeUtc);
}

/// <summary>Production verifier. Requires a non-empty, resolvable allowlist; otherwise nothing is accepted.</summary>
public sealed class WindowsPipePeerVerifier : IPipePeerVerifier
{
    private readonly string[] _allowedEntries;
    private readonly ILogger _logger;

    public WindowsPipePeerVerifier(IEnumerable<string> allowedImagePaths, string baseDirectory, ILogger logger)
    {
        _logger = logger;
        _allowedEntries = allowedImagePaths
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Select(p => Path.GetFullPath(p, baseDirectory))
            .ToArray();
    }

    public PeerVerificationResult Verify(NamedPipeServerStream pipe, long acceptedAtFileTimeUtc)
    {
        try
        {
            return VerifyCore(pipe, acceptedAtFileTimeUtc);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[IPC PeerVerifier] Verification error; rejecting peer (fail closed).");
            return PeerVerificationResult.Fail("verification error: " + ex.GetType().Name);
        }
    }

    private PeerVerificationResult VerifyCore(NamedPipeServerStream pipe, long acceptedAt)
    {
        var allowed = _allowedEntries
            .Select(PipePeerNative.TryCanonicalizePath)
            .Where(p => p != null)
            .Select(p => p!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        // A remote client has no meaningful local PID; reject before looking at anything else.
        if (PipePeerNative.IsRemoteClient(pipe.SafePipeHandle))
            return PeerVerificationResult.Fail("peer is a remote (network/SMB) client");

        if (!PipePeerNative.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out uint pid) || pid == 0)
            return PeerVerificationResult.Fail("GetNamedPipeClientProcessId failed");

        IntPtr raw = PipePeerNative.OpenProcess(
            PipePeerNative.PROCESS_QUERY_LIMITED_INFORMATION | PipePeerNative.SYNCHRONIZE, false, pid);
        if (raw == IntPtr.Zero)
            return PeerVerificationResult.Fail($"OpenProcess({pid}) failed (error {Marshal.GetLastWin32Error()})");

        var handle = new SafeProcessHandle(raw, ownsHandle: true);
        bool accepted = false;
        try
        {
            // From here the handle pins the PID. Re-check that the pipe still names this PID and that
            // the client is still connected: if the original client had already exited, the pipe is
            // broken and/or the process we opened is a newer process (created after the accept).
            bool stable = PipePeerNative.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out uint pid2) && pid2 == pid;
            bool exited = PipePeerNative.WaitForSingleObject(raw, 0) != PipePeerNative.WAIT_TIMEOUT;
            long created = PipePeerNative.TryGetCreationFileTime(raw);
            string? image = PipePeerNative.TryGetImagePath(raw);
            string? canonicalImage = image == null ? null : PipePeerNative.TryCanonicalizePath(image);
            string? userSid = PipePeerNative.TryGetProcessUserSid(raw);
            uint? session = PipePeerNative.ProcessIdToSessionId(pid, out uint sid) ? sid : null;
            bool connected = PipePeerNative.PipeIsConnected(pipe.SafePipeHandle);

            string? mySid = WindowsIdentity.GetCurrent().User?.Value;
            if (mySid == null || !PipePeerNative.ProcessIdToSessionId((uint)Environment.ProcessId, out uint mySession))
                return PeerVerificationResult.Fail("could not determine the daemon's own identity");

            var reason = PeerPolicy.Evaluate(
                new PeerSnapshot
                {
                    Pid = pid,
                    ImagePath = canonicalImage,
                    UserSid = userSid,
                    SessionId = session,
                    CreationFileTime = created,
                    ProcessExited = exited,
                    PipeStillConnected = connected,
                    PidStableAfterHandleOpen = stable,
                },
                new PeerExpectation
                {
                    UserSid = mySid,
                    SessionId = mySession,
                    AllowedCanonicalImagePaths = allowed,
                    AcceptedAtFileTime = acceptedAt,
                });

            if (reason != null) return PeerVerificationResult.Fail(reason);

            accepted = true;
            return PeerVerificationResult.Success(new VerifiedPeer(pid, canonicalImage!, userSid!, handle));
        }
        finally
        {
            if (!accepted) handle.Dispose();
        }
    }
}

internal static class PipePeerNative
{
    internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    internal const uint SYNCHRONIZE = 0x00100000;
    internal const uint WAIT_TIMEOUT = 0x102;
    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenUser = 1;

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetNamedPipeClientComputerNameW(SafePipeHandle pipe, StringBuilder name, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PeekNamedPipe(SafePipeHandle pipe, IntPtr buffer, uint size, IntPtr bytesRead, IntPtr totalAvail, IntPtr bytesLeft);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint size, uint flags);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int length, out int returned);

    /// <summary>
    /// GetNamedPipeClientComputerName succeeds only for remote clients; for a local client it fails with
    /// ERROR_PIPE_LOCAL (229). Anything other than a clean ERROR_PIPE_LOCAL is treated as remote (fail closed).
    /// </summary>
    internal static bool IsRemoteClient(SafePipeHandle pipe)
    {
        const int ERROR_PIPE_LOCAL = 229;
        var name = new StringBuilder(256);
        if (GetNamedPipeClientComputerNameW(pipe, name, (uint)name.Capacity)) return true;
        return Marshal.GetLastWin32Error() != ERROR_PIPE_LOCAL;
    }

    internal static bool PipeIsConnected(SafePipeHandle pipe) =>
        PeekNamedPipe(pipe, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);

    internal static long TryGetCreationFileTime(IntPtr process) =>
        GetProcessTimes(process, out long created, out _, out _, out _) ? created : 0;

    internal static string? TryGetImagePath(IntPtr process)
    {
        var sb = new StringBuilder(1024);
        uint size = (uint)sb.Capacity;
        return QueryFullProcessImageNameW(process, 0, sb, ref size) ? sb.ToString() : null;
    }

    internal static string? TryGetProcessUserSid(IntPtr process)
    {
        if (!OpenProcessToken(process, TOKEN_QUERY, out IntPtr token)) return null;
        try
        {
            GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out int needed);
            if (needed <= 0) return null;
            IntPtr buf = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetTokenInformation(token, TokenUser, buf, needed, out _)) return null;
                // TOKEN_USER begins with SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; }
                return new SecurityIdentifier(Marshal.ReadIntPtr(buf)).Value;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        finally { CloseHandle(token); }
    }

    /// <summary>Resolves symlinks/junctions/8.3 names/casing to one canonical form; null if the file cannot be opened.</summary>
    internal static string? TryCanonicalizePath(string path)
    {
        try
        {
            using var file = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var sb = new StringBuilder(1024);
            uint n = GetFinalPathNameByHandleW(file.DangerousGetHandle(), sb, (uint)sb.Capacity, 0);
            if (n == 0) return null;
            if (n >= sb.Capacity)
            {
                sb = new StringBuilder((int)n + 1);
                n = GetFinalPathNameByHandleW(file.DangerousGetHandle(), sb, (uint)sb.Capacity, 0);
                if (n == 0 || n >= sb.Capacity) return null;
            }
            string p = sb.ToString();
            if (p.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) return @"\\" + p[8..];
            if (p.StartsWith(@"\\?\", StringComparison.Ordinal)) return p[4..];
            return p;
        }
        catch
        {
            return null;
        }
    }
}
