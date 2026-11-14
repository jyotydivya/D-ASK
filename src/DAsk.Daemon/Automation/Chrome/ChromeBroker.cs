using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using DAsk.Daemon.IPC;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Chrome;

public sealed class ChromeBrokerOptions
{
    /// <summary>The ONLY executable allowed to connect: the D-ASK native-messaging host (dask-chrome-host.exe).</summary>
    public required string HostExePath { get; init; }
    /// <summary>The D-ASK extension id; the host must report exactly this calling origin.</summary>
    public required string ExtensionId { get; init; }
    /// <summary>The host must have been started (directly or via cmd.exe) by one of these Chrome executables. Empty: not checked (tests only).</summary>
    public IReadOnlyList<string> ChromeExePaths { get; init; } = Array.Empty<string>();
    public string? PipeName { get; init; }
}

/// <summary>
/// The daemon end of the Chrome bridge. A named pipe (current user only, remote clients rejected, explicit DACL) that accepts exactly one
/// verified peer at a time: the D-ASK native host executable (exact canonical path, same user and session), started by Chrome, reporting the
/// D-ASK extension's origin. Anything else is disconnected before a single byte is read. There is no TCP listener.
/// </summary>
public sealed class ChromeBroker : IDisposable
{
    private readonly ChromeBrokerOptions _o;
    private readonly ILogger? _log;
    private readonly CancellationTokenSource _life = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly SemaphoreSlim _write = new(1, 1);
    private NamedPipeServerStream? _active;
    private long _next;
    public string PipeName { get; }
    public int Rejected;              // peers refused (unauthorized clients)
    public int Accepted;
    public JsonElement? Hello { get; private set; }
    public int? ChromePid { get; private set; }
    public string? ChromePath { get; private set; }
    public bool Connected => _active is { IsConnected: true };
    public event Action? ConnectionChanged;

    public static string DefaultPipeName()
    {
        string sid = WindowsIdentity.GetCurrent().User?.Value ?? "unknown";
        return "dask-chrome-broker-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid)))[..16].ToLowerInvariant();
    }

    public ChromeBroker(ChromeBrokerOptions options, ILogger? logger = null)
    {
        _o = options; _log = logger;
        PipeName = options.PipeName ?? DefaultPipeName();
    }

    public void Start() => _ = Task.Run(AcceptLoop);

    private async Task AcceptLoop()
    {
        bool first = true;
        var verifier = new WindowsPipePeerVerifier(new[] { _o.HostExePath }, AppContext.BaseDirectory, (ILogger?)_log ?? Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance);
        while (!_life.IsCancellationRequested)
        {
            NamedPipeServerStream pipe;
            try { pipe = HardenedPipeFactory.Create(PipeName, 4, PipeSecurityFactory.CreateForCurrentUser(), first); first = false; }
            catch (Exception ex) { _log?.LogError(ex, "[Chrome] Broker pipe could not be created; Chrome control is unavailable."); return; }
            try { await pipe.WaitForConnectionAsync(_life.Token); }
            catch { pipe.Dispose(); return; }
            long accepted = DateTime.UtcNow.ToFileTimeUtc();
            var v = verifier.Verify(pipe, accepted);
            string? why = v.Peer == null ? v.FailureReason : ParentCheck((int)v.Peer.Pid);
            if (why != null)
            {
                Interlocked.Increment(ref Rejected);
                _log?.LogWarning("[Chrome] Refused a broker client: {Reason}.", why);
                v.Peer?.Dispose();
                try { pipe.Disconnect(); } catch { }
                pipe.Dispose();
                continue;
            }
            _ = Task.Run(() => Serve(pipe, v.Peer!));
        }
    }

