using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages;

/// <summary>
/// Canonical 12 Assistant and Orb states agreed between .NET Daemon and Rust HUD.
/// </summary>
public static class AssistantState
{
    public const string Idle = "Idle";
    public const string Listening = "Listening";
    public const string Processing = "Processing";
    public const string Speaking = "Speaking";
    public const string ModelLoading = "ModelLoading";
    public const string ModelGenerating = "ModelGenerating";
    public const string Warning = "Warning";
    public const string Critical = "Critical";
    public const string Disconnected = "Disconnected";
    public const string Reconnecting = "Reconnecting";
    public const string TaskCompleted = "TaskCompleted";
    public const string TaskFailed = "TaskFailed";

    public static readonly IReadOnlyList<string> All = new[]
    {
        Idle,
        Listening,
        Processing,
        Speaking,
        ModelLoading,
        ModelGenerating,
        Warning,
        Critical,
        Disconnected,
        Reconnecting,
        TaskCompleted,
        TaskFailed
    };
}

public record TaskStateDto
{
    [JsonPropertyName("taskId")]
    public string TaskId { get; init; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; init; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; init; } = "Pending"; // Pending, InProgress, Completed, Paused

    [JsonPropertyName("createdAt")]
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
}

public record StateRestoreRequest
{
    [JsonPropertyName("lastKnownSeq")]
    public long LastKnownSeq { get; init; }

    [JsonPropertyName("clientStateTimestamp")]
    public DateTimeOffset ClientStateTimestamp { get; init; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("clientStatus")]
    public string ClientStatus { get; init; } = "Reconnecting";
}

public record StateRestoreResponse
{
    [JsonPropertyName("activeStatus")]
    public string ActiveStatus { get; init; } = "Idle";

    [JsonPropertyName("orbMode")]
    public string OrbMode { get; init; } = "Normal";

    [JsonPropertyName("activeTasks")]
    public List<TaskStateDto> ActiveTasks { get; init; } = [];

    [JsonPropertyName("sequenceNumber")]
    public long SequenceNumber { get; init; }

    [JsonPropertyName("restoredSuccessfully")]
    public bool RestoredSuccessfully { get; init; } = true;
}

public record StateUpdate
{
    [JsonPropertyName("activeStatus")]
    public string ActiveStatus { get; init; } = "Idle";

    [JsonPropertyName("orbMode")]
    public string OrbMode { get; init; } = "Normal";

    [JsonPropertyName("taskId")]
    public string? TaskId { get; init; }

    [JsonPropertyName("taskSummary")]
    public string? TaskSummary { get; init; }

    [JsonPropertyName("sequenceNumber")]
    public long SequenceNumber { get; init; }
}

