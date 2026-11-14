using DAsk.Daemon.AgentHost;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Execution;
using DAsk.Daemon.Automation.Policy;

namespace DAsk.Daemon.Automation;

/// <summary>The 2026-11-14 services (Windows administration, the user's Chrome, code edits), each switched on by its own option.</summary>
public static class ExtraServices
{
    public static IEnumerable<IDesktopActionRequestService> Create(IServiceProvider sp, AgentHostOptions o, Func<string, ApprovalGate> gate, ActionExecutionEngine engine)
    {
        var loggers = (Microsoft.Extensions.Logging.ILoggerFactory)sp.GetService(typeof(Microsoft.Extensions.Logging.ILoggerFactory))!;
        if (o.SystemAdmin)
            yield return new SystemAdmin.SystemAdminService(gate("SystemAdmin"), new SystemAdmin.SystemAdminOptions { Enabled = true, ControllableServices = o.SystemAdminServices },
                loggers.CreateLogger("SystemAdmin"));
        if (o.DevEditRoots.Length > 0)
            yield return new Dev.DevEditService(gate("DevEdit"), new Dev.DevEditOptions { Roots = o.DevEditRoots }, loggers.CreateLogger("DevEdit"));
        if (o.ChromeControl)
        {
            string hostExe = Path.GetFullPath(string.IsNullOrWhiteSpace(o.ChromeHostPath)
                ? Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "DAsk.ChromeHost", "bin", "Release", "net8.0", "dask-chrome-host.exe") : o.ChromeHostPath!, AppContext.BaseDirectory);
            var chromeExe = new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) }
                .Select(d => Path.Combine(d, "Google", "Chrome", "Application", "chrome.exe")).Where(File.Exists).ToArray();
            var broker = new Chrome.ChromeBroker(new Chrome.ChromeBrokerOptions { HostExePath = hostExe, ExtensionId = o.ChromeExtensionId, ChromeExePaths = chromeExe, PipeName = o.ChromeBrokerPipe },
                loggers.CreateLogger("ChromeBroker"));
            broker.Start();
            yield return new Chrome.ChromeService(gate("Chrome"), broker,
                new Chrome.ChromeOptions { Enabled = true, ChromeExePath = chromeExe.FirstOrDefault(), WebSearchAllowed = o.WebSearch }, loggers.CreateLogger("Chrome"));
        }
    }
}
