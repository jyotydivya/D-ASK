namespace DAsk.Daemon.Automation.Execution;

public enum ActionLifecycleState
{
    Created = 0,
    PendingApproval = 1,
    Approved = 2,
    Executing = 3,
    Completed = 4,
    Failed = 5,
    Cancelled = 6,
    Expired = 7,
    Blocked = 8
}

public static class ActionLifecycleValidator
{
    private static readonly HashSet<ActionLifecycleState> TerminalStates = new()
    {
        ActionLifecycleState.Completed,
        ActionLifecycleState.Failed,
        ActionLifecycleState.Cancelled,
        ActionLifecycleState.Expired,
        ActionLifecycleState.Blocked
    };

    public static bool IsTerminal(ActionLifecycleState state) => TerminalStates.Contains(state);

    public static bool IsValidTransition(ActionLifecycleState current, ActionLifecycleState target)
    {
        // Terminal states cannot transition to anything
        if (TerminalStates.Contains(current))
        {
            return false;
        }

        return (current, target) switch
        {
            // From Created:
            (ActionLifecycleState.Created, ActionLifecycleState.PendingApproval) => true,
            (ActionLifecycleState.Created, ActionLifecycleState.Approved) => true,
            (ActionLifecycleState.Created, ActionLifecycleState.Blocked) => true,
            (ActionLifecycleState.Created, ActionLifecycleState.Cancelled) => true,

            // From PendingApproval:
            (ActionLifecycleState.PendingApproval, ActionLifecycleState.Approved) => true,
            (ActionLifecycleState.PendingApproval, ActionLifecycleState.Cancelled) => true,
            (ActionLifecycleState.PendingApproval, ActionLifecycleState.Expired) => true,
            (ActionLifecycleState.PendingApproval, ActionLifecycleState.Blocked) => true,

            // From Approved:
            (ActionLifecycleState.Approved, ActionLifecycleState.Executing) => true,
            (ActionLifecycleState.Approved, ActionLifecycleState.Cancelled) => true,

            // From Executing:
            (ActionLifecycleState.Executing, ActionLifecycleState.Completed) => true,
            (ActionLifecycleState.Executing, ActionLifecycleState.Failed) => true,
            (ActionLifecycleState.Executing, ActionLifecycleState.Cancelled) => true,

            _ => false
        };
    }
}

