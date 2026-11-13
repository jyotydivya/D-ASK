//! The HUD's path to the local agent: frontend -> this bridge -> daemon pipe -> agent host.
//!
//! The frontend can only send an objective or a task id. There is deliberately no way to name a tool, a
//! grant or an approval, and session ownership comes from the daemon's side of the pipe. Everything that
//! can be refused locally is refused here, so a task is never queued for a daemon that may come back later.

use crate::ipc::protocol::IpcEnvelope;
use serde::{Deserialize, Serialize};

/// Same limit as the daemon and the host, so the user gets the reason immediately.
pub const MAX_OBJECTIVE_CHARS: usize = 4000;

pub const SUBMIT_REQUEST: &str = "AgentTaskSubmitRequest";
pub const CANCEL_REQUEST: &str = "AgentTaskCancelRequest";
pub const SUBMIT_RESPONSE: &str = "AgentTaskSubmitResponse";
pub const CANCEL_RESPONSE: &str = "AgentTaskCancelResponse";
/// Recovery after a HUD restart: the FINISHED result of a task the frontend recorded the id of.
pub const STATUS_REQUEST: &str = "AgentTaskStatusRequest";
pub const STATUS_RESPONSE: &str = "AgentTaskStatusResponse";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentSubmitPayload {
    pub request_id: String,
    pub objective: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentCancelPayload {
    pub request_id: String,
    pub task_id: String,
}

/// Only a task id: the daemon answers with a FINISHED result (or "not found"); nothing can be started or changed this way.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentStatusPayload {
    pub request_id: String,
    pub task_id: String,
}

/// A daemon message on its way to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFrontendMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub reply_to_id: Option<String>,
    pub payload: serde_json::Value,
}

/// The only daemon messages the frontend receives through this path.
pub fn is_forwarded_type(msg_type: &str) -> bool {
    matches!(
        msg_type,
        SUBMIT_RESPONSE | CANCEL_RESPONSE | STATUS_RESPONSE | "AgentTaskProgressNotification" | "AgentTaskResultNotification"
    )
}

/// `request_id` becomes the pipe envelope id, so the daemon's reply can be matched to the frontend request.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn submit_rejection(request_id: &str, code: &str, message: &str) -> AgentFrontendMessage {
    AgentFrontendMessage {
        msg_type: SUBMIT_RESPONSE.to_string(),
        reply_to_id: Some(request_id.to_string()),
        payload: serde_json::json!({ "accepted": false, "taskId": null, "rejectionCode": code, "errorMessage": message }),
    }
}

/// The acceptance voice gate (crate::voice_gate) refused this submission before the daemon; the page shows it as a rejection.
pub fn gate_rejection(request_id: &str, why: &str) -> AgentFrontendMessage {
    submit_rejection(request_id, "voice_gate_blocked", &format!("Acceptance voice gate: not submitted ({why})."))
}

fn cancel_rejection(request_id: &str, task_id: &str, code: &str) -> AgentFrontendMessage {
    AgentFrontendMessage {
        msg_type: CANCEL_RESPONSE.to_string(),
        reply_to_id: Some(request_id.to_string()),
        payload: serde_json::json!({ "taskId": task_id, "cancelling": false, "rejectionCode": code }),
    }
}

const NOT_CONNECTED: &str = "The D-ASK daemon is not connected. Nothing was sent.";

pub fn build_submit(
    p: &AgentSubmitPayload,
    connected: bool,
    emergency_stopped: bool,
) -> Result<IpcEnvelope, AgentFrontendMessage> {
    if !valid_id(&p.request_id) {
        return Err(submit_rejection("", "invalid_request", "Invalid request id."));
    }
    let chars = p.objective.chars().count();
    if p.objective.trim().is_empty() || chars > MAX_OBJECTIVE_CHARS {
        return Err(submit_rejection(
            &p.request_id,
            "invalid_request",
            &format!("The request must be 1 to {MAX_OBJECTIVE_CHARS} characters."),
        ));
    }
    // A local stop holds even if the daemon has not heard about it yet.
    if emergency_stopped {
        return Err(submit_rejection(&p.request_id, "emergency_stopped", "Emergency Stop is active; new tasks are refused."));
    }
    if !connected {
        return Err(submit_rejection(&p.request_id, "daemon_unavailable", NOT_CONNECTED));
    }
    make_envelope(SUBMIT_REQUEST, &serde_json::json!({ "objective": p.objective }), &p.request_id)
        .map_err(|_| submit_rejection(&p.request_id, "invalid_request", "The request could not be encoded."))
}

