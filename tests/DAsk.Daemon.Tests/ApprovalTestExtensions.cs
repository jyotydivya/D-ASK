using DAsk.Daemon.Automation.Policy;
using DAsk.Protocol.IPC.Messages.ComputerUse;

namespace DAsk.Daemon.Tests;

/// <summary>
/// Phase 7B.1a: a correct HUD echoes the action digest the daemon put in the approval request. Tests that model a
/// correct HUD use this; tests of tampering deliberately do not.
/// </summary>
internal static class ApprovalTestExtensions
{
    public static ActionApprovalResponse WithDigest(this ActionApprovalResponse response, ActionPolicyEngine policy) =>
        policy.TryGetPendingRequest(response.ApprovalId, out var pending)
            ? response with { ActionDigest = pending.ActionDigest }
            : response;
}
