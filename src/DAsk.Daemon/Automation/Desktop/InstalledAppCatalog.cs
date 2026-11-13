using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using Microsoft.Win32;

namespace DAsk.Daemon.Automation.Desktop;

/// <summary>
/// One application installed on this computer, as Windows itself registers it. Never supplied by the agent: the agent names an
/// application in words, and the daemon resolves that name against what it discovered here.
///   exe       — a desktop program: <see cref="ExePath"/> started directly (CreateProcess, no shell), with the shortcut's OWN arguments
///   packaged  — a Store/MSIX app: activated by its AppUserModelID through IApplicationActivationManager (no shell, no command line)
/// </summary>
public sealed record InstalledApp(string Name, string Kind, string? ExePath, string? Arguments, string? WorkingDirectory, string? AppUserModelId, string Source)
{
    public const string KindExe = "exe";
    public const string KindPackaged = "packaged";
    /// <summary>The program's file name ("WINWORD.EXE"), used to recognise its windows.</summary>
    public string? ExeName => ExePath == null ? null : Path.GetFileName(ExePath);
    /// <summary>What exactly would be started, for the approval card and the audit.</summary>
    public string Target => Kind == KindPackaged ? $"app {AppUserModelId}" : ExePath!;
}

public interface IInstalledAppSource
{
    IReadOnlyList<InstalledApp> Discover();
}

public sealed record AppResolution(InstalledApp? App, IReadOnlyList<string> Candidates, string? Problem);

/// <summary>
/// The installed applications (discovered from Windows, cached) and the resolution of a spoken or typed name to exactly one of them.
/// Resolution is deterministic and never guesses: an exact name or alias wins; otherwise the words must match ONE application;
/// several matches are returned as candidates so the user can say which one.
/// </summary>
public sealed class InstalledAppCatalog
{
    private readonly IInstalledAppSource _source;
    private readonly TimeSpan _maxAge;
    private readonly Func<DateTimeOffset> _clock;
    private readonly object _gate = new();
    private IReadOnlyList<InstalledApp>? _apps;
    private DateTimeOffset _at;

    public InstalledAppCatalog(IInstalledAppSource source, TimeSpan? maxAge = null, Func<DateTimeOffset>? clock = null)
    {
        _source = source; _maxAge = maxAge ?? TimeSpan.FromMinutes(5); _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>Common ways people name applications → the name Windows registers. Only maps words; never adds an application.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Aliases = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["word"] = new[] { "word" }, ["ms word"] = new[] { "word" },
        ["excel"] = new[] { "excel" }, ["ms excel"] = new[] { "excel" },
        ["powerpoint"] = new[] { "powerpoint" }, ["outlook"] = new[] { "outlook", "outlook classic", "outlook new" },
        ["chrome"] = new[] { "google chrome" }, ["google chrome"] = new[] { "google chrome" },
        ["edge"] = new[] { "edge", "microsoft edge" }, ["firefox"] = new[] { "firefox", "mozilla firefox" },
        ["vs code"] = new[] { "visual studio code" }, ["vscode"] = new[] { "visual studio code" }, ["code"] = new[] { "visual studio code" },
        ["terminal"] = new[] { "terminal", "windows terminal" }, ["windows terminal"] = new[] { "terminal", "windows terminal" },
        ["powershell"] = new[] { "windows powershell" }, ["cmd"] = new[] { "command prompt" }, ["command line"] = new[] { "command prompt" },
        ["explorer"] = new[] { "file explorer" }, ["windows explorer"] = new[] { "file explorer" }, ["files"] = new[] { "file explorer" },
        ["settings"] = new[] { "settings" }, ["windows settings"] = new[] { "settings" },
        ["task manager"] = new[] { "task manager" }, ["control panel"] = new[] { "control panel" },
        ["calc"] = new[] { "calculator" }, ["paint"] = new[] { "paint" },
    };

    /// <summary>Lower case, letters and digits only, single spaces, without "the", "microsoft", "app", "application".</summary>
    public static string Normalize(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (char c in s.ToLowerInvariant()) sb.Append(char.IsLetterOrDigit(c) ? c : ' ');
        var words = sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        while (words.Count > 1 && (words[0] == "the" || words[0] == "microsoft" || words[0] == "my")) words.RemoveAt(0);
        while (words.Count > 1 && (words[^1] == "app" || words[^1] == "application" || words[^1] == "program")) words.RemoveAt(words.Count - 1);
        return string.Join(' ', words);
    }

    public IReadOnlyList<InstalledApp> All(bool refresh = false)
    {
        lock (_gate)
        {
            if (refresh || _apps == null || _clock() - _at > _maxAge)
            {
                _apps = Dedupe(_source.Discover());
                _at = _clock();
            }
            return _apps;
        }
    }

