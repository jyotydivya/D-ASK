using System.Text.Json.Serialization;

namespace DAsk.Protocol.IPC.Messages;

public record ModelInferenceIpcRequest
{
    [JsonPropertyName("taskId")]
    public string TaskId { get; init; } = string.Empty;

    [JsonPropertyName("actionId")]
    public string? ActionId { get; init; }

    [JsonPropertyName("purpose")]
    public string Purpose { get; init; } = "GeneralConversation"; // GeneralConversation, ComputerUsePlanning, Diagnostic

    [JsonPropertyName("prompt")]
    public string Prompt { get; init; } = string.Empty;

    [JsonPropertyName("systemPrompt")]
    public string? SystemPrompt { get; init; }

    [JsonPropertyName("maxTokens")]
    public int MaxTokens { get; init; } = 128;

    [JsonPropertyName("temperature")]
    public float Temperature { get; init; } = 0.7f;

    [JsonPropertyName("topP")]
    public float TopP { get; init; } = 0.9f;

    [JsonPropertyName("enforceJsonStructure")]
    public bool EnforceJsonStructure { get; init; } = false;

    [JsonPropertyName("stopSequences")]
    public string[]? StopSequences { get; init; }
}

public record ModelInferenceIpcResponse
{
    [JsonPropertyName("taskId")]
    public string TaskId { get; init; } = string.Empty;

    [JsonPropertyName("text")]
    public string Text { get; init; } = string.Empty;

    [JsonPropertyName("backendUsed")]
    public string BackendUsed { get; init; } = string.Empty;

    [JsonPropertyName("timeToFirstTokenMs")]
    public double TimeToFirstTokenMs { get; init; }

    [JsonPropertyName("generationTokensPerSec")]
    public double GenerationTokensPerSec { get; init; }

    [JsonPropertyName("totalTokensGenerated")]
    public int TotalTokensGenerated { get; init; }

    [JsonPropertyName("isSuccess")]
    public bool IsSuccess { get; init; } = true;

    [JsonPropertyName("errorMessage")]
    public string? ErrorMessage { get; init; }

    [JsonPropertyName("rejectionCode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RejectionCode { get; init; }
}

public record TokenChunkIpcBroadcast
{
    [JsonPropertyName("taskId")]
    public string TaskId { get; init; } = string.Empty;

    [JsonPropertyName("tokenIndex")]
    public int TokenIndex { get; init; }

    [JsonPropertyName("text")]
    public string Text { get; init; } = string.Empty;

    [JsonPropertyName("isFinal")]
    public bool IsFinal { get; init; }
}

