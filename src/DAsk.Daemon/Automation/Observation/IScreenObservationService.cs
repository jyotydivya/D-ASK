using DAsk.Protocol.IPC.Messages.ComputerUse;

namespace DAsk.Daemon.Automation.Observation;

public interface IScreenObservationService
{
    IReadOnlyList<DisplayInfo> EnumerateDisplays();
    ActiveWindowMetadata? GetActiveWindow();
    Task<CaptureObservationResponse> CaptureAsync(
        CaptureObservationRequest request,
        uint? clientProcessId = null,
        string? sessionId = null,
        CancellationToken cancellationToken = default);

    int ReleaseSessionBuffers(string sessionId);
}