    /// <summary>One entry per normalized name: a Start-menu shortcut or packaged app first (what the user sees), then App Paths, then system tools.</summary>
    private static IReadOnlyList<InstalledApp> Dedupe(IEnumerable<InstalledApp> apps)
    {
        static int Rank(string source) => source switch { "start-menu" => 0, "packaged" => 1, "app-paths" => 2, _ => 3 };
        return apps.Where(a => a.Name.Length is > 0 and <= 120 && !string.IsNullOrWhiteSpace(Normalize(a.Name)))
            .GroupBy(a => Normalize(a.Name))
            .Select(g => g.OrderBy(a => Rank(a.Source)).First())
            .OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <param name="fresh">Read Windows again instead of the cache (the check right before starting an approved application).</param>
    public AppResolution Resolve(string query, bool fresh = false)
    {
        var r = ResolveIn(All(refresh: fresh), query);
        // Something installed a moment ago: look once more before saying it is not there.
        if (r.App == null && r.Candidates.Count == 0) r = ResolveIn(All(refresh: true), query);
        return r;
    }

    public static AppResolution ResolveIn(IReadOnlyList<InstalledApp> apps, string query)
    {
        string q = Normalize(query ?? string.Empty);
        if (q.Length == 0) return new(null, Array.Empty<string>(), "no application was named");
        var names = new List<string> { q };
        if (Aliases.TryGetValue(q, out var alias)) names.InsertRange(0, alias);

        // 1. Exact (normalized) name, in alias order.
        foreach (var n in names)
        {
            var exact = apps.FirstOrDefault(a => Normalize(a.Name) == n);
            if (exact != null) return new(exact, Array.Empty<string>(), null);
        }
        // 2. Every word of the request appears as a whole word in exactly one application name.
        var qWords = q.Split(' ');
        var matches = apps.Where(a => { var w = Normalize(a.Name).Split(' '); return qWords.All(w.Contains); }).ToList();
        if (matches.Count == 1) return new(matches[0], Array.Empty<string>(), null);
        if (matches.Count > 1)
            return new(null, matches.Select(a => a.Name).Take(8).ToList(), $"several installed applications match \"{query}\"");
        return new(null, Array.Empty<string>(), $"no installed application named \"{query}\" was found");
    }
}

/// <summary>Reads what Windows registers: Start-menu shortcuts, App Paths, packaged (Store/MSIX) apps, and built-in Windows tools.</summary>
public sealed class Win32InstalledAppSource : IInstalledAppSource
{
    private static readonly string[] Skip = { "uninstall", "uninst", "readme", "read me", "release notes", "help", "documentation", "license", "website", "support" };

    public IReadOnlyList<InstalledApp> Discover()
    {
        var list = new List<InstalledApp>();
        try { list.AddRange(StartMenu()); } catch { }
        try { list.AddRange(AppPaths()); } catch { }
        try { list.AddRange(Packaged()); } catch { }
        list.AddRange(SystemTools());
        return list;
    }

    private static bool Skipped(string name, string? exe) =>
        Skip.Any(s => name.Contains(s, StringComparison.OrdinalIgnoreCase)) ||
        (exe != null && Path.GetFileName(exe).StartsWith("unins", StringComparison.OrdinalIgnoreCase));

