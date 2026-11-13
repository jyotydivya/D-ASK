namespace DAsk.Protocol.IPC;

public static class IpcConstants
{
    public const string PipeName = "d-ask-ipc-v1";
    public const string FullPipePath = @"\\.\pipe\" + PipeName;
    public const uint CurrentProtocolVersion = 1;
    public const int MaxMessageSizeBytes = 1024 * 1024; // 1 MB limit to prevent buffer-exhaustion
    public const int HeaderSizeBytes = 4; // 4-byte uint32 little-endian length prefix
}

