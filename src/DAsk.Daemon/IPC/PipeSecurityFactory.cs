using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;

namespace DAsk.Daemon.IPC;

/// <summary>
/// Phase 4B-1R.8 (H3): the pipe's security descriptor. Only the current user may open it, and any
/// token carrying the NETWORK SID (remote SMB access, even by the same user) is explicitly denied.
/// There is deliberately no Everyone, Anonymous, Authenticated Users, SYSTEM or Administrators ACE.
/// Any failure here is fatal to startup: there is no weaker fallback.
/// </summary>
public static class PipeSecurityFactory
{
    public static PipeSecurity CreateForCurrentUser()
    {
        SecurityIdentifier me = WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("Cannot determine the current user SID for the pipe ACL.");

        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(me, PipeAccessRights.FullControl, AccessControlType.Allow));
        return security;
    }
}
