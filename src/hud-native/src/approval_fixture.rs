//! Test-only approval-surface fixture (Phase 7B.1a). Compiled only with `--features approval-fixture`, into a separate
//! target directory, and active only when `DASK_HUD_APPROVAL_FIXTURE=1`. It never exists in the production HUD.
//!
//! In fixture mode the HUD does not connect to the daemon. Synthetic approval requests are read from the command file
//! named by `DASK_HUD_FIXTURE_CMD` (one command per line), so a test can exercise the real page, the real overlay
//! and real mouse input against a probe window, without any daemon, policy or execution path:
//!
//!   request <id> <ttl_ms>   show an approval (a simulated type action on "fixture.exe")
//!   cancel <id>             the "daemon" cancels it
//!
//! Decisions are logged as `[FIXTURE] decision approval_id=<id> approved=<bool>` and answered locally with the
//! matching terminal state. Nothing is authorized or executed.

use crate::ipc::protocol::{ActionApprovalRequest, ApprovalStateNotification};
use crate::HudAppEvent;
use std::collections::HashMap;
use tracing::{info, warn};
use winit::event_loop::EventLoopProxy;

pub fn enabled() -> bool {
    std::env::var("DASK_HUD_APPROVAL_FIXTURE").ok().as_deref() == Some("1")
}

fn request(id: &str, ttl_ms: i64) -> ActionApprovalRequest {
    let now = chrono::Utc::now();
    let expires = now + chrono::Duration::milliseconds(ttl_ms.clamp(1, 30_000));
    let mut params = HashMap::new();
    params.insert("text".to_string(), "fixture text to enter".to_string());
    params.insert("field".to_string(), "Fixture search box".to_string());
    let canonical = serde_json::json!({
        "schema": "dask.approval.action.v1",
        "approvalId": id, "actionId": format!("act_{id}"), "actionType": "SimulatedType",
        "parameters": { "field": "Fixture search box", "text": "fixture text to enter" },
        "parametersSha256": "fixture-params",
        "target": { "processName": "fixture.exe", "windowTitle": "D-ASK approval fixture", "hwnd": 4660, "processId": 4321, "processCreationTime": null },
        "sessionId": "fixture", "stopGeneration": 1, "riskLevel": "Elevated", "reason": "Approval-surface fixture (authorizes nothing)",
        "createdAtUtc": now.to_rfc3339(), "expiresAtUtc": expires.to_rfc3339(),
    });
    ActionApprovalRequest {
        approval_id: id.to_string(),
        action_id: format!("act_{id}"),
        action_type: "SimulatedType".to_string(),
        parameters_sha256: "fixture-params".to_string(),
        action_parameters: params,
        target_process_name: "fixture.exe".to_string(),
        target_window_title: "D-ASK approval fixture".to_string(),
        target_hwnd: 4660,
        target_process_id: 4321,
        target_process_creation_time: None,
        session_id: "fixture".to_string(),
        stop_generation: 1,
        risk_level: "Elevated".to_string(),
        created_at_utc: now,
        expires_at_utc: expires,
        reason: "Approval-surface fixture (authorizes nothing)".to_string(),
        action_digest: Some(format!("fixture-digest-{id}")),
        canonical_action: Some(canonical.to_string()),
    }
}

fn state(id: &str, state: &str) -> ApprovalStateNotification {
    ApprovalStateNotification {
        approval_id: id.to_string(),
        action_id: format!("act_{id}"),
        state: state.to_string(),
        decision_accepted: None,
        reason: Some("fixture".to_string()),
        timestamp: chrono::Utc::now(),
    }
}

pub fn spawn(proxy: EventLoopProxy<HudAppEvent>) {
    let Ok(path) = std::env::var("DASK_HUD_FIXTURE_CMD") else {
        warn!("[FIXTURE] DASK_HUD_FIXTURE_CMD is not set; no fixture approvals will be shown.");
        return;
    };
    std::thread::spawn(move || {
        let mut done = 0usize;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let lines: Vec<&str> = text.lines().collect();
            for line in lines.iter().skip(done) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                match parts.as_slice() {
                    ["request", id, ttl] => {
                        info!("[FIXTURE] request {id} ttl={ttl}ms");
                        let _ = proxy.send_event(HudAppEvent::IpcActionApproval(Box::new(request(id, ttl.parse().unwrap_or(15_000)))));
                    }
                    ["cancel", id] => {
                        info!("[FIXTURE] cancel {id}");
                        let _ = proxy.send_event(HudAppEvent::IpcApprovalState(Box::new(state(id, "Cancelled"))));
                    }
                    _ => warn!("[FIXTURE] ignored command line ({} chars)", line.len()),
                }
            }
            done = lines.len();
        }
    });
}

/// Logs the decision and answers it as the daemon would (after a short delay). Nothing is authorized.
pub fn on_decision(proxy: EventLoopProxy<HudAppEvent>, approval_id: &str, approved: bool) {
    info!("[FIXTURE] decision approval_id={} approved={}", approval_id, approved);
    let id = approval_id.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = proxy.send_event(HudAppEvent::IpcApprovalState(Box::new(state(&id, if approved { "Approved" } else { "Denied" }))));
    });
}
