using System.Text.Json;

namespace DAsk.Daemon.Research;

/// <summary>
/// Builds <see cref="SafetyAuditRecord.DetailsJson"/> with a serializer (Phase 7B.1a, F5). Text that comes from a caller,
/// a window or a process (action types, process names, titles, reasons) can never change the JSON structure, and every
/// string is bounded with an explicit truncation marker. Never put typed text, window contents or secrets in details.
/// </summary>
public static class AuditJson
{
    public const int MaxFieldChars = 256;
    public const int MaxDetailsChars = 8 * 1024;

    private static readonly JsonSerializerOptions Options = new() { WriteIndented = false };

    /// <summary>Truncates to <paramref name="max"/> characters, marking how much was removed. Never splits a surrogate pair.</summary>
    public static string? Bound(string? value, int max = MaxFieldChars)
    {
        if (value is null || value.Length <= max) return value;
        int cut = max;
        if (char.IsHighSurrogate(value[cut - 1])) cut--;
        return value[..cut] + $"…[truncated {value.Length - cut} chars]";
    }

    /// <summary>Serialises a details object (an anonymous type or record of primitives and bounded strings).</summary>
    public static string Details(object details)
    {
        string json = JsonSerializer.Serialize(details, Options);
        if (json.Length > MaxDetailsChars)
            throw new ArgumentException($"Audit details exceed {MaxDetailsChars} characters; bound the fields first.");
        return json;
    }
}
