using System.Diagnostics;
using System.IO.Pipes;
using System.Reflection;
using System.Text.RegularExpressions;
using DAsk.Daemon.IPC;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>Phase 4B-1R.8 (H3): peer-identity policy and verifier, plus structural fail-closed guards.</summary>
public class PipePeerVerifierTests
{
    // ───────────────────────── pure policy ─────────────────────────

    private const long Accepted = 133_000_000_000_000_000;

    private static PeerSnapshot GoodSnapshot() => new()
    {
        Pid = 4242,
        IsRemoteClient = false,
        ImagePath = @"C:\apps\hud-native.exe",
        UserSid = "S-1-5-21-1-2-3-1001",
        SessionId = 1,
        CreationFileTime = Accepted - 10_000_000,
        ProcessExited = false,
        PipeStillConnected = true,
        PidStableAfterHandleOpen = true,
    };

    private static PeerExpectation GoodExpectation() => new()
    {
        UserSid = "S-1-5-21-1-2-3-1001",
        SessionId = 1,
        AllowedCanonicalImagePaths = new[] { @"C:\apps\hud-native.exe" },
        AcceptedAtFileTime = Accepted,
    };

    [Fact]
    public void Policy_AcceptsAFullyMatchingPeer() =>
        Assert.Null(PeerPolicy.Evaluate(GoodSnapshot(), GoodExpectation()));

    [Fact]
    public void Policy_AcceptsProcessCreatedExactlyAtAcceptTime() =>
        Assert.Null(PeerPolicy.Evaluate(GoodSnapshot() with { CreationFileTime = Accepted }, GoodExpectation()));

    [Fact]
    public void Policy_ImageComparisonIsCaseInsensitive() =>
        Assert.Null(PeerPolicy.Evaluate(GoodSnapshot() with { ImagePath = @"c:\APPS\HUD-NATIVE.EXE" }, GoodExpectation()));

