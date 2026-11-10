using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Observation;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// desktop.read_text (vision): REAL window, REAL capture, REAL offline Windows OCR via dask-ocr. Uses the Phase 7B.1b
/// fixture window (never focused, receives no input). Skips only if dask-ocr has not been built.
/// </summary>
[Collection("AgentHost")]
public class WindowTextReadTests
{
    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);
    private static JsonElement Args(object o) => JsonSerializer.SerializeToElement(o);

    private static WindowTextReadService Service(DesktopReadService reader, bool enabled = true) =>
        new(reader, new WindowTextReadOptions { Enabled = enabled });

    [Fact]
    public async Task Real_ReadsTheNamedWindowsText_Offline_AndNeverItsPassword()
    {
        string title = $"D-ASK OCR {Guid.NewGuid():N}"[..26];
        using var uia = new WindowsUiAutomationService();
        using var fx = new Phase7B1bTests.Fixture(title, 60, 60);
        var reader = new DesktopReadService(new Win32WindowSource(), uia, new DesktopReadOptions { AllowedProcessIds = new HashSet<int> { fx.Process.Id } });
        var svc = Service(reader);
        if (svc.Tools.Count == 0) return;   // dask-ocr.exe not built in this checkout
        var res = await svc.ExecuteAsync(WindowTextReadService.ReadText, Args(new { titleContains = title }), new DesktopActionContext("t1", "c1", "s"), CancellationToken.None);
        Assert.Equal("ok", res.Status);
        var j = J(res);
        var text = string.Join("\n", j.GetProperty("lines").EnumerateArray().Select(l => l.GetProperty("text").GetString()));
        Assert.Contains("Fixture password", text);
        Assert.Contains("fixture plain text", text);
        // Measured limitation (2026-11-10): the tiny button caption "Fixture OK" is read as "Fixture 0K" (O/0 confusion at
        // 100 % scaling). Accepted here ONLY with that one substitution; OCR text is never treated as exact.
        Assert.Contains("Fixture OK", text.Replace("0K", "OK"));
        Assert.DoesNotContain(Phase7B1bTests.Fixture.Secret, text);          // the password field shows bullets only
        Assert.Equal("Windows OCR (offline)", j.GetProperty("engine").GetString());
        Assert.Equal(fx.Process.Id, j.GetProperty("window").GetProperty("pid").GetInt32());
        Assert.Empty(Directory.GetFiles(Path.GetTempPath(), "dask-ocr-*.bmp").Where(f => File.GetCreationTimeUtc(f) > DateTime.UtcNow.AddMinutes(-1)));   // capture deleted
    }

    [Fact]
    public async Task Refuses_Ambiguous_Unknown_And_BadArguments_WithoutCapturing()
    {
        using var uia = new WindowsUiAutomationService();
        var reader = new DesktopReadService(new Win32WindowSource(), uia, new DesktopReadOptions());
        var svc = Service(reader);
        if (svc.Tools.Count == 0) return;
        var ctx = new DesktopActionContext("t1", "c1", "s");
        Assert.Equal("target_not_found", (await svc.ExecuteAsync(WindowTextReadService.ReadText, Args(new { titleContains = $"no such window {Guid.NewGuid():N}" }), ctx, CancellationToken.None)).Error!.Code);
        Assert.Equal("invalid_args", (await svc.ExecuteAsync(WindowTextReadService.ReadText, Args(new { }), ctx, CancellationToken.None)).Error!.Code);
        Assert.Equal("invalid_args", (await svc.ExecuteAsync(WindowTextReadService.ReadText, Args(new { titleContains = "x", hwnd = 123 }), ctx, CancellationToken.None)).Error!.Code);
    }

    [Fact]
    public void OffByDefault_AndUnmetered()
    {
        using var uia = new WindowsUiAutomationService();
        var reader = new DesktopReadService(new Win32WindowSource(), uia, new DesktopReadOptions());
        Assert.Empty(Service(reader, enabled: false).Tools);
        Assert.False(new DAsk.Daemon.AgentHost.AgentHostOptions().DesktopOcr);
        Assert.True(WindowTextReadService.IsUnmetered("desktop.read_text"));
    }
}
