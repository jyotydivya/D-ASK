using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DAsk.Daemon.AgentHost;

/// <summary>
/// Checks the pinned Node runtime and the compiled agent host against the package manifest before the host is
/// started. Any difference means the host does not start.
///
/// This detects corruption and changes to those files. It is not a defence against someone who can also rewrite
/// the daemon and its settings in the same folder: that takes code signing and a protected install location.
/// </summary>
public static class PackageVerifier
{
    public const string HostDirectory = "dist/agent-host";

    public sealed record ManifestFile(
        [property: JsonPropertyName("path")] string Path,
        [property: JsonPropertyName("sha256")] string Sha256);

    public sealed record Manifest(
        [property: JsonPropertyName("version")] int Version,
        [property: JsonPropertyName("nodePath")] string NodePath,
        [property: JsonPropertyName("entryPath")] string EntryPath,
        [property: JsonPropertyName("files")] List<ManifestFile> Files);

    /// <returns>Null when everything matches, otherwise the reason. It names a file and never holds file content.</returns>
    public static string? Verify(string root, string manifestPath, string? expectedManifestSha256, string nodePath, string entryPath)
    {
        string manifestFull = Path.GetFullPath(Path.Combine(root, manifestPath));
        if (!File.Exists(manifestFull)) return $"Package manifest not found: {manifestPath}";
        if (string.IsNullOrWhiteSpace(expectedManifestSha256)) return "No expected package manifest hash is configured.";

        byte[] bytes = File.ReadAllBytes(manifestFull);
        if (!HashEquals(Convert.ToHexString(SHA256.HashData(bytes)), expectedManifestSha256))
            return "The package manifest does not match its expected hash.";

        Manifest? manifest;
        try { manifest = JsonSerializer.Deserialize<Manifest>(bytes); }
        catch (JsonException) { return "The package manifest cannot be read."; }
        if (manifest is not { Version: 1, Files.Count: > 0 }) return "The package manifest has an unsupported format.";

        // What will actually be launched must be what the manifest vouches for.
        string fullRoot = Path.GetFullPath(root);
        if (!SamePath(Path.Combine(fullRoot, manifest.NodePath), Path.GetFullPath(Path.Combine(fullRoot, nodePath))))
            return "The configured Node runtime is not the one in the package manifest.";
        if (!SamePath(Path.Combine(fullRoot, manifest.EntryPath), Path.GetFullPath(Path.Combine(fullRoot, entryPath))))
            return "The configured host entry is not the one in the package manifest.";

        var listed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in manifest.Files)
        {
            string full = Path.GetFullPath(Path.Combine(fullRoot, f.Path));
            if (!full.StartsWith(fullRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                return $"The package manifest lists a path outside the package: {f.Path}";
            if (!File.Exists(full)) return $"Package file missing: {f.Path}";
            using var stream = File.OpenRead(full);
            if (!HashEquals(Convert.ToHexString(SHA256.HashData(stream)), f.Sha256)) return $"Package file changed: {f.Path}";
            listed.Add(full);
        }

        if (!listed.Contains(Path.GetFullPath(Path.Combine(fullRoot, manifest.NodePath)))) return "The Node runtime is not covered by the package manifest.";
        if (!listed.Contains(Path.GetFullPath(Path.Combine(fullRoot, manifest.EntryPath)))) return "The host entry is not covered by the package manifest.";

        // Node resolves requires from this folder, so an added file is as good as a changed one.
        string hostDir = Path.GetFullPath(Path.Combine(fullRoot, HostDirectory));
        if (Directory.Exists(hostDir))
        {
            foreach (var file in Directory.EnumerateFiles(hostDir, "*", SearchOption.AllDirectories))
                if (!listed.Contains(Path.GetFullPath(file)))
                    return $"Unexpected file in the agent host folder: {Path.GetRelativePath(fullRoot, file)}";
        }
        return null;
    }

    private static bool HashEquals(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
}
