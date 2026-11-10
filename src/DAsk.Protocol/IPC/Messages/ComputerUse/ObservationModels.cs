using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages.ComputerUse;

public record DisplayInfo
{
    [JsonPropertyName("index")]
    public int Index { get; init; }

    [JsonPropertyName("deviceName")]
    public string DeviceName { get; init; } = string.Empty;

    [JsonPropertyName("x")]
    public int X { get; init; }

    [JsonPropertyName("y")]
    public int Y { get; init; }

    [JsonPropertyName("width")]
    public int Width { get; init; }

    [JsonPropertyName("height")]
    public int Height { get; init; }

    [JsonPropertyName("isPrimary")]
    public bool IsPrimary { get; init; }

    [JsonPropertyName("dpiScale")]
    public double DpiScale { get; init; } = 1.0;

    [JsonPropertyName("dpiX")]
    public uint DpiX { get; init; } = 96;

    [JsonPropertyName("dpiY")]
    public uint DpiY { get; init; } = 96;
}

public record ActiveWindowMetadata
{
    [JsonPropertyName("hwnd")]
    public long Hwnd { get; init; }

    [JsonPropertyName("title")]
    public string Title { get; init; } = string.Empty;

    [JsonPropertyName("processName")]
    public string ProcessName { get; init; } = string.Empty;

    [JsonPropertyName("processId")]
    public int ProcessId { get; init; }

    [JsonPropertyName("className")]
    public string ClassName { get; init; } = string.Empty;

    [JsonPropertyName("x")]
    public int X { get; init; }

    [JsonPropertyName("y")]
    public int Y { get; init; }

    [JsonPropertyName("width")]
    public int Width { get; init; }

    [JsonPropertyName("height")]
    public int Height { get; init; }

    [JsonPropertyName("isMinimized")]
    public bool IsMinimized { get; init; }

    [JsonPropertyName("isMaximized")]
    public bool IsMaximized { get; init; }

    [JsonPropertyName("dpiScale")]
    public double DpiScale { get; init; } = 1.0;

    [JsonPropertyName("logicalX")]
    public int LogicalX { get; init; }

    [JsonPropertyName("logicalY")]
    public int LogicalY { get; init; }

    [JsonPropertyName("logicalWidth")]
    public int LogicalWidth { get; init; }

    [JsonPropertyName("logicalHeight")]
    public int LogicalHeight { get; init; }

    [JsonPropertyName("clientX")]
    public int ClientX { get; init; }

    [JsonPropertyName("clientY")]
    public int ClientY { get; init; }

    [JsonPropertyName("clientWidth")]
    public int ClientWidth { get; init; }

    [JsonPropertyName("clientHeight")]
    public int ClientHeight { get; init; }
}

public record UiElementInfo
{
    [JsonPropertyName("stableId")]
    public string StableId { get; init; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; init; } = string.Empty;

    [JsonPropertyName("controlType")]
    public string ControlType { get; init; } = string.Empty;

    [JsonPropertyName("className")]
    public string ClassName { get; init; } = string.Empty;

    [JsonPropertyName("x")]
    public int X { get; init; }

    [JsonPropertyName("y")]
    public int Y { get; init; }

    [JsonPropertyName("width")]
    public int Width { get; init; }

    [JsonPropertyName("height")]
    public int Height { get; init; }

    [JsonPropertyName("isEnabled")]
    public bool IsEnabled { get; init; } = true;

    [JsonPropertyName("isKeyboardFocusable")]
    public bool IsKeyboardFocusable { get; init; }

    [JsonPropertyName("value")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Value { get; init; }
}

public record CaptureObservationRequest
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("targetDisplayIndex")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? TargetDisplayIndex { get; init; }

    [JsonPropertyName("targetHwnd")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? TargetHwnd { get; init; }

    [JsonPropertyName("includeUiAutomation")]
    public bool IncludeUiAutomation { get; init; } = true;

    [JsonPropertyName("uiaTimeoutMs")]
    public int UiaTimeoutMs { get; init; } = 300;

    [JsonPropertyName("generatePreviewThumbnail")]
    public bool GeneratePreviewThumbnail { get; init; } = false;

    [JsonPropertyName("previewMaxWidth")]
    public int PreviewMaxWidth { get; init; } = 320;

    [JsonPropertyName("previewMaxHeight")]
    public int PreviewMaxHeight { get; init; } = 180;

    [JsonPropertyName("preferredFormat")]
    public string PreferredFormat { get; init; } = "raw_bgra32";

    [JsonPropertyName("purpose")]
    public string Purpose { get; init; } = "ComputerUse"; // ComputerUse, Diagnostic
}

public record CaptureObservationResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("observationId")]
    public string ObservationId { get; init; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("status")]
    public string Status { get; init; } = "Captured"; // Captured, PartialUiaTimeout, Failed

    [JsonPropertyName("displayIndex")]
    public int DisplayIndex { get; init; }

    [JsonPropertyName("physicalWidth")]
    public int PhysicalWidth { get; init; }

    [JsonPropertyName("physicalHeight")]
    public int PhysicalHeight { get; init; }

    [JsonPropertyName("dpiScale")]
    public double DpiScale { get; init; } = 1.0;

    [JsonPropertyName("sharedMemoryName")]
    public string SharedMemoryName { get; init; } = string.Empty;

    [JsonPropertyName("targetHandle")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? TargetHandle { get; init; }

    [JsonPropertyName("dataSizeBytes")]
    public int DataSizeBytes { get; init; }

    [JsonPropertyName("format")]
    public string Format { get; init; } = "raw_bgra32";

    [JsonPropertyName("activeWindow")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ActiveWindowMetadata? ActiveWindow { get; init; }

    [JsonPropertyName("uiElements")]
    public IReadOnlyList<UiElementInfo> UiElements { get; init; } = Array.Empty<UiElementInfo>();

    [JsonPropertyName("allDisplays")]
    public IReadOnlyList<DisplayInfo> AllDisplays { get; init; } = Array.Empty<DisplayInfo>();

    [JsonPropertyName("captureDurationMs")]
    public double CaptureDurationMs { get; init; }

    [JsonPropertyName("uiaDurationMs")]
    public double UiaDurationMs { get; init; }

    [JsonPropertyName("previewThumbnailBase64")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PreviewThumbnailBase64 { get; init; }

    [JsonPropertyName("errorMessage")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorMessage { get; init; }

    [JsonPropertyName("rejectionCode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RejectionCode { get; init; }

    // ── Phase 7B.1b: freshness and per-source status (the screenshot and UIA are read one after the other) ──

    [JsonPropertyName("capturedAtUtc")]
    public DateTimeOffset CapturedAtUtc { get; init; }

    /// <summary>ok or failed. "ok" means the capture API succeeded; it does not validate the pixels.</summary>
    [JsonPropertyName("captureStatus")]
    public string CaptureStatus { get; init; } = "ok";

    [JsonPropertyName("uiaStatus")]
    public string UiaStatus { get; init; } = "Skipped";

    [JsonPropertyName("uiaInspectedAtUtc")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? UiaInspectedAtUtc { get; init; }

    /// <summary>After this the observation is stale and must not be used.</summary>
    [JsonPropertyName("expiresAtUtc")]
    public DateTimeOffset ExpiresAtUtc { get; init; }

    /// <summary>Always false: the screenshot and the UI Automation read are not one atomic snapshot.</summary>
    [JsonPropertyName("isAtomic")]
    public bool IsAtomic { get; init; }
}