/// A stop does not block cancelling: cancel only ever reduces what is running.
pub fn build_cancel(p: &AgentCancelPayload, connected: bool) -> Result<IpcEnvelope, AgentFrontendMessage> {
    if !valid_id(&p.request_id) {
        return Err(cancel_rejection("", &p.task_id, "invalid_request"));
    }
    if !valid_id(&p.task_id) {
        return Err(cancel_rejection(&p.request_id, "", "invalid_request"));
    }
    if !connected {
        return Err(cancel_rejection(&p.request_id, &p.task_id, "host_unavailable"));
    }
    make_envelope(CANCEL_REQUEST, &serde_json::json!({ "taskId": p.task_id }), &p.request_id)
        .map_err(|_| cancel_rejection(&p.request_id, &p.task_id, "invalid_request"))
}

/// A status (recovery) request: read-only; valid ids only; no daemon, no request.
pub fn build_status(p: &AgentStatusPayload, connected: bool) -> Result<IpcEnvelope, AgentFrontendMessage> {
    let not_found = |code: &str| AgentFrontendMessage {
        msg_type: STATUS_RESPONSE.to_string(),
        reply_to_id: Some(p.request_id.clone()),
        payload: serde_json::json!({ "found": false, "taskId": p.task_id, "rejectionCode": code }),
    };
    if !valid_id(&p.request_id) || !valid_id(&p.task_id) {
        return Err(not_found("invalid_request"));
    }
    if !connected {
        return Err(not_found("daemon_unavailable"));
    }
    make_envelope(STATUS_REQUEST, &serde_json::json!({ "taskId": p.task_id }), &p.request_id).map_err(|_| not_found("invalid_request"))
}

/// The reply when the outgoing queue would not take a request that already passed the checks above.
pub fn queue_rejection(envelope: &IpcEnvelope) -> Option<AgentFrontendMessage> {
    stale_rejection(envelope)
}

fn make_envelope(msg_type: &str, payload: &serde_json::Value, request_id: &str) -> Result<IpcEnvelope, serde_json::Error> {
    let mut envelope = IpcEnvelope::new(msg_type, payload, None)?;
    envelope.id = request_id.to_string();
    Ok(envelope)
}

