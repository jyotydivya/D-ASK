use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const CURRENT_PROTOCOL_VERSION: u32 = 1;
pub const MAX_MESSAGE_SIZE_BYTES: usize = 1024 * 1024;
pub const PIPE_NAME: &str = r"\\.\pipe\d-ask-ipc-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcEnvelope {
    pub version: u32,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_id: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub timestamp: DateTime<Utc>,
    pub payload: serde_json::Value,
}

impl IpcEnvelope {
    pub fn new<T: Serialize>(msg_type: &str, payload: &T, reply_to_id: Option<String>) -> Result<Self, serde_json::Error> {
        Ok(Self {
            version: CURRENT_PROTOCOL_VERSION,
            id: Uuid::new_v4().simple().to_string(),
            reply_to_id,
            msg_type: msg_type.to_string(),
            timestamp: Utc::now(),
            payload: serde_json::to_value(payload)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeRequest {
    pub client_name: String,
    pub protocol_version: u32,
    pub client_process_id: u32,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub is_emergency_stopped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub stop_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeResponse {
    pub status: String,
    pub protocol_version: u32,
    pub daemon_process_id: u32,
    pub session_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub is_emergency_stopped: bool,
    #[serde(default = "default_stop_generation")]
    pub stop_generation: u64,
}

fn default_stop_generation() -> u64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemRamMetrics {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub load_percentage: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuMetrics {
    pub total_usage_percent: f64,
    pub process_usage_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuMetrics {
    pub adapter_name: String,
    pub dedicated_video_memory_bytes: u64,
    pub shared_system_memory_bytes: u64,
    pub current_usage_bytes: u64,
    pub budget_bytes: u64,
    pub is_shared_memory_architecture: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemoryMetrics {
    pub working_set_bytes: i64,
    pub private_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryUpdate {
    pub system_ram: SystemRamMetrics,
    pub cpu: CpuMetrics,
    pub gpu: GpuMetrics,
    pub process_memory: ProcessMemoryMetrics,
    pub resource_status: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceAlert {
    pub severity: String,
    pub reason: String,
    pub available_memory_bytes: u64,
    pub threshold_bytes: u64,
    pub action_taken: String,
    pub is_blocked_from_model_load: bool,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStateDto {
    pub task_id: String,
    pub title: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateRestoreRequest {
    pub last_known_seq: i64,
    pub client_state_timestamp: DateTime<Utc>,
    pub client_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateRestoreResponse {
    pub active_status: String,
    pub orb_mode: String,
    pub active_tasks: Vec<TaskStateDto>,
    pub sequence_number: i64,
    pub restored_successfully: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateUpdate {
    pub active_status: String,
    pub orb_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_summary: Option<String>,
    pub sequence_number: i64,
}

/// Phase 7B.1a liveness proof. Before ping `n` the HUD posts probe `n` to its UI event loop and its panic-hotkey
/// message loop; ping `n+1` carries the last probe each loop acknowledged. The daemon renews the HUD's lease only
/// when both cover the previous ping, so a hung loop stops renewing it even while this IPC task keeps running.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPing {
    pub sequence: i64,
    pub timestamp: DateTime<Utc>,
    #[serde(default)]
    pub event_loop_ack: i64,
    #[serde(default)]
    pub hotkey_ack: i64,
    #[serde(default)]
    pub hotkey_registered: bool,
}

impl HeartbeatPing {
    /// A ping without liveness proof (it can never renew the lease). Used by transport tests.
    pub fn bare(sequence: i64, timestamp: DateTime<Utc>) -> Self {
        Self { sequence, timestamp, event_loop_ack: 0, hotkey_ack: 0, hotkey_registered: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPong {
    pub sequence: i64,
    pub ping_timestamp: DateTime<Utc>,
    pub pong_timestamp: DateTime<Utc>,
    #[serde(default)]
    pub lease_renewed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Daemon to owning HUD: an approval changed state, or a decision was refused (`decision_accepted == Some(false)`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalStateNotification {
    pub approval_id: String,
    pub action_id: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_accepted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub timestamp: DateTime<Utc>,
}

impl ApprovalStateNotification {
    pub fn is_terminal(&self) -> bool {
        self.state != "Pending"
    }
}

/// The daemon's explicit answer to a message it does not handle (nothing is dropped silently).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRejectedNotification {
    pub rejected_type: String,
    pub code: String,
    pub message: String,
    pub timestamp: DateTime<Utc>,
}

// ==========================================
// Phase 4A Computer-Use Observation Models
// ==========================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub index: i32,
    pub device_name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub is_primary: bool,
    pub dpi_scale: f64,
    pub dpi_x: u32,
    pub dpi_y: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindowMetadata {
    pub hwnd: i64,
    pub title: String,
    pub process_name: String,
    pub process_id: i32,
    pub class_name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub is_minimized: bool,
    pub is_maximized: bool,
    pub dpi_scale: f64,
    #[serde(default)]
    pub logical_x: i32,
    #[serde(default)]
    pub logical_y: i32,
    #[serde(default)]
    pub logical_width: i32,
    #[serde(default)]
    pub logical_height: i32,
    #[serde(default)]
    pub client_x: i32,
    #[serde(default)]
    pub client_y: i32,
    #[serde(default)]
    pub client_width: i32,
    #[serde(default)]
    pub client_height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiElementInfo {
    pub stable_id: String,
    pub name: String,
    pub control_type: String,
    pub class_name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub is_enabled: bool,
    pub is_keyboard_focusable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureObservationRequest {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_display_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_hwnd: Option<i64>,
    pub include_ui_automation: bool,
    pub uia_timeout_ms: i32,
    pub generate_preview_thumbnail: bool,
    pub preview_max_width: i32,
    pub preview_max_height: i32,
    pub preferred_format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureObservationResponse {
    pub request_id: String,
    pub observation_id: String,
    pub timestamp: DateTime<Utc>,
    pub success: bool,
    pub status: String,
    pub display_index: i32,
    pub physical_width: i32,
    pub physical_height: i32,
    pub dpi_scale: f64,
    pub shared_memory_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_handle: Option<i64>,
    pub data_size_bytes: i32,
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_window: Option<ActiveWindowMetadata>,
    pub ui_elements: Vec<UiElementInfo>,
    pub all_displays: Vec<DisplayInfo>,
    pub capture_duration_ms: f64,
    pub uia_duration_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_thumbnail_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionApprovalRequest {
    pub approval_id: String,
    pub action_id: String,
    pub action_type: String,
    pub parameters_sha256: String,
    pub action_parameters: std::collections::HashMap<String, String>,
    pub target_process_name: String,
    pub target_window_title: String,
    pub target_hwnd: i64,
    pub target_process_id: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_process_creation_time: Option<DateTime<Utc>>,
    pub session_id: String,
    pub stop_generation: u64,
    pub risk_level: String,
    pub created_at_utc: DateTime<Utc>,
    pub expires_at_utc: DateTime<Utc>,
    pub reason: String,
    /// Phase 7B.1a: daemon-computed digest of `canonical_action`; must be echoed in the decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_digest: Option<String>,
    /// Phase 7B.1a: the exact action being authorized (canonical JSON). The page renders the approval from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionApprovalResponse {
    pub approval_id: String,
    pub action_id: String,
    pub action_type: String,
    pub parameters_sha256: String,
    pub approved: bool,
    pub decision_source: String,
    pub decided_at_utc: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub stop_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyStopRequest {
    pub stop_id: String,
    pub source: String,
    pub reason: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyStopResponse {
    pub stop_id: String,
    pub success: bool,
    pub active_actions_cancelled: i32,
    pub queued_actions_cancelled: i32,
    pub stop_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeExecutionRequest {
    pub resume_id: String,
    pub source: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub stop_generation: u64,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeExecutionResponse {
    pub resume_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub stop_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatedActionRequest {
    pub action_id: String,
    pub action_type: String,
    pub parameters: std::collections::HashMap<String, String>,
    pub target_process_name: String,
    pub target_window_title: String,
    pub target_hwnd: i64,
    pub target_process_id: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_process_creation_time: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub stop_generation: u64,
    pub simulated_duration_ms: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatedActionResponse {
    pub action_id: String,
    pub success: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub execution_duration_ms: f64,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionLifecycleNotification {
    pub action_id: String,
    pub action_type: String,
    pub previous_state: String,
    pub current_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanicHotkeyStatusNotification {
    pub is_available: bool,
    pub reason: String,
    pub error_code: i32,
    pub timestamp: DateTime<Utc>,
}




#[cfg(test)]
mod phase7b1a_tests {
    use super::*;

    #[test]
    fn heartbeat_ping_carries_the_liveness_proof_in_the_daemon_field_names() {
        let p = HeartbeatPing { sequence: 7, timestamp: Utc::now(), event_loop_ack: 6, hotkey_ack: 6, hotkey_registered: true };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["sequence"], 7);
        assert_eq!(v["eventLoopAck"], 6);
        assert_eq!(v["hotkeyAck"], 6);
        assert_eq!(v["hotkeyRegistered"], true);
        let bare = HeartbeatPing::bare(1, Utc::now());
        assert!(!bare.hotkey_registered, "a bare ping carries no proof and can never renew the lease");
    }

    #[test]
    fn approval_request_keeps_the_canonical_action_and_digest_for_the_page() {
        let json = serde_json::json!({
            "approvalId": "a1", "actionId": "x1", "actionType": "SimulatedType", "parametersSha256": "p",
            "actionParameters": { "text": "hi" }, "targetProcessName": "f.exe", "targetWindowTitle": "F",
            "targetHwnd": 1, "targetProcessId": 2, "sessionId": "s", "stopGeneration": 1, "riskLevel": "Elevated",
            "createdAtUtc": "2026-11-08T12:00:00Z", "expiresAtUtc": "2026-11-08T12:00:30Z", "reason": "r",
            "actionDigest": "d", "canonicalAction": "{\"x\":1}", "someFutureField": true
        });
        let r: ActionApprovalRequest = serde_json::from_value(json).unwrap();
        assert_eq!(r.action_digest.as_deref(), Some("d"));
        // The HUD re-serialises the struct for the page: the new fields must survive that.
        let again = serde_json::to_value(&r).unwrap();
        assert_eq!(again["canonicalAction"], "{\"x\":1}");
        assert_eq!(again["actionDigest"], "d");
    }

    #[test]
    fn approval_state_and_rejection_notifications_parse() {
        let n: ApprovalStateNotification = serde_json::from_value(serde_json::json!({
            "approvalId": "a1", "actionId": "x1", "state": "Expired", "decisionAccepted": false, "timestamp": "2026-11-08T12:00:00Z"
        })).unwrap();
        assert!(n.is_terminal());
        assert_eq!(n.decision_accepted, Some(false));
        let r: MessageRejectedNotification = serde_json::from_value(serde_json::json!({
            "rejectedType": "TaskApproval", "code": "obsolete_authorization_message", "message": "m", "timestamp": "2026-11-08T12:00:00Z"
        })).unwrap();
        assert_eq!(r.code, "obsolete_authorization_message");
    }

    #[test]
    fn decision_echoes_the_digest() {
        let d = ActionApprovalResponse {
            approval_id: "a".into(), action_id: "b".into(), action_type: "t".into(), parameters_sha256: "p".into(),
            approved: true, decision_source: "UserExplicitConfirmation".into(), decided_at_utc: Utc::now(),
            session_id: None, stop_generation: 0, rejection_reason: None, action_digest: Some("d".into()),
        };
        assert_eq!(serde_json::to_value(&d).unwrap()["actionDigest"], "d");
    }
}