    public static IEnumerable<object[]> Rejections() => new[]
    {
        new object[] { "remote client", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { IsRemoteClient = true }), "remote" },
        new object[] { "zero pid", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { Pid = 0 }), "PID unavailable" },
        new object[] { "pid changed while opening process", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { PidStableAfterHandleOpen = false }), "race" },
        new object[] { "process already exited", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { ProcessExited = true }), "exited" },
        new object[] { "pipe broke before handle acquired", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { PipeStillConnected = false }), "no longer connected" },
        new object[] { "creation time unknown", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { CreationFileTime = 0 }), "creation time unavailable" },
        new object[] { "PID reuse: created after accept", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { CreationFileTime = Accepted + 1 }), "PID reuse" },
        new object[] { "different user", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { UserSid = "S-1-5-21-9-9-9-1002" }), "different user" },
        new object[] { "unknown user", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { UserSid = null }), "different user" },
        new object[] { "different session", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { SessionId = 2 }), "logon session" },
        new object[] { "unknown session", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { SessionId = null }), "logon session" },
        new object[] { "image unavailable", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { ImagePath = null }), "image path unavailable" },
        new object[] { "image not allowed", (Func<PeerSnapshot, PeerSnapshot>)(s => s with { ImagePath = @"C:\evil\hud-native.exe" }), "not in the allowed" },
    };

    [Theory]
    [MemberData(nameof(Rejections))]
    public void Policy_RejectsEachIdentityFailure(string label, Func<PeerSnapshot, PeerSnapshot> mutate, string expectedFragment)
    {
        var reason = PeerPolicy.Evaluate(mutate(GoodSnapshot()), GoodExpectation());
        Assert.True(reason != null, $"'{label}' was accepted");
        Assert.Contains(expectedFragment, reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Policy_EmptyAllowlist_FailsClosed()
    {
        var reason = PeerPolicy.Evaluate(GoodSnapshot(), GoodExpectation() with { AllowedCanonicalImagePaths = Array.Empty<string>() });
        Assert.NotNull(reason);
        Assert.Contains("fail closed", reason, StringComparison.OrdinalIgnoreCase);
    }

    // ───────────────────────── real verifier against real processes ─────────────────────────

    private static string SelfPath => Environment.ProcessPath!;

    private static async Task<(NamedPipeServerStream server, NamedPipeClientStream client)> ConnectedPairAsync(bool viaMachineName = false)
    {
        string name = "test-h3-verify-" + Guid.NewGuid().ToString("N");
        var server = new NamedPipeServerStream(name, PipeDirection.InOut, 4, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var wait = server.WaitForConnectionAsync();
        var client = new NamedPipeClientStream(viaMachineName ? Environment.MachineName : ".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        await client.ConnectAsync(5000);
        await wait;
        return (server, client);
    }

    private static WindowsPipePeerVerifier Verifier(params string[] allowed) =>
        new(allowed, AppContext.BaseDirectory, NullLogger.Instance);

    [Fact]
    public async Task Verifier_AcceptsThisProcess_WhenItsImageIsAllowed_AndPinsItsPid()
    {
        var (server, client) = await ConnectedPairAsync();
        using (server) using (client)
        {
            var result = Verifier(SelfPath).Verify(server, DateTime.UtcNow.ToFileTimeUtc());
            Assert.True(result.Ok, result.FailureReason);
            using var peer = result.Peer!;
            Assert.Equal((uint)Environment.ProcessId, peer.Pid);
            Assert.False(string.IsNullOrEmpty(peer.ImagePath));
        }
    }

    [Fact]
    public async Task Verifier_CanonicalizesAllowlist_CaseAndSlashesDoNotMatter()
    {
        var (server, client) = await ConnectedPairAsync();
        using (server) using (client)
        {
            string messy = SelfPath.ToUpperInvariant().Replace('\\', '/');
            var result = Verifier(messy).Verify(server, DateTime.UtcNow.ToFileTimeUtc());
            Assert.True(result.Ok, result.FailureReason);
            result.Peer!.Dispose();
        }
    }

    [Fact]
    public async Task Verifier_RejectsWhenImageIsNotAllowed()
    {
        string other = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var (server, client) = await ConnectedPairAsync();
        using (server) using (client)
        {
            var result = Verifier(other).Verify(server, DateTime.UtcNow.ToFileTimeUtc());
            Assert.False(result.Ok);
            Assert.Contains("not in the allowed", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("nonexistent")]
    public async Task Verifier_FailsClosed_WhenAllowlistIsEmptyOrUnresolvable(string kind)
    {
        var verifier = kind == "empty" ? Verifier() : Verifier(@"C:\definitely\not\here\hud-native.exe");
        var (server, client) = await ConnectedPairAsync();
        using (server) using (client)
        {
            var result = verifier.Verify(server, DateTime.UtcNow.ToFileTimeUtc());
            Assert.False(result.Ok);
            Assert.Contains("fail closed", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task Verifier_RejectsProcessCreatedAfterTheAcceptTimestamp_PidReuseRule()
    {
        var (server, client) = await ConnectedPairAsync();
        using (server) using (client)
        {
            // Pretend the connection was accepted long before this process started.
            long beforeProcessStart = Process.GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc() - 10_000_000L * 60;
            var result = Verifier(SelfPath).Verify(server, beforeProcessStart);
            Assert.False(result.Ok);
            Assert.Contains("PID reuse", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task Verifier_RejectsRemoteSmbClient_EvenWhenTheTransportAllowsIt()
    {
        // A pipe created with the default settings accepts SMB opens, so this exercises the verifier's own
        // remote-client check independently of PIPE_REJECT_REMOTE_CLIENTS.
        var (server, client) = await ConnectedPairAsync(viaMachineName: true);
        using (server) using (client)
        {
            var result = Verifier(SelfPath).Verify(server, DateTime.UtcNow.ToFileTimeUtc());
            Assert.False(result.Ok);
            Assert.Contains("remote", result.FailureReason, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task Verifier_RejectsAPipeWhoseClientHasAlreadyGone_BrokenPipeIsNotAccepted()
    {
        var (server, client) = await ConnectedPairAsync();
        using (server)
        {
            // Control: while the client is connected the same process verifies fine.
            var ok = Verifier(SelfPath).Verify(server, DateTime.UtcNow.ToFileTimeUtc());
            Assert.True(ok.Ok, ok.FailureReason);
            ok.Peer!.Dispose();

            client.Dispose();
            PeerVerificationResult result = default;
            for (int i = 0; i < 40; i++)
            {
                result = Verifier(SelfPath).Verify(server, DateTime.UtcNow.ToFileTimeUtc());
                if (!result.Ok) break;
                await Task.Delay(50);
            }
            Assert.False(result.Ok, "a pipe whose client disconnected was still accepted");
        }
    }

    [Fact]
    public void Verifier_DoesNotThrow_AndFailsClosed_OnAnUnusablePipe()
    {
        var server = new NamedPipeServerStream("test-h3-dead-" + Guid.NewGuid().ToString("N"), PipeDirection.InOut, 1);
        server.Dispose();
        var result = Verifier(SelfPath).Verify(server, DateTime.UtcNow.ToFileTimeUtc());
        Assert.False(result.Ok);
    }

    // ───────────────────────── structural guards ─────────────────────────

    [Fact]
    public void IpcClientSession_CannotBeConstructedWithoutAVerifier()
    {
        foreach (var ctor in typeof(IpcClientSession).GetConstructors(BindingFlags.Public | BindingFlags.Instance))
        {
            var p = ctor.GetParameters().SingleOrDefault(x => x.ParameterType == typeof(IPipePeerVerifier));
            Assert.NotNull(p);
            Assert.False(p!.IsOptional, "peerVerifier must be a required parameter (no default)");
            Assert.False(p.HasDefaultValue);
        }
    }

    [Fact]
    public void Production_AssemblyContainsNoPermissiveVerifier()
    {
        var implementers = typeof(IPipePeerVerifier).Assembly.GetTypes()
            .Where(t => typeof(IPipePeerVerifier).IsAssignableFrom(t) && !t.IsInterface)
            .Select(t => t.Name).ToList();
        Assert.Equal(new[] { nameof(WindowsPipePeerVerifier) }, implementers);
        // ...and the permissive one lives only in the test assembly.
        Assert.Contains(typeof(AllowAnyPeerVerifierForTests).Assembly.GetName().Name, new[] { "DAsk.Daemon.Tests" });
    }

    [Fact]
    public void Production_NeverImpersonatesPipeClients()
    {
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var banned = new Regex(@"RunAsClient|ImpersonateNamedPipeClient|RunImpersonated|ImpersonateLoggedOnUser|SetThreadToken|ImpersonationLevel\.(Impersonation|Delegation)");
        var offenders = new List<string>();
        foreach (var dir in new[] { "src/DAsk.Daemon", "src/DAsk.Protocol" })
        {
            foreach (var f in Directory.EnumerateFiles(Path.Combine(root, dir), "*.cs", SearchOption.AllDirectories))
            {
                string rel = f.Substring(root.Length);
                if (rel.Contains(@"\obj\") || rel.Contains(@"\bin\")) continue;
                if (banned.IsMatch(File.ReadAllText(f))) offenders.Add(rel);
            }
        }
        Assert.Empty(offenders);
    }

    [Fact]
    public void Appsettings_DefaultAllowlist_IsNonEmptyAndExactFilePaths()
    {
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "src", "DAsk.Daemon", "appsettings.json")));
        var list = doc.RootElement.GetProperty("Daemon").GetProperty("AllowedClientImagePaths").EnumerateArray().Select(e => e.GetString()!).ToList();
        Assert.NotEmpty(list);
        Assert.All(list, p =>
        {
            Assert.EndsWith("hud-native.exe", p, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("*", p);
        });
    }
}
