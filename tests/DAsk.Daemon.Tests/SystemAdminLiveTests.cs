using System.Diagnostics;
using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Automation.SystemAdmin;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Win32;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>Runs only when DASK_LIVE_SYSTEM=1: it changes real (restored) system state on this computer.</summary>
public sealed class LiveSystemFactAttribute : FactAttribute
{
    public LiveSystemFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("DASK_LIVE_SYSTEM") != "1")
            Skip = "Real Windows administration test: set DASK_LIVE_SYSTEM=1 (toggles radios/volume/brightness and restores them; schedules and cancels a restart).";
    }
}

/// <summary>
/// Windows administration on the REAL OS (2026-11-14). The TEST plays the HUD (it approves programmatically; not a human-in-the-loop test).
/// Every changed setting is restored; restart/shutdown are scheduled 10 minutes ahead and aborted; sign-out/sleep use a test sink.
/// </summary>
[Collection("AgentHost")]
public class SystemAdminLiveTests
{
    private readonly ITestOutputHelper _out;
    public SystemAdminLiveTests(ITestOutputHelper o) => _out = o;

    private static int ShutdownAbort()
    {
        using var p = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "shutdown.exe"), "/a") { UseShellExecute = false, CreateNoWindow = true })!;
        p.WaitForExit();
        return p.ExitCode;
    }

    [LiveSystemFact]
    [Trait("Category", "SystemAdminLive")]
    public async Task Live_Processes_Services_Network_Audio_Display_Startup_Power()
    {
        string db = Path.Combine(Path.GetTempPath(), $"dask-system-live-{Guid.NewGuid():N}.db");
        const string startupName = "DASK-Test-Startup-Entry";
        Process? victim = null;
        try
        {
            var recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, db);
            await recorder.InitializeAsync();
            var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, recorder, new Win32WindowSource());
            policy.SetSessionLivenessGate(_ => true);
            bool approve = true;
            policy.ApprovalRequested += (_, r) => Task.Run(async () =>
            {
                await Task.Delay(100);
                policy.SubmitApprovalDecision(new ActionApprovalResponse
                {
                    ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                    ActionDigest = r.ActionDigest, Approved = approve, DecisionSource = "UserExplicitConfirmation",
                }, "live-session", () => false, () => 1);
            });
            bool stopped = false;
            var sink = new List<string>();
            var svc = new SystemAdminService(new ApprovalGate(policy, () => stopped, () => 1, recorder, _ => true, "SystemAdmin"),
                new SystemAdminOptions { Enabled = true, ControllableServices = new[] { "Fax" }, MinPowerDelaySeconds = 2, TestPowerSink = a => { lock (sink) sink.Add(a); } });
            var ctx = new DesktopActionContext("live-task", "c1", "live-session");
            async Task<DesktopCallResult> Do(string tool, object args)
            {
                var r = await svc.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), ctx, CancellationToken.None);
                string s = JsonSerializer.Serialize((object?)r.Result ?? r.Error);
                _out.WriteLine($"{tool} {JsonSerializer.Serialize(args)}: {r.Status} {(s.Length > 600 ? s[..600] + "…" : s)}");
                return r;
            }
            JsonElement Res(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);

            // ── processes ──
            var list = await Do(SystemAdminService.ListProcesses, new { });
            Assert.Equal("ok", list.Status);
            Assert.True(Res(list).GetProperty("count").GetInt32() > 20);
            victim = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "PING.EXE"), "-n 600 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true })!;
            await Task.Delay(500);
            var info = await Do(SystemAdminService.ProcessInfo, new { pid = victim.Id });
            Assert.Equal("ok", info.Status);
            var end = await Do(SystemAdminService.EndProcess, new { pid = victim.Id });
            Assert.Equal("ok", end.Status);
            Assert.True(victim.HasExited);                                               // independent check
            var csrss = Process.GetProcessesByName("csrss").First();
            Assert.Equal("target_forbidden", (await Do(SystemAdminService.EndProcess, new { pid = csrss.Id })).Error?.Code);
            Assert.Equal("target_forbidden", (await Do(SystemAdminService.EndProcess, new { pid = Process.GetProcessesByName("explorer").First().Id })).Error?.Code);
            // A declined approval ends nothing.
            victim = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "PING.EXE"), "-n 600 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true })!;
            approve = false;
            Assert.Equal("approval_denied", (await Do(SystemAdminService.EndProcess, new { pid = victim.Id })).Error?.Code);
            approve = true;
            Assert.False(victim.HasExited);

            // ── services ──
            var services = await Do(SystemAdminService.ListServices, new { });
            Assert.Equal("ok", services.Status);
            Assert.True(Res(services).GetProperty("count").GetInt32() > 50);
            Assert.Equal("ok", (await Do(SystemAdminService.ServiceInfo, new { name = "Spooler" })).Status);
            Assert.Equal("service_not_allowed", (await Do(SystemAdminService.ServiceControl, new { name = "Spooler", action = "stop" })).Error?.Code);
            var fax = await Do(SystemAdminService.ServiceInfo, new { name = "Fax" });
            if (fax.Status == "ok")
            {
                string faxBefore = Res(fax).GetProperty("service").GetProperty("status").GetString()!;
                var start = await Do(SystemAdminService.ServiceControl, new { name = "Fax", action = faxBefore == "Running" ? "stop" : "start" });
                // Either it really changed (elevated) or Windows refused for lack of administrator rights (UAC respected): both are verified outcomes.
                // On this machine Fax starts and exits again (no fax device) and stopping it needs administrator rights: whatever Windows does,
                // D-ASK's claim must match the state read back independently.
                Assert.True(start.Status == "ok" || start.Error?.Code is "access_denied" or "execution_unverified", start.Error?.Message);
                var faxNow = Res(await Do(SystemAdminService.ServiceInfo, new { name = "Fax" })).GetProperty("service").GetProperty("status").GetString();
                if (start.Status == "ok") { Assert.NotEqual(faxBefore, faxNow); await Do(SystemAdminService.ServiceControl, new { name = "Fax", action = faxBefore == "Running" ? "start" : "stop" }); }
                else Assert.Equal(faxBefore, faxNow);
            }

            // ── network and radios ──
            var net = await Do(SystemAdminService.NetworkStatus, new { });
            Assert.Equal("ok", net.Status);
            var radios = Res(net).GetProperty("radios");
            _out.WriteLine("radios: " + radios);
            foreach (var kind in new[] { "Bluetooth", "WiFi" })
            {
                var radio = radios.ValueKind == JsonValueKind.Array ? radios.EnumerateArray().FirstOrDefault(r => r.GetProperty("kind").GetString() == kind) : default;
                if (radio.ValueKind != JsonValueKind.Object) { _out.WriteLine($"no {kind} radio"); continue; }
                string before = radio.GetProperty("state").GetString()!;
                string flipped = before == "On" ? "off" : "on";
                var set = await Do(SystemAdminService.SetRadio, new { radio = kind.ToLowerInvariant(), state = flipped });
                var back = await Do(SystemAdminService.SetRadio, new { radio = kind.ToLowerInvariant(), state = before.ToLowerInvariant() });   // restore
                Assert.Equal("ok", set.Status);
                Assert.Equal("ok", back.Status);
                Assert.Equal(before, Res(back).GetProperty("state").GetString());
            }

            // ── audio ──
            var audio = await Do(SystemAdminService.AudioStatus, new { });
            Assert.Equal("ok", audio.Status);
            if (Res(audio).GetProperty("hasOutput").GetBoolean())
            {
                int v0 = Res(audio).GetProperty("volumePercent").GetInt32(); bool m0 = Res(audio).GetProperty("muted").GetBoolean();
                int target = v0 == 37 ? 41 : 37;
                var setv = await Do(SystemAdminService.SetVolume, new { percent = target });
                Assert.Equal("ok", setv.Status);
                Assert.Equal(target, CoreAudio.Read()!.Value.Percent);                    // independent read
                var mute = await Do(SystemAdminService.SetVolume, new { mute = !m0 });
                Assert.Equal("ok", mute.Status);
                Assert.Equal(!m0, CoreAudio.Read()!.Value.Muted);
                CoreAudio.Set(v0, m0);                                                     // restore
                Assert.Equal((v0, m0), (CoreAudio.Read()!.Value.Percent, CoreAudio.Read()!.Value.Muted));
            }

            // ── display ──
            var disp = await Do(SystemAdminService.DisplayStatus, new { });
            Assert.Equal("ok", disp.Status);
            Assert.True(Res(disp).GetProperty("displays").GetArrayLength() >= 1);
            if (Res(disp).GetProperty("brightnessSupported").GetBoolean())
            {
                int b0 = Res(disp).GetProperty("brightnessPercent").GetInt32();
                int bt = b0 >= 50 ? b0 - 10 : b0 + 10;
                var setb = await Do(SystemAdminService.SetBrightness, new { percent = bt });
                var restore = await Do(SystemAdminService.SetBrightness, new { percent = b0 });
                Assert.Equal("ok", setb.Status);
                Assert.Equal("ok", restore.Status);
            }

            // ── startup apps (a harmless test entry of our own, removed afterwards) ──
            using (var run = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                run.SetValue(startupName, Path.Combine(Environment.SystemDirectory, "notepad.exe"));
            var sl = await Do(SystemAdminService.StartupList, new { });
            Assert.Contains(startupName, JsonSerializer.Serialize(sl.Result));
            var off = await Do(SystemAdminService.StartupToggle, new { name = startupName, enabled = false });
            Assert.Equal("ok", off.Status);
            Assert.False(StartupApps.List().First(e => e.Name == startupName).Enabled);
            var on = await Do(SystemAdminService.StartupToggle, new { name = startupName, enabled = true });
            Assert.Equal("ok", on.Status);
            Assert.True(StartupApps.List().First(e => e.Name == startupName).Enabled);

            // ── power: restart and shutdown scheduled 10 minutes ahead, then cancelled ──
            foreach (var action in new[] { "restart", "shutdown" })
            {
                var sched = await Do(SystemAdminService.Power, new { action, delaySeconds = 600 });
                try
                {
                    Assert.Equal("ok", sched.Status);
                    _out.WriteLine($"{action} verified by event log: {Res(sched).GetProperty("verified").GetBoolean()}");
                    var cancel = await Do(SystemAdminService.CancelPower, new { });
                    Assert.Equal("ok", cancel.Status);
                    Assert.True(Res(cancel).GetProperty("verified").GetBoolean());
                }
                finally { ShutdownAbort(); }
                Assert.NotEqual(0, ShutdownAbort());   // independent: nothing is pending
            }
            // Emergency Stop cancels a scheduled restart.
            var sched2 = await Do(SystemAdminService.Power, new { action = "restart", delaySeconds = 600 });
            try
            {
                Assert.Equal("ok", sched2.Status);
                stopped = true;
                for (int i = 0; i < 30 && svc.PowerPending; i++) await Task.Delay(200);
                Assert.False(svc.PowerPending);
                await Task.Delay(500);
                Assert.NotEqual(0, ShutdownAbort());   // Windows has nothing pending: Emergency Stop aborted it
                Assert.Equal("emergency_stopped", (await Do(SystemAdminService.Power, new { action = "restart", delaySeconds = 600 })).Error?.Code);
            }
            finally { ShutdownAbort(); stopped = false; }
            // Sign-out and sleep (test sink: never really signs out): a cancelled one never fires; an uncancelled one fires once, on time.
            Assert.Equal("ok", (await Do(SystemAdminService.Power, new { action = "signout", delaySeconds = 3 })).Status);
            Assert.Equal("ok", (await Do(SystemAdminService.CancelPower, new { })).Status);
            await Task.Delay(4000);
            lock (sink) Assert.Empty(sink);
            Assert.Equal("ok", (await Do(SystemAdminService.Power, new { action = "sleep", delaySeconds = 2 })).Status);
            await Task.Delay(3500);
            lock (sink) Assert.Equal(new[] { "sleep" }, sink);
            Assert.Equal("invalid_args", (await Do(SystemAdminService.Power, new { action = "shutdown", delaySeconds = 1 })).Error?.Code);

            Assert.True((await recorder.VerifyAuditChainAsync()).Ok);
        }
        finally
        {
            ShutdownAbort();
            try { if (victim is { HasExited: false }) victim.Kill(); } catch { }
            using (var run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) run?.DeleteValue(startupName, false);
            using (var ap = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run", true)) ap?.DeleteValue(startupName, false);
            SqliteConnection.ClearAllPools(); try { File.Delete(db); } catch { }
        }
    }
}
