using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using Xunit;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 7B.3 blocker (Phase7B1bLiveTests full-suite timeout): deterministic replay of the envelope order captured in
/// results/phase7b3/blocker-diag/20261109T162413-d3c3/client-envelope-trace.txt, where an instantly refused task's
/// progress AND result notifications reached the client before that task's submit acknowledgement. The test client's
/// read loop used to discard them while waiting for the acknowledgement, then waited 180 s for a result it had dropped.
/// No daemon or live process is involved: the frames are replayed from memory through the test client's own reader.
/// </summary>
public class Phase7B1bClientOrderingTests
{
    private const string TaskId = "te2f9b4e4983c477e83760a6ba6ffe3d0";

    private static MemoryStream Frames(params IpcEnvelope[] envelopes)
    {
        var ms = new MemoryStream();
        foreach (var e in envelopes) ms.Write(e.ToLengthPrefixedBytes());
        ms.Position = 0;
        return ms;
    }

    // A default JsonElement cannot be serialized; real progress notifications always carry a data object.
    private static IpcEnvelope Progress(int seq) => IpcEnvelope.Create(nameof(AgentTaskProgressNotification),
        new AgentTaskProgressNotification { TaskId = TaskId, Seq = seq, Data = System.Text.Json.JsonSerializer.SerializeToElement(new { phase = "planning" }) });
    private static IpcEnvelope Result(string taskId = TaskId) => IpcEnvelope.Create(nameof(AgentTaskResultNotification), new AgentTaskResultNotification { TaskId = taskId, Outcome = "refused" });
    private static IpcEnvelope Ack(string requestId) => IpcEnvelope.Create(nameof(AgentTaskSubmitResponse), new AgentTaskSubmitResponse { Accepted = true, TaskId = TaskId }, requestId);

    private static Func<IpcEnvelope, bool> IsAck(string requestId) => e => e.ReplyToId == requestId;
    private static Func<IpcEnvelope, bool> IsResult(string taskId) => e => e.Type == nameof(AgentTaskResultNotification) &&
        e.DeserializePayload<AgentTaskResultNotification>()!.TaskId == taskId;

    [Fact]
    public async Task CapturedOrder_ResultBeforeAck_IsRecoveredFromTheBacklog()
    {
        const string req = "e02dbc21b4c94669815d36ed630f346a";
        using var s = Frames(Progress(1), Progress(2), Result(), Ack(req)); // the exact captured order
        var backlog = new List<IpcEnvelope>();
        var trace = new List<string>();

        var ack = await Phase7B1bLiveTests.ReadUntilAsync(s, IsAck(req), 1000, trace.Add, "ack", backlog);
        Assert.Equal(nameof(AgentTaskSubmitResponse), ack.Type);
        var result = await Phase7B1bLiveTests.ReadUntilAsync(s, IsResult(TaskId), 1000, trace.Add, "result", backlog);
        Assert.Equal("refused", result.DeserializePayload<AgentTaskResultNotification>()!.Outcome);
        Assert.Contains(trace, t => t.StartsWith("BACKLOG phase=result type=AgentTaskResultNotification"));
    }

    [Fact]
    public async Task CapturedOrder_WithoutTheBacklog_LosesTheResult_TheOriginalDefect()
    {
        const string req = "e02dbc21b4c94669815d36ed630f346a";
        using var s = Frames(Progress(1), Progress(2), Result(), Ack(req));
        await Phase7B1bLiveTests.ReadUntilAsync(s, IsAck(req), 1000); // the old call: no backlog
        // Nothing is left to read: the result was consumed and dropped while waiting for the acknowledgement.
        await Assert.ThrowsAnyAsync<Exception>(() => Phase7B1bLiveTests.ReadUntilAsync(s, IsResult(TaskId), 1000));
    }

    [Fact]
    public async Task UsualOrder_AckThenResult_StillWorks()
    {
        const string req = "r1";
        using var s = Frames(Ack(req), Progress(1), Result());
        var backlog = new List<IpcEnvelope>();
        await Phase7B1bLiveTests.ReadUntilAsync(s, IsAck(req), 1000, null, "ack", backlog);
        var result = await Phase7B1bLiveTests.ReadUntilAsync(s, IsResult(TaskId), 1000, null, "result", backlog);
        Assert.Equal(TaskId, result.DeserializePayload<AgentTaskResultNotification>()!.TaskId);
    }

    [Fact]
    public async Task Backlog_NeverReturnsAnotherTasksResult()
    {
        const string req = "r2";
        using var s = Frames(Result("t-other"), Ack(req));
        var backlog = new List<IpcEnvelope>();
        await Phase7B1bLiveTests.ReadUntilAsync(s, IsAck(req), 1000, null, "ack", backlog);
        Assert.Single(backlog); // kept, but it is not ours
        await Assert.ThrowsAnyAsync<Exception>(() => Phase7B1bLiveTests.ReadUntilAsync(s, IsResult(TaskId), 1000, null, "result", backlog));
        Assert.Single(backlog);
    }
}
