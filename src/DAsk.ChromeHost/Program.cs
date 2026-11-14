// D-ASK Chrome native-messaging host (2026-11-14).
// Chrome starts this program for the D-ASK extension ONLY (the host manifest lists exactly that extension origin) and talks to it over
// stdin/stdout with 4-byte little-endian length-prefixed JSON. This program does nothing on its own: it relays each message, unchanged,
// between Chrome and the D-ASK daemon's broker pipe, which is restricted to this user, rejects remote clients and verifies that the
// connecting process is this exact executable started by Chrome. No TCP port is opened anywhere. It exits when either side closes.
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

static class Program
{
    private const int MaxMessage = 4 * 1024 * 1024;

    public static string BrokerPipeName()
    {
        string sid = WindowsIdentity.GetCurrent().User?.Value ?? "unknown";
        return "dask-chrome-broker-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid)))[..16].ToLowerInvariant();
    }

    static async Task<int> Main(string[] args)
    {
        string origin = args.FirstOrDefault(a => a.StartsWith("chrome-extension://", StringComparison.Ordinal)) ?? "";
        using var stdin = Console.OpenStandardInput();
        using var stdout = Console.OpenStandardOutput();
        using var pipe = new NamedPipeClientStream(".", BrokerPipeName(), PipeDirection.InOut, PipeOptions.Asynchronous);
        try { await pipe.ConnectAsync(3000); }
        catch
        {
            await WriteFrame(stdout, Encoding.UTF8.GetBytes("{\"event\":\"daemon_unavailable\"}"));
            return 2;
        }
        // First frame to the daemon: who started us (Chrome passes the calling extension's origin as an argument).
        await WriteFrame(pipe, Encoding.UTF8.GetBytes("{\"host\":\"dask-chrome-host\",\"origin\":\"" + origin.Replace("\"", "") + "\"}"));
        using var cts = new CancellationTokenSource();
        var a = Relay(stdin, pipe, cts.Token);
        var b = Relay(pipe, stdout, cts.Token);
        await Task.WhenAny(a, b);
        cts.Cancel();
        return 0;
    }

    private static async Task Relay(Stream from, Stream to, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var frame = await ReadFrame(from, ct);
                if (frame == null) return;
                await WriteFrame(to, frame);
            }
        }
        catch { /* either side closed */ }
    }

    private static async Task<byte[]?> ReadFrame(Stream s, CancellationToken ct)
    {
        var len = new byte[4];
        if (!await ReadExactly(s, len, ct)) return null;
        int n = BitConverter.ToInt32(len, 0);
        if (n <= 0 || n > MaxMessage) return null;
        var buf = new byte[n];
        return await ReadExactly(s, buf, ct) ? buf : null;
    }

    private static async Task<bool> ReadExactly(Stream s, byte[] buf, CancellationToken ct)
    {
        int off = 0;
        while (off < buf.Length)
        {
            int r = await s.ReadAsync(buf.AsMemory(off), ct);
            if (r == 0) return false;
            off += r;
        }
        return true;
    }

    private static async Task WriteFrame(Stream s, byte[] payload)
    {
        await s.WriteAsync(BitConverter.GetBytes(payload.Length));
        await s.WriteAsync(payload);
        await s.FlushAsync();
    }
}