    private static IEnumerable<InstalledApp> StartMenu()
    {
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms),
            Environment.GetFolderPath(Environment.SpecialFolder.Programs),
        };
        foreach (var root in roots.Where(Directory.Exists))
        {
            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(root, "*.lnk", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, MaxRecursionDepth = 4 }).ToList(); }
            catch { continue; }
            foreach (var lnk in files)
            {
                var app = ReadShortcut(lnk);
                if (app != null) yield return app;
            }
        }
    }

    /// <summary>The shortcut's target program, arguments and working folder, read through IShellLinkW (nothing is started).</summary>
    public static InstalledApp? ReadShortcut(string lnkPath)
    {
        object? obj = null;
        try
        {
            obj = new CShellLink();
            ((IPersistFile)obj).Load(lnkPath, 0 /* STGM_READ */);
            var link = (IShellLinkW)obj;
            var path = new StringBuilder(1024); link.GetPath(path, path.Capacity, IntPtr.Zero, 0);
            var args = new StringBuilder(2048); link.GetArguments(args, args.Capacity);
            var dir = new StringBuilder(1024); link.GetWorkingDirectory(dir, dir.Capacity);
            string target = Environment.ExpandEnvironmentVariables(path.ToString());
            string name = Path.GetFileNameWithoutExtension(lnkPath);
            if (target.Length == 0 || !target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(target) || Skipped(name, target)) return null;
            string a = args.ToString().Trim();
            string wd = Environment.ExpandEnvironmentVariables(dir.ToString());
            return new InstalledApp(name, InstalledApp.KindExe, target, a.Length == 0 ? null : a, Directory.Exists(wd) ? wd : Path.GetDirectoryName(target), null, "start-menu");
        }
        catch { return null; }
        finally { if (obj != null) Marshal.FinalReleaseComObject(obj); }
    }

    private static IEnumerable<InstalledApp> AppPaths()
    {
        const string key = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";
        foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            using var k = hive.OpenSubKey(key);
            if (k == null) continue;
            foreach (var sub in k.GetSubKeyNames())
            {
                using var s = k.OpenSubKey(sub);
                if (s?.GetValue(null) is not string raw) continue;
                string exe = Environment.ExpandEnvironmentVariables(raw.Trim().Trim('"'));
                if (!exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(exe)) continue;
                string name;
                try { name = System.Diagnostics.FileVersionInfo.GetVersionInfo(exe).FileDescription?.Trim() ?? ""; } catch { name = ""; }
                if (name.Length == 0 || name.Length > 60) name = Path.GetFileNameWithoutExtension(exe);
                if (Skipped(name, exe)) continue;
                yield return new InstalledApp(name, InstalledApp.KindExe, exe, null, Path.GetDirectoryName(exe), null, "app-paths");
            }
        }
    }

    /// <summary>Store/MSIX apps from the shell's Applications folder: those whose id is a packaged AppUserModelID (contains '!').</summary>
    private static IEnumerable<InstalledApp> Packaged()
    {
        var result = new List<InstalledApp>();
        var iidItem = typeof(IShellItem).GUID;
        SHCreateItemFromParsingName("shell:AppsFolder", IntPtr.Zero, ref iidItem, out var folder);
        try
        {
            var bhid = new Guid("94f60519-2850-4924-aa5a-d15e84868039");   // BHID_EnumItems
            var iidEnum = typeof(IEnumShellItems).GUID;
            folder.BindToHandler(IntPtr.Zero, ref bhid, ref iidEnum, out var enumPtr);
            var items = (IEnumShellItems)Marshal.GetObjectForIUnknown(enumPtr);
            Marshal.Release(enumPtr);
            try
            {
                for (int i = 0; i < 2000; i++)
                {
                    if (items.Next(1, out var item, out uint fetched) != 0 || fetched == 0) break;
                    try
                    {
                        string name = ItemName(item, 0 /* SIGDN_NORMALDISPLAY */);
                        string id = ItemName(item, unchecked((int)0x80018001) /* SIGDN_PARSINGRELATIVETOPARENT */);
                        if (id.Contains('!') && name.Length > 0 && !Skipped(name, null))
                            result.Add(new InstalledApp(name, InstalledApp.KindPackaged, null, null, null, id, "packaged"));
                    }
                    finally { Marshal.ReleaseComObject(item); }
                }
            }
            finally { Marshal.ReleaseComObject(items); }
        }
        finally { Marshal.ReleaseComObject(folder); }
        return result;
    }

    private static string ItemName(IShellItem item, int sigdn)
    {
        item.GetDisplayName(sigdn, out var p);
        try { return Marshal.PtrToStringUni(p) ?? ""; } finally { Marshal.FreeCoTaskMem(p); }
    }

    /// <summary>Windows' own tools, resolved from the Windows folders only.</summary>
    private static IEnumerable<InstalledApp> SystemTools()
    {
        string sys = Environment.SystemDirectory, win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var tools = new (string Name, string Path)[]
        {
            ("Command Prompt", System.IO.Path.Combine(sys, "cmd.exe")),
            ("Windows PowerShell", System.IO.Path.Combine(sys, @"WindowsPowerShell\v1.0\powershell.exe")),
            ("Task Manager", System.IO.Path.Combine(sys, "Taskmgr.exe")),
            ("Control Panel", System.IO.Path.Combine(sys, "control.exe")),
            ("File Explorer", System.IO.Path.Combine(win, "explorer.exe")),
            ("Registry Editor", System.IO.Path.Combine(win, "regedit.exe")),
            ("Device Manager", System.IO.Path.Combine(sys, "mmc.exe")),
        };
        foreach (var (name, p) in tools)
        {
            if (!File.Exists(p)) continue;
            // Device Manager is mmc.exe with its console file: the arguments are fixed here, never supplied by the agent.
            string? args = name == "Device Manager" ? "devmgmt.msc" : null;
            yield return new InstalledApp(name, InstalledApp.KindExe, p, args, System.IO.Path.GetDirectoryName(p), null, "windows");
        }
    }

    // ── COM interop (shell32) ──

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class CShellLink { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(int sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("70629033-e363-4a28-a567-0db78006e6d7")]
    private interface IEnumShellItems
    {
        [PreserveSig] int Next(uint celt, out IShellItem rgelt, out uint pceltFetched);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);
}
