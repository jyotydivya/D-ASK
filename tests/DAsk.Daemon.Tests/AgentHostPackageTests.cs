using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DAsk.Daemon.AgentHost;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>The package check that runs before the agent host starts. Any difference must stop the host.</summary>
public sealed class AgentHostPackageTests : IDisposable
{
    private const string Node = "runtime/node/node.exe";
    private const string Entry = "dist/agent-host/agent/host/stdioHost.js";
    private readonly string _root = Path.Combine(Path.GetTempPath(), "dask-pkg-" + Guid.NewGuid().ToString("N"));
    private string _manifestHash = "";

    public AgentHostPackageTests()
    {
        Write(Node, "node binary");
        Write(Entry, "console.log('host')");
        Write("dist/agent-host/agent/host/host.js", "module.exports = {}");
        WriteManifest();
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, true); } catch { }
    }

    private void Write(string rel, string text)
    {
        string full = Path.Combine(_root, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, text);
    }

    private static string Hash(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();

    private void WriteManifest(IEnumerable<string>? paths = null, string nodePath = Node, string entryPath = Entry, int version = 1)
    {
        var files = (paths ?? new[] { Node, Entry, "dist/agent-host/agent/host/host.js" })
            .Select(p => new { path = p, sha256 = File.Exists(Path.Combine(_root, p)) ? Hash(File.ReadAllBytes(Path.Combine(_root, p))) : "00" });
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(new { version, nodePath, entryPath, files });
        File.WriteAllBytes(Path.Combine(_root, "package-manifest.json"), json);
        _manifestHash = Hash(json);
    }

    private string? Verify(string? expected = null, string node = Node, string entry = Entry) =>
        PackageVerifier.Verify(_root, "package-manifest.json", expected ?? _manifestHash, node, entry);

    [Fact]
    public void An_unchanged_package_passes() => Assert.Null(Verify());

    [Fact]
    public void A_changed_host_file_is_refused()
    {
        Write("dist/agent-host/agent/host/host.js", "module.exports = { evil: true }");
        Assert.Contains("changed", Verify());
    }

    [Fact]
    public void A_changed_node_runtime_is_refused()
    {
        Write(Node, "another binary");
        Assert.Contains("changed", Verify());
    }

    [Fact]
    public void A_missing_file_is_refused()
    {
        File.Delete(Path.Combine(_root, "dist/agent-host/agent/host/host.js"));
        Assert.Contains("missing", Verify());
    }

    [Fact]
    public void An_added_file_in_the_host_folder_is_refused()
    {
        Write("dist/agent-host/agent/host/extra.js", "1");
        Assert.Contains("Unexpected file", Verify());
    }

    [Fact]
    public void A_rewritten_manifest_does_not_match_the_configured_hash()
    {
        string pinned = _manifestHash;
        Write("dist/agent-host/agent/host/host.js", "module.exports = { evil: true }");
        WriteManifest();
        Assert.Contains("expected hash", Verify(pinned));
    }

    [Fact]
    public void No_configured_hash_is_refused() =>
        Assert.Contains("No expected", PackageVerifier.Verify(_root, "package-manifest.json", " ", Node, Entry));

    [Fact]
    public void A_missing_manifest_is_refused() =>
        Assert.Contains("not found", PackageVerifier.Verify(_root, "nope.json", _manifestHash, Node, Entry));

    [Fact]
    public void A_path_outside_the_package_is_refused()
    {
        WriteManifest(new[] { Node, Entry, "dist/agent-host/agent/host/host.js", "../outside.js" });
        Assert.Contains("outside the package", Verify());
    }

    [Fact]
    public void Launching_a_different_node_than_the_manifest_is_refused()
    {
        Write("runtime/other/node.exe", "other");
        Assert.Contains("Node runtime", Verify(node: "runtime/other/node.exe"));
    }

    [Fact]
    public void Launching_a_different_entry_than_the_manifest_is_refused() =>
        Assert.Contains("host entry", Verify(entry: "dist/agent-host/agent/host/host.js"));

    [Fact]
    public void A_node_runtime_the_manifest_does_not_cover_is_refused()
    {
        WriteManifest(new[] { Entry, "dist/agent-host/agent/host/host.js" });
        Assert.Contains("not covered", Verify());
    }

    [Fact]
    public void An_unknown_manifest_version_is_refused()
    {
        WriteManifest(version: 2);
        Assert.Contains("unsupported", Verify());
    }

    [Fact]
    public void An_unreadable_manifest_is_refused()
    {
        byte[] junk = Encoding.UTF8.GetBytes("not json");
        File.WriteAllBytes(Path.Combine(_root, "package-manifest.json"), junk);
        Assert.Contains("cannot be read", Verify(Hash(junk)));
    }

    private AgentHostManager Manager(Action<AgentHostOptions> configure)
    {
        var o = new AgentHostOptions { RepoRoot = _root, EntryPath = Entry, NodePath = Node, AutoRestart = false, ReadyTimeoutMs = 3_000 };
        configure(o);
        return new AgentHostManager(Microsoft.Extensions.Options.Options.Create(o), NullLogger<AgentHostManager>.Instance);
    }

    [Fact]
    public async Task A_required_package_with_no_manifest_never_starts_the_host()
    {
        await using var m = Manager(o => o.RequireVerifiedPackage = true);
        var r = await m.SubmitAsync("What is 1+1?", "session");
        Assert.False(r.Accepted);
        Assert.Equal("host_unavailable", r.RejectionCode);
        Assert.Null(m.Health().Pid);
    }

    [Fact]
    public async Task A_tampered_package_never_starts_the_host_and_reports_why()
    {
        Write("dist/agent-host/agent/host/host.js", "module.exports = { evil: true }");
        await using var m = Manager(o =>
        {
            o.RequireVerifiedPackage = true;
            o.ManifestPath = "package-manifest.json";
            o.ManifestSha256 = _manifestHash;
        });
        var r = await m.SubmitAsync("What is 1+1?", "session");
        Assert.False(r.Accepted);
        Assert.Equal("host_unavailable", r.RejectionCode);
        Assert.Null(m.Health().Pid);
        Assert.Equal("failed", m.Health().State);
        Assert.Contains("changed", m.Health().LastError);
    }

    [Fact]
    public void Development_runs_do_not_require_a_package()
    {
        var o = new AgentHostOptions();
        Assert.False(o.RequireVerifiedPackage);
        Assert.Null(o.ManifestPath);
        Assert.Null(o.ManifestSha256);
    }
}