    /// <summary>The host must have been started by an allowed chrome.exe (directly or through cmd.exe, as Chrome does on Windows).</summary>
    private string? ParentCheck(int hostPid)
    {
        if (_o.ChromeExePaths.Count == 0) return null;
        var allowed = _o.ChromeExePaths.Select(p => Path.GetFullPath(p)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        int pid = hostPid;
        for (int depth = 0; depth < 3; depth++)
        {
            int parent = ProcessTree.ParentOf(pid);
            if (parent <= 0) break;
            string? image = ProcessTree.ImagePath(parent);
            if (image != null && allowed.Contains(image)) { ChromePid = parent; ChromePath = image; return null; }
            pid = parent;
        }
        return "the host was not started by Google Chrome";
    }

    private async Task Serve(NamedPipeServerStream pipe, VerifiedPeer peer)
    {
        using var _ = peer;
        try
        {
            var hello = await ReadFrame(pipe, _life.Token);
            if (hello == null) return;
            using (var doc = JsonDocument.Parse(hello))
            {
                string origin = doc.RootElement.TryGetProperty("origin", out var o) ? o.GetString() ?? "" : "";
                if (origin != $"chrome-extension://{_o.ExtensionId}/")
                {
                    Interlocked.Increment(ref Rejected);
                    _log?.LogWarning("[Chrome] Refused a host started for another extension origin.");
                    return;
                }
            }
            var old = Interlocked.Exchange(ref _active, pipe);
            if (old != null) { try { old.Dispose(); } catch { } }
            Interlocked.Increment(ref Accepted);
            _log?.LogInformation("[Chrome] D-ASK extension connected (host pid {Pid}, Chrome pid {Chrome}).", peer.Pid, ChromePid);
            ConnectionChanged?.Invoke();
            while (!_life.IsCancellationRequested)
            {
                var frame = await ReadFrame(pipe, _life.Token);
                if (frame == null) break;
                JsonElement msg;
                try { using var d = JsonDocument.Parse(frame); msg = d.RootElement.Clone(); } catch { continue; }
                if (msg.TryGetProperty("event", out var ev))
                {
                    if (ev.GetString() == "hello") Hello = msg;
                    continue;
                }
                if (msg.TryGetProperty("id", out var idp) && idp.GetString() is { } id && _pending.TryRemove(id, out var tcs)) tcs.TrySetResult(msg);
            }
        }
        catch (Exception ex) { _log?.LogInformation("[Chrome] Extension connection ended ({Type}).", ex.GetType().Name); }
        finally
        {
            if (Interlocked.CompareExchange(ref _active, null, pipe) == pipe)
            {
                Hello = null;
                foreach (var k in _pending.Keys) if (_pending.TryRemove(k, out var t)) t.TrySetException(new IOException("Chrome disconnected"));
                ConnectionChanged?.Invoke();
            }
            try { pipe.Dispose(); } catch { }
        }
    }

    /// <summary>Sends one command and waits for its reply ({ok, result} or {ok:false, error}).</summary>
    public async Task<(bool Ok, JsonElement Result, string Error)> SendAsync(string cmd, object args, string? session, int timeoutMs, CancellationToken ct)
    {
        var pipe = _active;
        if (pipe is not { IsConnected: true }) return (false, default, "Chrome with the D-ASK extension is not connected.");
        string id = "m" + Interlocked.Increment(ref _next);
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { id, cmd, args, session });
        await _write.WaitAsync(ct);
        try { await WriteFrame(pipe, bytes, ct); }
        catch (Exception ex) { _pending.TryRemove(id, out _); return (false, default, $"Chrome could not be reached ({ex.GetType().Name})."); }
        finally { _write.Release(); }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(timeoutMs);
        await using var reg = timeout.Token.Register(() => tcs.TrySetCanceled());
        try
        {
            var reply = await tcs.Task;
            bool ok = reply.TryGetProperty("ok", out var okp) && okp.ValueKind == JsonValueKind.True;
            return ok ? (true, reply.TryGetProperty("result", out var r) ? r.Clone() : default, "")
                      : (false, default, reply.TryGetProperty("error", out var e) ? e.ToString() : "failed");
        }
        catch (TaskCanceledException) { _pending.TryRemove(id, out _); return (false, default, ct.IsCancellationRequested ? "cancelled" : "Chrome did not answer in time."); }
        catch (IOException) { return (false, default, "Chrome disconnected."); }
    }

    private const int MaxFrame = 4 * 1024 * 1024;
    private static async Task<byte[]?> ReadFrame(Stream s, CancellationToken ct)
    {
        var len = new byte[4];
        if (!await ReadExactly(s, len, ct)) return null;
        int n = BitConverter.ToInt32(len, 0);
        if (n <= 0 || n > MaxFrame) return null;
        var buf = new byte[n];
        return await ReadExactly(s, buf, ct) ? buf : null;
    }
    private static async Task<bool> ReadExactly(Stream s, byte[] buf, CancellationToken ct)
    {
        int off = 0;
        while (off < buf.Length) { int r = await s.ReadAsync(buf.AsMemory(off), ct); if (r == 0) return false; off += r; }
        return true;
    }
    private static async Task WriteFrame(Stream s, byte[] payload, CancellationToken ct)
    {
        await s.WriteAsync(BitConverter.GetBytes(payload.Length), ct);
        await s.WriteAsync(payload, ct);
        await s.FlushAsync(ct);
    }

    public void Dispose()
    {
        _life.Cancel();
        try { _active?.Dispose(); } catch { }
    }
}

/// <summary>Parent process and image path lookups (toolhelp snapshot; QueryFullProcessImageName).</summary>
internal static class ProcessTree
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32 { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageNameW(IntPtr p, uint f, StringBuilder s, ref uint n);

    public static int ParentOf(int pid)
    {
        IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
        if (snap == new IntPtr(-1)) return -1;
        try
        {
            var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
            for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e))
                if (e.th32ProcessID == (uint)pid) return (int)e.th32ParentProcessID;
            return -1;
        }
        finally { CloseHandle(snap); }
    }

    public static string? ImagePath(int pid)
    {
        IntPtr h = OpenProcess(0x1000, false, (uint)pid);
        if (h == IntPtr.Zero) return null;
        try { var sb = new StringBuilder(1024); uint n = (uint)sb.Capacity; return QueryFullProcessImageNameW(h, 0, sb, ref n) ? Path.GetFullPath(sb.ToString()) : null; }
        finally { CloseHandle(h); }
    }
}
