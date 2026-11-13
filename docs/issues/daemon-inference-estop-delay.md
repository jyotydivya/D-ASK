# Issue: Emergency Stop is delayed behind in-flight daemon inference on the HUD session

**Status:** open. Logged 2026-11-02; not fixed, by decision. The local-inference work does not touch the daemon.
**Severity:** medium. The delay is bounded, and the HUD's own local stop still acts immediately.
**Found during:** the read-only daemon-reuse inspection, before llama-server was chosen as the agent's model owner.

## What happens
1. The daemon processes each pipe session's messages one at a time. The read loop awaits each envelope before reading the next (`src/DAsk.Daemon/IPC/IpcClientSession.cs`, read loop around lines 84–137, `await HandleEnvelopeAsync(...)`).
2. The HUD uses a single pipe connection. Its priority channel only changes the order in which the HUD *sends* messages (`src/hud-native/src/ipc/client.rs`, ~line 313). It cannot interrupt a message the daemon is already handling.
3. A `ModelInferenceIpcRequest` holds the session until generation finishes (`GenerateAsync`; no cancel message, no streaming).
4. An `EmergencyStopRequest` sent on the same connection during that time is not read until the generation returns.

## Bound today
- `MaxTokens` defaults to 128, so the delay is a few seconds at most with the 0.5B model (estimate). A larger model or a higher `MaxTokens` lengthens it.
- The HUD's local stop path (hotkey and UI) still triggers immediately on the HUD side. Only the daemon's *processing* of the stop is delayed.

## Why it was not fixed here
- The agent runtime's inference now runs in a separate llama-server process (supervised by the agent host), not through this pipe. The new path cannot delay a daemon stop.
- Fixing this means changing the daemon's IPC concurrency model, which needs its own review.

## Options for a separate change
1. Handle `EmergencyStopRequest` and other priority messages on a dedicated reader that is not serialized behind long handlers.
2. Run inference requests off the session loop: spawn the handler and keep reading, with a per-session concurrency limit.
3. Add an `InferenceCancel` message and link Emergency Stop to the generation's cancellation token.
4. Give the HUD a second connection reserved for control messages.

## Acceptance for a fix
A test that starts a long daemon generation on a session, sends `EmergencyStopRequest` on that same session, and shows the daemon acts on it within a fixed bound (for example 250 ms) regardless of generation length.
