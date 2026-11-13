using System.Text.Json;
using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages;

// Named-pipe messages between a verified, handshaken client (the HUD) and the daemon for the local
// agent. Requests carry only an objective or a task id: there is no field for tools, grants or
// approvals. Session ownership comes from the transport, never from a payload.

public record AgentTaskSubmitRequest
{
    [JsonPropertyName("objective")]
    public string Objective { get; init; } = string.Empty;
}

public record AgentTaskSubmitResponse
{
    [JsonPropertyName("accepted")]
    public bool Accepted { get; init; }

    [JsonPropertyName("taskId")]
    public string? TaskId { get; init; }

    /// <summary>agent_host_disabled, host_unavailable, emergency_stopped, busy, invalid_request, daemon_model_busy.</summary>
    [JsonPropertyName("rejectionCode")]
    public string? RejectionCode { get; init; }

    [JsonPropertyName("errorMessage")]
    public string? ErrorMessage { get; init; }
}

public record AgentTaskStatusRequest
{
    [JsonPropertyName("taskId")]
    public string TaskId { get; init; } = string.Empty;
}

public record AgentTaskStatusResponse
{
    [JsonPropertyName("found")]
    public bool Found { get; init; }

    [JsonPropertyName("taskId")]
    public string TaskId { get; init; } = string.Empty;

    /// <summary>running, cancelling, finished.</summary>
    [JsonPropertyName("state")]
    public string? State { get; init; }

    [JsonPropertyName("result")]
    public AgentTaskResultNotification? Result { get; init; }
}

public record AgentTaskCancelRequest
{
    [JsonPropertyName("taskId")]
    public string TaskId { get; init; } = string.Empty;
}

public record AgentTaskCancelResponse
{
    [JsonPropertyName("taskId")]
    public string TaskId { get; init; } = string.Empty;

    [JsonPropertyName("cancelling")]
    public bool Cancelling { get; init; }

    /// <summary>unknown_task, already_finished, host_unavailable.</summary>
    [JsonPropertyName("rejectionCode")]
    public string? RejectionCode { get; init; }
}

public record AgentHostHealthRequest;

public record AgentHostHealthResponse
{
    [JsonPropertyName("enabled")]
    public bool Enabled { get; init; }

    /// <summary>stopped, starting, ready, restarting, failed.</summary>
    [JsonPropertyName("state")]
    public string State { get; init; } = "stopped";

    [JsonPropertyName("pid")]
    public int? Pid { get; init; }

    [JsonPropertyName("restarts")]
    public int Restarts { get; init; }

    [JsonPropertyName("activeTaskId")]
    public string? ActiveTaskId { get; init; }

    [JsonPropertyName("emergencyStopped")]
    public bool EmergencyStopped { get; init; }

    [JsonPropertyName("lastError")]
    public string? LastError { get; init; }

    /// <summary>The local model's state as last reported by the host.</summary>
    [JsonPropertyName("modelState")]
    public string? ModelState { get; init; }

    [JsonPropertyName("modelId")]
    public string? ModelId { get; init; }
}

public record AgentTaskProgressNotification
{
    [JsonPropertyName("taskId")]
    public string TaskId { get; init; } = string.Empty;

    [JsonPropertyName("seq")]
    public long Seq { get; init; }

    [JsonPropertyName("data")]
    public JsonElement Data { get; init; }
}

public record AgentTaskResultNotification
{
    [JsonPropertyName("taskId")]
    public string TaskId { get; init; } = string.Empty;

    /// <summary>The runtime's actual outcome: completed, unverified, partial, failed, refused or cancelled.</summary>
    [JsonPropertyName("outcome")]
    public string Outcome { get; init; } = "failed";

    [JsonPropertyName("response")]
    public string Response { get; init; } = string.Empty;

    /// <summary>
    /// True when the host died or was killed while this task ran. Such a task is never re-run; tools it
    /// had already started may have taken effect, so the caller must not assume nothing happened.
    /// </summary>
    [JsonPropertyName("interrupted")]
    public bool Interrupted { get; init; }

    [JsonPropertyName("errorCode")]
    public string? ErrorCode { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }

    [JsonPropertyName("steps")]
    public JsonElement? Steps { get; init; }

    [JsonPropertyName("verification")]
    public JsonElement? Verification { get; init; }

    [JsonPropertyName("toolCalls")]
    public int ToolCalls { get; init; }

    [JsonPropertyName("iterations")]
    public int Iterations { get; init; }
}
