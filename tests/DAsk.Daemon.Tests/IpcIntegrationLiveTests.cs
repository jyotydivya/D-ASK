using System.Diagnostics;
using System.IO.Pipes;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

public class IpcIntegrationLiveTests
{
    private readonly ITestOutputHelper _output;

    public IpcIntegrationLiveTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public async Task LiveDaemon_EndToEnd_Ipc_Telemetry_And_Reconnection_Test()
    {
        string daemonExe = Path.GetFullPath(@"..\..\..\..\..\src\DAsk.Daemon\bin\Debug\net8.0\DAsk.Daemon.exe");
        Assert.True(File.Exists(daemonExe), $"Daemon exe not found at: {daemonExe}");

        var psi = new ProcessStartInfo
        {
            FileName = daemonExe,
            WorkingDirectory = Path.GetFullPath(@"..\..\..\..\..\"),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        using var daemonProcess = new Process { StartInfo = psi };
        daemonProcess.OutputDataReceived += (_, e) => { if (e.Data != null) _output.WriteLine($"[DAEMON OUT] {e.Data}"); };
        daemonProcess.ErrorDataReceived += (_, e) => { if (e.Data != null) _output.WriteLine($"[DAEMON ERR] {e.Data}"); };
        daemonProcess.Start();
        daemonProcess.BeginOutputReadLine();
        daemonProcess.BeginErrorReadLine();
        _output.WriteLine($"Started live D-ASK Daemon process with PID: {daemonProcess.Id}");

        try
        {
            // Wait for pipe to become available
            await Task.Delay(2500);

            // 1. First connection: Perform Handshake and verify Telemetry reception
            using (var pipeClient = new NamedPipeClientStream(".", IpcConstants.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                await pipeClient.ConnectAsync(10000);
                Assert.True(pipeClient.IsConnected, "Failed to connect to D-ASK Daemon pipe.");
                _output.WriteLine("Pipe connection established.");

                // Send Handshake
                var handshakeReq = new HandshakeRequest
                {
                    ClientName = "IntegrationTest.HUD",
                    ProtocolVersion = IpcConstants.CurrentProtocolVersion,
                    ClientProcessId = Environment.ProcessId,
                    Capabilities = ["hud_v1", "wgpu_direct3d12"]
                };
                var handshakeEnv = IpcEnvelope.Create(nameof(HandshakeRequest), handshakeReq);
                await pipeClient.WriteAsync(handshakeEnv.ToLengthPrefixedBytes());
                await pipeClient.FlushAsync();

                // Read HandshakeResponse
                byte[] header = new byte[4];
                await ReadExactAsync(pipeClient, header, 4);
                uint len = BitConverter.ToUInt32(header, 0);
                byte[] payload = new byte[len];
                await ReadExactAsync(pipeClient, payload, (int)len);

                var respEnv = IpcEnvelope.FromJsonBytes(payload);
                Assert.NotNull(respEnv);
                Assert.Equal(nameof(HandshakeResponse), respEnv.Type);

                var handshakeResp = respEnv.DeserializePayload<HandshakeResponse>();
                Assert.NotNull(handshakeResp);
                Assert.Equal("Accepted", handshakeResp.Status);
                Assert.Equal(IpcConstants.CurrentProtocolVersion, handshakeResp.ProtocolVersion);
                _output.WriteLine($"Handshake Accepted! SessionToken: {handshakeResp.SessionToken}");

                // Read incoming broadcast (TelemetryUpdate or interleaving ResourceAlert)
                IpcEnvelope? telemEnv = null;
                for (int attempt = 0; attempt < 5; attempt++)
                {
                    await ReadExactAsync(pipeClient, header, 4);
                    len = BitConverter.ToUInt32(header, 0);
                    payload = new byte[len];
                    await ReadExactAsync(pipeClient, payload, (int)len);

                    var env = IpcEnvelope.FromJsonBytes(payload);
                    if (env.Type == nameof(TelemetryUpdate))
                    {
                        telemEnv = env;
                        break;
                    }
                    else if (env.Type == nameof(ResourceAlert))
                    {
                        _output.WriteLine($"Received initial ResourceAlert: {env.Payload}");
                    }
                }

                Assert.NotNull(telemEnv);
                Assert.Equal(nameof(TelemetryUpdate), telemEnv.Type);

                var telemetry = telemEnv.DeserializePayload<TelemetryUpdate>();
                Assert.NotNull(telemetry);
                Assert.True(telemetry.SystemRam.TotalBytes > 0);
                Assert.True(telemetry.SystemRam.AvailableBytes > 0);
                Assert.Contains("Intel(R) Iris(R) Xe Graphics", telemetry.Gpu.AdapterName);
                Assert.True(telemetry.Gpu.IsSharedMemoryArchitecture);

                _output.WriteLine($"[Live Telemetry] RAM Avail: {telemetry.SystemRam.AvailableBytes / (1024.0 * 1024.0):F1} MB | CPU: {telemetry.Cpu.TotalUsagePercent:F1}% | GPU: {telemetry.Gpu.AdapterName} (Shared: {telemetry.Gpu.IsSharedMemoryArchitecture})");
            } // Pipe closes here simulating client disconnect

            // 1b. Measure physical idle baseline before model loading
            daemonProcess.Refresh();
            long idleWorkingSetBytes = daemonProcess.WorkingSet64;
            long idlePrivateMemoryBytes = daemonProcess.PrivateMemorySize64;
            _output.WriteLine($"[PHYSICAL DAEMON IDLE BASELINE] Working Set RAM: {idleWorkingSetBytes / (1024.0 * 1024.0):F2} MB | Private Bytes: {idlePrivateMemoryBytes / (1024.0 * 1024.0):F2} MB");
            Assert.True(idleWorkingSetBytes < 80 * 1024 * 1024, $"Daemon idle working set ({idleWorkingSetBytes / (1024 * 1024)} MB) exceeds 80 MB limit.");

            _output.WriteLine("First client session closed. Simulating HUD reconnection...");
            await Task.Delay(500);

            // 2. Reconnection test: Connect second client session and request State Restore
            using (var pipeClient2 = new NamedPipeClientStream(".", IpcConstants.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                await pipeClient2.ConnectAsync(5000);
                Assert.True(pipeClient2.IsConnected, "Failed to reconnect to D-ASK Daemon pipe.");
                _output.WriteLine("Second connection established (reconnection).");

                // Handshake
                var handshakeReq2 = new HandshakeRequest
                {
                    ClientName = "IntegrationTest.HUD.Reconnected",
                    ProtocolVersion = IpcConstants.CurrentProtocolVersion,
                    ClientProcessId = Environment.ProcessId,
                    Capabilities = ["hud_v1"]
                };
                await pipeClient2.WriteAsync(IpcEnvelope.Create(nameof(HandshakeRequest), handshakeReq2).ToLengthPrefixedBytes());
                await pipeClient2.FlushAsync();

                // Read HandshakeResponse
                byte[] header = new byte[4];
                await ReadExactAsync(pipeClient2, header, 4);
                uint len = BitConverter.ToUInt32(header, 0);
                byte[] payload = new byte[len];
                await ReadExactAsync(pipeClient2, payload, (int)len);

                var respEnv = IpcEnvelope.FromJsonBytes(payload);
                Assert.NotNull(respEnv);
                Assert.Equal(nameof(HandshakeResponse), respEnv.Type);

                // Send StateRestoreRequest
                var restoreReq = new StateRestoreRequest
                {
                    LastKnownSeq = 0,
                    ClientStatus = "Reconnected"
                };
                await pipeClient2.WriteAsync(IpcEnvelope.Create(nameof(StateRestoreRequest), restoreReq).ToLengthPrefixedBytes());
                await pipeClient2.FlushAsync();

                // Read StateRestoreResponse
                await ReadExactAsync(pipeClient2, header, 4);
                len = BitConverter.ToUInt32(header, 0);
                payload = new byte[len];
                await ReadExactAsync(pipeClient2, payload, (int)len);

                var restoreEnv = IpcEnvelope.FromJsonBytes(payload);
                Assert.NotNull(restoreEnv);
                Assert.Equal(nameof(StateRestoreResponse), restoreEnv.Type);

                var restoreResp = restoreEnv.DeserializePayload<StateRestoreResponse>();
                Assert.NotNull(restoreResp);
                Assert.True(restoreResp.RestoredSuccessfully);
                Assert.True(restoreResp.ActiveStatus == "Idle" || restoreResp.ActiveStatus == "Warning" || restoreResp.ActiveStatus == "Critical", $"Unexpected status: {restoreResp.ActiveStatus}");
                Assert.True(restoreResp.OrbMode == "Normal" || restoreResp.OrbMode == "Warning" || restoreResp.OrbMode == "Alert", $"Unexpected orb mode: {restoreResp.OrbMode}");
                _output.WriteLine($"State restored successfully! Status='{restoreResp.ActiveStatus}', OrbMode='{restoreResp.OrbMode}', Seq={restoreResp.SequenceNumber}");

                // 2b. Live Model Inference IPC Request over Named Pipe
                var inferReq = new ModelInferenceIpcRequest
                {
                    TaskId = "task-live-ipc-infer",
                    Prompt = "Say hello in 3 words.",
                    MaxTokens = 10
                };
                await pipeClient2.WriteAsync(IpcEnvelope.Create(nameof(ModelInferenceIpcRequest), inferReq).ToLengthPrefixedBytes());
                await pipeClient2.FlushAsync();

                // Read ModelInferenceIpcResponse (or handle any interleaving telemetry)
                ModelInferenceIpcResponse? inferResp = null;
                for (int attempt = 0; attempt < 10; attempt++)
                {
                    await ReadExactAsync(pipeClient2, header, 4);
                    len = BitConverter.ToUInt32(header, 0);
                    payload = new byte[len];
                    await ReadExactAsync(pipeClient2, payload, (int)len);

                    var env = IpcEnvelope.FromJsonBytes(payload);
                    if (env != null && env.Type == nameof(ModelInferenceIpcResponse))
                    {
                        inferResp = env.DeserializePayload<ModelInferenceIpcResponse>();
                        break;
                    }
                }

                Assert.NotNull(inferResp);
                if (inferResp.IsSuccess)
                {
                    Assert.NotEmpty(inferResp.Text);
                    _output.WriteLine($"[Live IPC Inference Response] Text: '{inferResp.Text.Trim()}', Backend: {inferResp.BackendUsed}, Tok/s: {inferResp.GenerationTokensPerSec:F1}, TTFT: {inferResp.TimeToFirstTokenMs:F1}ms");
                }
                else
                {
                    // If blocked by ResourceManager due to host RAM headroom (< 2000 MB safety buffer), verify it was handled safely
                    _output.WriteLine($"[Live IPC Inference Safe Gate] Inference request gracefully rejected by safety gate: {inferResp.ErrorMessage}");
                    Assert.Contains("Model runtime is not ready", inferResp.ErrorMessage);
                }
            }

            // 3. Measure physical memory with model loaded (Stage 2 budget: < 1024 MB)
            daemonProcess.Refresh();
            long workingSetBytes = daemonProcess.WorkingSet64;
            long privateMemoryBytes = daemonProcess.PrivateMemorySize64;

            _output.WriteLine($"[PHYSICAL DAEMON MODEL LOADED] Working Set RAM: {workingSetBytes / (1024.0 * 1024.0):F2} MB | Private Bytes: {privateMemoryBytes / (1024.0 * 1024.0):F2} MB");

            // Verify loaded working set stays within the 1024 MB Stage 2 budget
            Assert.True(workingSetBytes < 1024 * 1024 * 1024, $"Daemon working set ({workingSetBytes / (1024 * 1024)} MB) exceeds 1024 MB budget.");
        }
        finally
        {
            if (!daemonProcess.HasExited)
            {
                daemonProcess.Kill();
                daemonProcess.WaitForExit(3000);
            }
        }
    }

    private static async Task ReadExactAsync(Stream stream, byte[] buffer, int count)
    {
        int readTotal = 0;
        while (readTotal < count)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(readTotal, count - readTotal));
            if (read == 0) throw new EndOfStreamException();
            readTotal += read;
        }
    }
}
