using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace DAsk.Daemon.Automation.Policy;

/// <summary>A value that DASK-CJ-1 cannot represent exactly. Callers must treat it as a refusal, never encode around it.</summary>
public sealed class CanonicalEncodingException : Exception
{
    public CanonicalEncodingException(string message) : base(message) { }
}

/// <summary>
/// DASK-CJ-1: the canonical byte form used for approval hashing (Phase 7B.1a). Deterministic and injective: two JSON
/// values that differ in any name, type, value or nesting encode to different bytes, and parsing the output gives back
/// the input. Rules:
/// <list type="bullet">
/// <item>Types: object, array, string, integer, true, false, null. Fractions, exponents and integers outside
/// ±(2^53 − 1) are refused, so a number has exactly one spelling. Strings and numbers never compare equal
/// (<c>"1"</c> and <c>1</c> are different bytes).</item>
/// <item>Objects: members sorted by name in ordinal UTF-16 code-unit order; duplicate names refused; a missing member
/// and a member whose value is <c>null</c> are different.</item>
/// <item>Strings: UTF-8; <c>"</c> and <c>\</c> escaped; <c>\b \f \n \r \t</c> in short form; other U+0000–U+001F as
/// <c>\u00xx</c> (lowercase hex); everything else literal. Unpaired surrogates refused.</item>
/// <item>No insignificant whitespace.</item>
/// <item>Bounds: depth 16, 256 members per object or array, 8,192 UTF-16 units per string, 64 KiB of output.</item>
/// </list>
/// A digest is <c>SHA-256(UTF8(domain) ‖ 0x00 ‖ canonical bytes)</c>, lowercase hex. The domain separates parameter
/// hashes from action digests, so one can never be presented as the other.
/// </summary>
public static class CanonicalJson
{
    public const int MaxDepth = 16;
    public const int MaxMembers = 256;
    public const int MaxStringChars = 8192;
    public const int MaxOutputBytes = 64 * 1024;
    public const long MaxSafeInteger = 9_007_199_254_740_991;

    public const string ParametersDomain = "DASK-PARAMS-V1";
    public const string ActionDomain = "DASK-ACTION-V1";

    public static string EncodeToString(JsonElement value)
    {
        var sb = new StringBuilder();
        Write(value, sb, 0);
        Bound(sb);
        return sb.ToString();
    }

    public static byte[] Encode(JsonElement value) => Encoding.UTF8.GetBytes(EncodeToString(value));

    /// <summary>A flat string map, e.g. approval parameters. A null value is encoded as JSON null, distinct from "".</summary>
    public static string EncodeStringMap(IReadOnlyDictionary<string, string?>? map)
    {
        var sb = new StringBuilder("{");
        if (map != null)
        {
            if (map.Count > MaxMembers) throw new CanonicalEncodingException($"more than {MaxMembers} members");
            bool first = true;
            foreach (var key in map.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                if (!first) sb.Append(',');
                first = false;
                WriteString(key, sb);
                sb.Append(':');
                var v = map[key];
                if (v is null) sb.Append("null"); else WriteString(v, sb);
            }
        }
        sb.Append('}');
        Bound(sb);
        return sb.ToString();
    }

    public static string Digest(string domain, string canonical) => Digest(domain, Encoding.UTF8.GetBytes(canonical));

    public static string Digest(string domain, byte[] canonical)
    {
        byte[] tag = Encoding.UTF8.GetBytes(domain);
        byte[] buf = new byte[tag.Length + 1 + canonical.Length];
        tag.CopyTo(buf, 0);
        buf[tag.Length] = 0;
        canonical.CopyTo(buf, tag.Length + 1);
        return Convert.ToHexString(SHA256.HashData(buf)).ToLowerInvariant();
    }

    private static void Bound(StringBuilder sb)
    {
        // A UTF-16 unit becomes at most 3 UTF-8 bytes; check exactly only when it could matter.
        if (sb.Length * 3 > MaxOutputBytes && Encoding.UTF8.GetByteCount(sb.ToString()) > MaxOutputBytes)
            throw new CanonicalEncodingException($"canonical form exceeds {MaxOutputBytes} bytes");
    }

    private static void Write(JsonElement e, StringBuilder sb, int depth)
    {
        if (depth > MaxDepth) throw new CanonicalEncodingException($"nesting deeper than {MaxDepth}");
        switch (e.ValueKind)
        {
            case JsonValueKind.Object:
            {
                var members = new List<(string Name, JsonElement Value)>();
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var p in e.EnumerateObject())
                {
                    if (members.Count >= MaxMembers) throw new CanonicalEncodingException($"more than {MaxMembers} members");
                    if (!seen.Add(p.Name)) throw new CanonicalEncodingException($"duplicate member name '{Short(p.Name)}'");
                    members.Add((p.Name, p.Value));
                }
                members.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
                sb.Append('{');
                for (int i = 0; i < members.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    WriteString(members[i].Name, sb);
                    sb.Append(':');
                    Write(members[i].Value, sb, depth + 1);
                }
                sb.Append('}');
                break;
            }
            case JsonValueKind.Array:
            {
                sb.Append('[');
                int n = 0;
                foreach (var item in e.EnumerateArray())
                {
                    if (n >= MaxMembers) throw new CanonicalEncodingException($"more than {MaxMembers} array items");
                    if (n++ > 0) sb.Append(',');
                    Write(item, sb, depth + 1);
                }
                sb.Append(']');
                break;
            }
            case JsonValueKind.String:
            {
                string s;
                try { s = e.GetString()!; }
                catch (InvalidOperationException) { throw new CanonicalEncodingException("string is not valid UTF-16"); }
                WriteString(s, sb);
                break;
            }
            case JsonValueKind.Number:
            {
                if (!e.TryGetInt64(out long v)) throw new CanonicalEncodingException($"unsupported number '{Short(e.GetRawText())}' (integers only)");
                if (v > MaxSafeInteger || v < -MaxSafeInteger) throw new CanonicalEncodingException("integer outside ±(2^53 − 1)");
                sb.Append(v.ToString(CultureInfo.InvariantCulture));
                break;
            }
            case JsonValueKind.True: sb.Append("true"); break;
            case JsonValueKind.False: sb.Append("false"); break;
            case JsonValueKind.Null: sb.Append("null"); break;
            default: throw new CanonicalEncodingException($"unsupported value kind {e.ValueKind}");
        }
    }

    private static void WriteString(string s, StringBuilder sb)
    {
        if (s.Length > MaxStringChars) throw new CanonicalEncodingException($"string longer than {MaxStringChars} characters");
        sb.Append('"');
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1])) throw new CanonicalEncodingException("unpaired surrogate");
                sb.Append(c).Append(s[++i]);
                continue;
            }
            if (char.IsLowSurrogate(c)) throw new CanonicalEncodingException("unpaired surrogate");
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    private static string Short(string s) => s.Length <= 40 ? s : s[..40] + "…";
}