/// What the pipe writer does with an agent request created before the current session was established:
/// the frontend already considers it sent, and the daemon session it was meant for is gone. It must fail
/// instead of starting a task on a later session, possibly long after the user asked.
pub fn stale_rejection(envelope: &IpcEnvelope) -> Option<AgentFrontendMessage> {
    match envelope.msg_type.as_str() {
        SUBMIT_REQUEST => Some(submit_rejection(
            &envelope.id,
            "daemon_unavailable",
            "The connection to the D-ASK daemon was lost before the request was sent. It was not sent and will not be retried.",
        )),
        CANCEL_REQUEST => {
            let task_id = envelope.payload.get("taskId").and_then(|v| v.as_str()).unwrap_or_default();
            Some(cancel_rejection(&envelope.id, task_id, "host_unavailable"))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WebBridgeMessage;

    fn submit(id: &str, objective: &str) -> AgentSubmitPayload {
        AgentSubmitPayload { request_id: id.into(), objective: objective.into() }
    }

    fn code(m: &AgentFrontendMessage) -> &str {
        m.payload["rejectionCode"].as_str().unwrap()
    }

    #[test]
    fn status_request_carries_only_a_valid_task_id_and_is_refused_offline() {
        let p = AgentStatusPayload { request_id: "s1".into(), task_id: "t0123abc".into() };
        let env = build_status(&p, true).unwrap();
        assert_eq!(env.msg_type, STATUS_REQUEST);
        assert_eq!(env.payload, serde_json::json!({ "taskId": "t0123abc" }));
        assert!(build_status(&p, false).is_err());
        assert!(build_status(&AgentStatusPayload { request_id: "s1".into(), task_id: "../x".into() }, true).is_err());
        let extra = r#"{"type":"AgentTaskStatus","payload":{"request_id":"r1","task_id":"t1","objective":"x"}}"#;
        assert!(serde_json::from_str::<WebBridgeMessage>(extra).is_err());
        assert!(is_forwarded_type(STATUS_RESPONSE));
    }

    #[test]
    fn valid_submit_carries_only_the_objective_and_correlates_on_the_request_id() {
        let env = build_submit(&submit("req-1", "What is 2+2?"), true, false).unwrap();
        assert_eq!(env.msg_type, SUBMIT_REQUEST);
        assert_eq!(env.id, "req-1");
        assert_eq!(env.payload, serde_json::json!({ "objective": "What is 2+2?" }));
    }

    #[test]
    fn frontend_cannot_add_tools_grants_approvals_or_a_session_to_a_submit() {
        for extra in ["tools", "grants", "approved", "sessionId", "taskId"] {
            let raw = format!(r#"{{"type":"AgentTaskSubmit","payload":{{"request_id":"r1","objective":"x","{extra}":"y"}}}}"#);
            assert!(serde_json::from_str::<WebBridgeMessage>(&raw).is_err(), "field {extra} must be rejected");
        }
        let ok = r#"{"type":"AgentTaskSubmit","payload":{"request_id":"r1","objective":"x"}}"#;
        assert!(matches!(serde_json::from_str::<WebBridgeMessage>(ok), Ok(WebBridgeMessage::AgentTaskSubmit(_))));
    }

    #[test]
    fn frontend_cannot_add_fields_to_a_cancel() {
        let bad = r#"{"type":"AgentTaskCancel","payload":{"request_id":"r1","task_id":"t1","sessionId":"other"}}"#;
        assert!(serde_json::from_str::<WebBridgeMessage>(bad).is_err());
        let ok = r#"{"type":"AgentTaskCancel","payload":{"request_id":"r1","task_id":"t1"}}"#;
        assert!(matches!(serde_json::from_str::<WebBridgeMessage>(ok), Ok(WebBridgeMessage::AgentTaskCancel(_))));
    }

    #[test]
    fn objective_limits_are_counted_in_characters() {
        assert!(build_submit(&submit("r", &"é".repeat(MAX_OBJECTIVE_CHARS)), true, false).is_ok());
        let over = build_submit(&submit("r", &"a".repeat(MAX_OBJECTIVE_CHARS + 1)), true, false).unwrap_err();
        assert_eq!(code(&over), "invalid_request");
        assert_eq!(code(&build_submit(&submit("r", "   \n"), true, false).unwrap_err()), "invalid_request");
    }

    #[test]
    fn request_ids_cannot_carry_arbitrary_text() {
        for bad in ["", "has space", "quote\"", &"x".repeat(65)] {
            assert!(build_submit(&submit(bad, "x"), true, false).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn emergency_stop_refuses_locally_even_when_disconnected() {
        let r = build_submit(&submit("r", "x"), false, true).unwrap_err();
        assert_eq!(code(&r), "emergency_stopped");
        assert_eq!(r.reply_to_id.as_deref(), Some("r"));
    }

    #[test]
    fn nothing_is_queued_while_disconnected() {
        assert_eq!(code(&build_submit(&submit("r", "x"), false, false).unwrap_err()), "daemon_unavailable");
        let c = AgentCancelPayload { request_id: "r".into(), task_id: "t1".into() };
        assert_eq!(code(&build_cancel(&c, false).unwrap_err()), "host_unavailable");
    }

    #[test]
    fn cancel_still_works_during_an_emergency_stop_and_validates_ids() {
        let c = AgentCancelPayload { request_id: "r".into(), task_id: "t1".into() };
        let env = build_cancel(&c, true).unwrap();
        assert_eq!(env.msg_type, CANCEL_REQUEST);
        assert_eq!(env.payload, serde_json::json!({ "taskId": "t1" }));
        let bad = AgentCancelPayload { request_id: "r".into(), task_id: "t 1".into() };
        assert_eq!(code(&build_cancel(&bad, true).unwrap_err()), "invalid_request");
    }

    #[test]
    fn stale_requests_fail_with_a_reply_and_other_traffic_is_untouched() {
        let s = build_submit(&submit("r9", "x"), true, false).unwrap();
        let rejected = stale_rejection(&s).unwrap();
        assert_eq!(rejected.msg_type, SUBMIT_RESPONSE);
        assert_eq!(rejected.reply_to_id.as_deref(), Some("r9"));
        assert_eq!(code(&rejected), "daemon_unavailable");

        let c = build_cancel(&AgentCancelPayload { request_id: "r8".into(), task_id: "t1".into() }, true).unwrap();
        let rejected = stale_rejection(&c).unwrap();
        assert_eq!(rejected.msg_type, CANCEL_RESPONSE);
        assert_eq!(rejected.payload["taskId"], "t1");

        let other = IpcEnvelope::new("HeartbeatPing", &serde_json::json!({}), None).unwrap();
        assert!(stale_rejection(&other).is_none());
    }

    #[test]
    fn only_agent_task_messages_are_forwarded() {
        for t in [SUBMIT_RESPONSE, CANCEL_RESPONSE, "AgentTaskProgressNotification", "AgentTaskResultNotification"] {
            assert!(is_forwarded_type(t), "{t}");
        }
        for t in ["ActionApprovalRequest", "AgentHostHealthResponse", "HandshakeResponse", ""] {
            assert!(!is_forwarded_type(t), "{t}");
        }
    }
}
