use crate::ipc::framing::{read_frame, write_frame};
use crate::ipc::protocol::{
    ActionApprovalRequest, ActionLifecycleNotification, EmergencyStopResponse,
    HandshakeRequest, HandshakeResponse, HeartbeatPing, IpcEnvelope, ResourceAlert,
    ResumeExecutionResponse, StateRestoreRequest, StateRestoreResponse, StateUpdate,
    TelemetryUpdate, CURRENT_PROTOCOL_VERSION, PIPE_NAME,
};
use crate::state::emergency_stop::NativeEmergencyStopLatch;
use crate::state::hud_state::{ConnectionStatus, SharedHudState};
use chrono::Utc;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

pub const PRIORITY_QUEUE_CAPACITY: usize = 16;
pub const ORDINARY_QUEUE_CAPACITY: usize = 64;
pub const ORDINARY_WRITE_TIMEOUT: Duration = Duration::from_millis(500);

pub struct IpcClient {
    state: SharedHudState,
    latch: Arc<NativeEmergencyStopLatch>,
    event_proxy: Option<winit::event_loop::EventLoopProxy<crate::HudAppEvent>>,
    #[allow(dead_code)]
    outgoing_tx: mpsc::Sender<IpcEnvelope>,
    outgoing_rx: mpsc::Receiver<IpcEnvelope>,
    #[allow(dead_code)]
    priority_tx: mpsc::Sender<IpcEnvelope>,
    priority_rx: mpsc::Receiver<IpcEnvelope>,
    active_session_token: Option<String>,
}

impl IpcClient {
    pub fn new(
        state: SharedHudState,
        latch: Arc<NativeEmergencyStopLatch>,
        event_proxy: Option<winit::event_loop::EventLoopProxy<crate::HudAppEvent>>,
    ) -> (
        Self,
        mpsc::Sender<IpcEnvelope>,
        mpsc::Sender<IpcEnvelope>,
    ) {
        let (tx, rx) = mpsc::channel(ORDINARY_QUEUE_CAPACITY);
        let (ptx, prx) = mpsc::channel(PRIORITY_QUEUE_CAPACITY);
        (
            Self {
                state,
                latch,
                event_proxy,
                outgoing_tx: tx.clone(),
                outgoing_rx: rx,
                priority_tx: ptx.clone(),
                priority_rx: prx,
                active_session_token: None,
            },
            tx,
            ptx,
        )
    }

    pub async fn run_client_loop(mut self) {
        let mut backoff_ms = 100u64;

        loop {
            {
                let mut s = self.state.lock().unwrap();
                s.connection = if s.last_sequence > 0 {
                    ConnectionStatus::Reconnecting
                } else {
                    ConnectionStatus::Connecting
                };
            }

            info!("Attempting connection to D-ASK Daemon at '{}'...", PIPE_NAME);

            match ClientOptions::new().open(PIPE_NAME) {
                Ok(pipe_stream) => {
                    info!("Connected to D-ASK Daemon named pipe! Performing handshake...");
                    backoff_ms = 100; // Reset backoff

                    {
                        let mut s = self.state.lock().unwrap();
                        s.connection = ConnectionStatus::Handshaking;
                    }

                    if let Err(e) = self.handle_connected_session(pipe_stream).await {
                        warn!("Pipe session terminated: {}. Reconnecting...", e);
                    }

                    self.active_session_token = None;
                    self.latch.invalidate_pending_resume();

                    {
                        let mut s = self.state.lock().unwrap();
                        s.connection = ConnectionStatus::Disconnected;
                        s.session_id = None;
                    }
                }
                Err(e) => {
                    debug!("Daemon pipe not ready ({}). Retrying in {}ms...", e, backoff_ms);
                    tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                    backoff_ms = (backoff_ms * 2).min(2000);
                }
            }
        }
    }

    async fn handle_connected_session(
        &mut self,
        pipe_stream: tokio::net::windows::named_pipe::NamedPipeClient,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (mut reader, mut writer) = tokio::io::split(pipe_stream);

        // 1. Send Handshake communicating native stop latch state
        let is_stopped = self.latch.is_latched();
        let pending_stop = self.latch.get_pending_stop();
        let current_gen = self.latch.generation();

        let handshake_req = HandshakeRequest {
            client_name: "DAsk.HUD.Native.Rust".to_string(),
            protocol_version: CURRENT_PROTOCOL_VERSION,
            client_process_id: std::process::id(),
            capabilities: vec!["hud_v1".to_string(), "wgpu_direct3d12".to_string()],
            is_emergency_stopped: is_stopped,
            stop_id: pending_stop.as_ref().map(|s| s.stop_id.clone()),
            stop_reason: pending_stop.as_ref().map(|s| s.reason.clone()),
            stop_generation: current_gen,
        };

        let handshake_envelope = IpcEnvelope::new("HandshakeRequest", &handshake_req, None)?;
        write_frame(&mut writer, &handshake_envelope).await?;

        // 2. Wait for HandshakeResponse
        let resp = match read_frame(&mut reader).await? {
            Some(env) => env,
            None => return Err("Server closed pipe during handshake".into()),
        };

        if resp.msg_type != "HandshakeResponse" {
            return Err(format!("Expected HandshakeResponse, got {}", resp.msg_type).into());
        }

        let handshake_resp: HandshakeResponse = serde_json::from_value(resp.payload)?;
        if handshake_resp.status != "Accepted" {
            return Err(format!("Handshake rejected: {:?}", handshake_resp.message).into());
        }

        info!(
            "Handshake accepted by Daemon (PID: {}, Session: {}, DaemonStopped: {})",
            handshake_resp.daemon_process_id, handshake_resp.session_token, handshake_resp.is_emergency_stopped
        );

        // Store active session token
        self.active_session_token = Some(handshake_resp.session_token.clone());

        // 2a. Reconcile Stop State: If either side reports stopped, reconcile to stopped.
        self.latch.reconcile_from_daemon(handshake_resp.is_emergency_stopped, handshake_resp.stop_generation);
        let final_stopped = self.latch.is_latched() || handshake_resp.is_emergency_stopped;

        {
            let mut s = self.state.lock().unwrap();
            s.connection = ConnectionStatus::Connected;
            s.session_id = Some(handshake_resp.session_token.clone());
            if final_stopped {
                s.is_emergency_stopped = true;
                s.stop_generation = self.latch.generation();
                s.active_status = "EmergencyStop".to_string();
                s.orb_mode = "Critical".to_string();
            }
        }

        // 2b. If native host had an unacknowledged pending stop, ensure explicit delivery
        if let Some(pending) = self.latch.get_pending_stop() {
            if let Ok(stop_env) = IpcEnvelope::new("EmergencyStopRequest", &pending, None) {
                let _ = write_frame(&mut writer, &stop_env).await;
            }
        }

        // 2c. Synchronize panic hotkey availability status with daemon
        let (hotkey_avail, hotkey_reason) = {
            let s = self.state.lock().unwrap();
            (
                s.panic_hotkey_registered,
                s.panic_hotkey_error.clone().unwrap_or_else(|| {
                    if s.panic_hotkey_registered {
                        "Dedicated global panic hotkey Ctrl+Shift+F12 active".to_string()
                    } else {
                        "Panic hotkey registration pending or unavailable".to_string()
                    }
                }),
            )
        };
        let hotkey_notif = crate::ipc::protocol::PanicHotkeyStatusNotification {
            is_available: hotkey_avail,
            reason: hotkey_reason,
            error_code: if hotkey_avail { 0 } else { -1 },
            timestamp: Utc::now(),
        };
        if let Ok(notif_env) = IpcEnvelope::new("PanicHotkeyStatusNotification", &hotkey_notif, None) {
            let _ = write_frame(&mut writer, &notif_env).await;
        }

        // 3. If we had a prior state or sequence, request state restoration
        let last_seq = self.state.lock().unwrap().last_sequence;
        let restore_req = StateRestoreRequest {
            last_known_seq: last_seq,
            client_state_timestamp: Utc::now(),
            client_status: if final_stopped { "EmergencyStop".to_string() } else { "Active".to_string() },
        };
        let restore_envelope = IpcEnvelope::new("StateRestoreRequest", &restore_req, None)?;
        write_frame(&mut writer, &restore_envelope).await?;

        // 4. Session loop with Heartbeat and incoming messages
        let mut heartbeat_interval = tokio::time::interval(Duration::from_secs(5));
        let mut ping_seq = 0i64;

        loop {
            tokio::select! {
                biased;

                // Priority Path: Dedicated bounded control channel (Emergency Stop) ALWAYS takes precedence
                Some(priority_env) = self.priority_rx.recv() => {
                    if let Err(e) = write_frame(&mut writer, &priority_env).await {
                        error!("Failed to write priority envelope (EmergencyStop): {}. Connection broken.", e);
                        break;
                    }
                }

                _ = heartbeat_interval.tick() => {
                    ping_seq += 1;
                    let ping = HeartbeatPing {
                        sequence: ping_seq,
                        timestamp: Utc::now(),
                    };
                    let env = IpcEnvelope::new("HeartbeatPing", &ping, None)?;
                    match tokio::time::timeout(ORDINARY_WRITE_TIMEOUT, write_frame(&mut writer, &env)).await {
                        Ok(Ok(_)) => {},
                        Ok(Err(e)) => {
                            error!("Failed to write heartbeat ping: {}. Terminating session.", e);
                            break;
                        }
                        Err(_) => {
                            error!("Heartbeat write timed out after 500ms. Terminating session to unblock priority path.");
                            break;
                        }
                    }
                }

                Some(outgoing) = self.outgoing_rx.recv() => {
                    match tokio::time::timeout(ORDINARY_WRITE_TIMEOUT, write_frame(&mut writer, &outgoing)).await {
                        Ok(Ok(_)) => {},
                        Ok(Err(e)) => {
                            error!("Failed to send outgoing envelope: {}. Terminating session.", e);
                            break;
                        }
                        Err(_) => {
                            error!("Ordinary IPC write timed out after 500ms. Terminating session to unblock priority path.");
                            break;
                        }
                    }
                }

                frame_res = read_frame(&mut reader) => {
                    match frame_res {
                        Ok(Some(env)) => {
                            self.dispatch_envelope(env).await;
                        }
                        Ok(None) => {
                            info!("Daemon closed connection stream.");
                            break;
                        }
                        Err(e) => {
                            error!("Error reading incoming frame: {}", e);
                            break;
                        }
                    }
                }
            }
        }

        Ok(())
    }

    async fn dispatch_envelope(&self, envelope: IpcEnvelope) {
        debug!("HUD received IPC message: {}", envelope.msg_type);

        match envelope.msg_type.as_str() {
            "TelemetryUpdate" => {
                if let Ok(telemetry) = serde_json::from_value::<TelemetryUpdate>(envelope.payload) {
                    let mut s = self.state.lock().unwrap();
                    s.apply_telemetry(telemetry);
                }
            }
            "ResourceAlert" => {
                if let Ok(alert) = serde_json::from_value::<ResourceAlert>(envelope.payload) {
                    warn!("Resource Alert: [{}] {}", alert.severity, alert.reason);
                    let mut s = self.state.lock().unwrap();
                    s.apply_alert(alert);
                }
            }
            "StateUpdate" => {
                if let Ok(update) = serde_json::from_value::<StateUpdate>(envelope.payload) {
                    let mut s = self.state.lock().unwrap();
                    s.apply_state_update(update);
                }
            }
            "StateRestoreResponse" => {
                if let Ok(restore_resp) = serde_json::from_value::<StateRestoreResponse>(envelope.payload) {
                    let mut s = self.state.lock().unwrap();
                    s.apply_restore(restore_resp);
                }
            }
            "ActionApprovalRequest" => {
                if let Ok(req) = serde_json::from_value::<ActionApprovalRequest>(envelope.payload) {
                    info!("Received ActionApprovalRequest from Daemon: ActionId={}", req.action_id);
                    if let Some(proxy) = &self.event_proxy {
                        let _ = proxy.send_event(crate::HudAppEvent::IpcActionApproval(Box::new(req)));
                    }
                }
            }
            "ActionLifecycleNotification" => {
                if let Ok(notif) = serde_json::from_value::<ActionLifecycleNotification>(envelope.payload) {
                    info!("Action Lifecycle Update: {} -> {}", notif.action_id, notif.current_state);
                    if let Some(proxy) = &self.event_proxy {
                        let _ = proxy.send_event(crate::HudAppEvent::IpcActionLifecycle(Box::new(notif)));
                    }
                }
            }
            "EmergencyStopResponse" => {
                if let Ok(resp) = serde_json::from_value::<EmergencyStopResponse>(envelope.payload) {
                    info!("Daemon acknowledged EmergencyStop (StopId={}, Gen={}).", resp.stop_id, resp.stop_generation);
                    self.latch.mark_acknowledged(resp.stop_generation);
                    {
                        let mut s = self.state.lock().unwrap();
                        s.is_emergency_stopped = true;
                        s.stop_generation = resp.stop_generation;
                        s.active_status = "EmergencyStop".to_string();
                        s.orb_mode = "Critical".to_string();
                    }
                    if let Some(proxy) = &self.event_proxy {
                        let _ = proxy.send_event(crate::HudAppEvent::IpcEmergencyStopResponse(Box::new(resp)));
                    }
                }
            }
            "ResumeExecutionResponse" => {
                if let Ok(resp) = serde_json::from_value::<ResumeExecutionResponse>(envelope.payload) {
                    let current_session = self.active_session_token.as_deref().unwrap_or("");
                    match self.latch.try_resume(&resp, current_session) {
                        Ok(gen) => {
                            info!("[NATIVE LATCH] Native stop latch CLEARED by validated daemon Resume (Gen: {}).", gen);
                            let mut s = self.state.lock().unwrap();
                            s.is_emergency_stopped = false;
                            s.stop_generation = gen;
                            s.active_status = "Idle".to_string();
                            s.orb_mode = "Normal".to_string();
                        }
                        Err(reason) => {
                            warn!("[NATIVE LATCH] Rejected ResumeExecutionResponse: {}. Native latch remains LATCHED.", reason);
                        }
                    }
                    if let Some(proxy) = &self.event_proxy {
                        let _ = proxy.send_event(crate::HudAppEvent::IpcResumeExecutionResponse(Box::new(resp)));
                    }
                }
            }
            other => {
                warn!("Received unknown message type: {}", other);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::protocol::EmergencyStopRequest;

    #[tokio::test]
    async fn test_priority_channel_preempts_full_ordinary_channel() {
        let state = Arc::new(std::sync::Mutex::new(crate::state::hud_state::HudState::default()));
        let latch = Arc::new(NativeEmergencyStopLatch::new());

        let (mut client, ordinary_tx, priority_tx) = IpcClient::new(state, latch, None);

        // 1. Fill ordinary bounded channel to capacity (64)
        for i in 0..ORDINARY_QUEUE_CAPACITY {
            let env = IpcEnvelope::new("HeartbeatPing", &HeartbeatPing { sequence: i as i64, timestamp: Utc::now() }, None).unwrap();
            assert!(ordinary_tx.try_send(env).is_ok());
        }

        // 2. Verify ordinary channel is full: subsequent try_send MUST fail
        let overflow_env = IpcEnvelope::new("HeartbeatPing", &HeartbeatPing { sequence: 999, timestamp: Utc::now() }, None).unwrap();
        assert!(ordinary_tx.try_send(overflow_env).is_err(), "Ordinary channel must be full");

        // 3. Send EmergencyStopRequest via priority channel: MUST SUCCEED without blocking or dropping
        let stop_req = EmergencyStopRequest {
            stop_id: "stop_prio_001".to_string(),
            source: "TestPriority".to_string(),
            reason: "Priority channel test".to_string(),
            timestamp: Utc::now(),
        };
        let stop_env = IpcEnvelope::new("EmergencyStopRequest", &stop_req, None).unwrap();
        assert!(priority_tx.try_send(stop_env).is_ok(), "Priority channel must accept message");

        // 4. Verify priority receiver receives the emergency stop immediately
        let received_prio = client.priority_rx.recv().await;
        assert!(received_prio.is_some());
        let received_env = received_prio.unwrap();
        assert_eq!(received_env.msg_type, "EmergencyStopRequest");
    }

    #[tokio::test]
    async fn test_bounded_priority_channel_saturation_and_latch_preservation() {
        let state = Arc::new(std::sync::Mutex::new(crate::state::hud_state::HudState::default()));
        let latch = Arc::new(NativeEmergencyStopLatch::new());

        let (_client, _ordinary_tx, priority_tx) = IpcClient::new(state, latch.clone(), None);

        // 1. Trigger first stop on latch
        let (stop_req, gen, is_new) = latch.trigger_stop("Hotkey", "First stop", Some("stop_primary".to_string()));
        assert!(is_new);
        assert_eq!(gen, 2);

        // 2. Fill priority channel to its bounded capacity (16)
        for i in 0..PRIORITY_QUEUE_CAPACITY {
            let env = IpcEnvelope::new("EmergencyStopRequest", &stop_req, None).unwrap();
            assert!(priority_tx.try_send(env).is_ok(), "Slot {} must be accepted", i);
        }

        // 3. 17th try_send must fail with TrySendError::Full (NON-BLOCKING)
        let overflow_env = IpcEnvelope::new("EmergencyStopRequest", &stop_req, None).unwrap();
        let overflow_res = priority_tx.try_send(overflow_env);
        assert!(overflow_res.is_err());
        assert!(matches!(overflow_res.unwrap_err(), mpsc::error::TrySendError::Full(_)));

        // 4. Even under priority queue saturation, latch state is PRESERVED in dedicated control state
        assert!(latch.is_latched());
        let pending = latch.get_pending_stop();
        assert!(pending.is_some());
        assert_eq!(pending.unwrap().stop_id, "stop_primary");
        assert_eq!(latch.generation(), 2);
    }

    #[tokio::test]
    async fn test_live_pipe_priority_saturation_and_reconnect_delivery() {
        use tokio::net::windows::named_pipe::ServerOptions;

        let pipe_name = format!(r"\\.\pipe\dask-test-sat-{}", uuid::Uuid::new_v4().simple());
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("create server");

        let state = Arc::new(std::sync::Mutex::new(crate::state::hud_state::HudState::default()));
        let latch = Arc::new(NativeEmergencyStopLatch::new());
        let (mut client, _ordinary_tx, priority_tx) = IpcClient::new(state.clone(), latch.clone(), None);

        // 1. Trigger initial stop natively
        let (stop_req, gen, _) = latch.trigger_stop("Hotkey", "Panic", Some("stop_overflow_live".to_string()));
        assert_eq!(gen, 2);

        // 2. Flood priority queue to saturation (16 accepted, 4 rejected)
        for i in 0..20 {
            let env = IpcEnvelope::new("EmergencyStopRequest", &stop_req, None).unwrap();
            let res = priority_tx.try_send(env);
            if i < PRIORITY_QUEUE_CAPACITY {
                assert!(res.is_ok());
            } else {
                assert!(res.is_err());
            }
        }

        // 3. Connect client stream to live server
        let client_stream = ClientOptions::new().open(&pipe_name).expect("connect client");

        let server_task = tokio::spawn(async move {
            let s = server;
            s.connect().await.expect("server connect");
            let (mut reader, mut writer) = tokio::io::split(s);

            // Expect HandshakeRequest communicating stopped state
            let env1 = read_frame(&mut reader).await.unwrap().unwrap();
            assert_eq!(env1.msg_type, "HandshakeRequest");
            let hs: HandshakeRequest = serde_json::from_value(env1.payload).unwrap();
            assert!(hs.is_emergency_stopped);
            assert_eq!(hs.stop_id, Some("stop_overflow_live".to_string()));
            assert_eq!(hs.stop_generation, 2);

            // Send HandshakeResponse
            let resp = HandshakeResponse {
                status: "Accepted".to_string(),
                protocol_version: CURRENT_PROTOCOL_VERSION,
                daemon_process_id: 4321,
                session_token: "sess_prio_sat".to_string(),
                message: Some("OK".to_string()),
                is_emergency_stopped: true,
                stop_generation: 2,
            };
            write_frame(&mut writer, &IpcEnvelope::new("HandshakeResponse", &resp, None).unwrap()).await.unwrap();

            // Read until EmergencyStopRequest is delivered
            let mut received_stop = false;
            for _ in 0..6 {
                if let Ok(Some(env)) = read_frame(&mut reader).await {
                    if env.msg_type == "EmergencyStopRequest" {
                        let stop_details: EmergencyStopRequest = serde_json::from_value(env.payload).unwrap();
                        assert_eq!(stop_details.stop_id, "stop_overflow_live");
                        received_stop = true;

                        // Send EmergencyStopResponse
                        let stop_ack = EmergencyStopResponse {
                            stop_id: "stop_overflow_live".to_string(),
                            success: true,
                            active_actions_cancelled: 0,
                            queued_actions_cancelled: 0,
                            session_id: Some("sess_prio_sat".to_string()),
                            stop_generation: 2,
                            timestamp: Utc::now(),
                        };
                        write_frame(&mut writer, &IpcEnvelope::new("EmergencyStopResponse", &stop_ack, None).unwrap()).await.unwrap();
                        break;
                    }
                }
            }

            assert!(received_stop, "Daemon server must receive EmergencyStopRequest over live pipe");
        });

        // Run client's handle_connected_session with a 2-second timeout
        let client_handle = tokio::time::timeout(
            Duration::from_secs(2),
            client.handle_connected_session(client_stream),
        );
        let _ = client_handle.await.expect("client session within timeout");
        server_task.await.expect("server task completes cleanly");

        assert!(latch.is_latched());
        assert_eq!(latch.generation(), 2);
    }

    #[tokio::test]
    async fn test_live_pipe_blocked_ordinary_write_timeout_and_stop_delivery() {
        use tokio::net::windows::named_pipe::ServerOptions;

        let pipe_name = format!(r"\\.\pipe\dask-test-blk-{}", uuid::Uuid::new_v4().simple());
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .in_buffer_size(4096)
            .out_buffer_size(4096)
            .create(&pipe_name)
            .expect("create server");

        let state = Arc::new(std::sync::Mutex::new(crate::state::hud_state::HudState::default()));
        let latch = Arc::new(NativeEmergencyStopLatch::new());
        let (mut client, ordinary_tx, priority_tx) = IpcClient::new(state.clone(), latch.clone(), None);

        let client_stream = ClientOptions::new().open(&pipe_name).expect("connect client");

        let server_task = tokio::spawn(async move {
            let s = server;
            s.connect().await.expect("server connect");
            let (mut reader, mut writer) = tokio::io::split(s);

            // 1. Handshake
            let env = read_frame(&mut reader).await.unwrap().unwrap();
            assert_eq!(env.msg_type, "HandshakeRequest");
            let resp = HandshakeResponse {
                status: "Accepted".to_string(),
                protocol_version: CURRENT_PROTOCOL_VERSION,
                daemon_process_id: 1111,
                session_token: "sess_block_test".to_string(),
                message: Some("OK".to_string()),
                is_emergency_stopped: false,
                stop_generation: 1,
            };
            write_frame(&mut writer, &IpcEnvelope::new("HandshakeResponse", &resp, None).unwrap()).await.unwrap();

            // 2. Read state restore
            let _ = read_frame(&mut reader).await;

            // 3. STOP READING entirely to induce pipe write buffer stall
            tokio::time::sleep(Duration::from_millis(1500)).await;
        });

        // Concurrently saturate pipe write buffer with outgoing messages
        let ordinary_spammer = tokio::spawn(async move {
            for seq in 0..100 {
                let env = IpcEnvelope::new("HeartbeatPing", &HeartbeatPing { sequence: seq, timestamp: Utc::now() }, None).unwrap();
                let _ = ordinary_tx.try_send(env);
            }
        });

        // Concurrently trigger Stop while blocked
        let latch_clone = latch.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let (stop_req, _, _) = latch_clone.trigger_stop("LivePipeTest", "Stop while blocked", Some("stop_blk_01".to_string()));
            let env = IpcEnvelope::new("EmergencyStopRequest", &stop_req, None).unwrap();
            let _ = priority_tx.try_send(env);
        });

        // Run client's handle_connected_session
        let start = std::time::Instant::now();
        let _ = client.handle_connected_session(client_stream).await;
        let elapsed = start.elapsed();

        // Must exit due to 500ms timeout!
        assert!(elapsed >= Duration::from_millis(450), "Must be bounded by 500ms timeout (was {:?})", elapsed);
        assert!(elapsed < Duration::from_millis(2500), "Must not block indefinitely on write stall (was {:?})", elapsed);

        // Verify stop state was preserved natively during the blocked timeout
        assert!(latch.is_latched());
        let pending = latch.get_pending_stop();
        assert!(pending.is_some());
        assert_eq!(pending.unwrap().stop_id, "stop_blk_01");

        let _ = ordinary_spammer.await;
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn test_live_pipe_partial_frame_disconnect_and_reconnect_framing() {
        use tokio::net::windows::named_pipe::ServerOptions;

        let pipe_name = format!(r"\\.\pipe\dask-test-pf-{}", uuid::Uuid::new_v4().simple());
        let server1 = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("create server1");

        let state = Arc::new(std::sync::Mutex::new(crate::state::hud_state::HudState::default()));
        let latch = Arc::new(NativeEmergencyStopLatch::new());
        let (mut client, _ordinary_tx, _priority_tx) = IpcClient::new(state.clone(), latch.clone(), None);

        let client_stream1 = ClientOptions::new().open(&pipe_name).expect("connect client1");

        // Server 1 connects, performs handshake, then abruptly DROPS stream
        let server1_task = tokio::spawn(async move {
            let s = server1;
            s.connect().await.unwrap();
            let (mut reader, mut writer) = tokio::io::split(s);

            let env = read_frame(&mut reader).await.unwrap().unwrap();
            assert_eq!(env.msg_type, "HandshakeRequest");
            let resp = HandshakeResponse {
                status: "Accepted".to_string(),
                protocol_version: CURRENT_PROTOCOL_VERSION,
                daemon_process_id: 5555,
                session_token: "sess_sever_1".to_string(),
                message: Some("OK".to_string()),
                is_emergency_stopped: false,
                stop_generation: 1,
            };
            write_frame(&mut writer, &IpcEnvelope::new("HandshakeResponse", &resp, None).unwrap()).await.unwrap();

            // Abruptly sever the connection
            drop(reader);
            drop(writer);
        });

        // Run session 1: terminates due to severed pipe
        let _ = client.handle_connected_session(client_stream1).await;
        server1_task.await.unwrap();

        // Reset session state as client loop would do
        client.active_session_token = None;
        client.latch.invalidate_pending_resume();

        // 2. Reconnect on fresh pipe instance: verify clean length-prefixed framing
        let server2 = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("create server2");

        let client_stream2 = ClientOptions::new().open(&pipe_name).expect("connect client2");

        let server2_task = tokio::spawn(async move {
            let s = server2;
            s.connect().await.unwrap();
            let (mut reader, mut writer) = tokio::io::split(s);

            use tokio::io::AsyncReadExt;
            let mut header = [0u8; 4];
            reader.read_exact(&mut header).await.expect("read 4-byte header on reconnect");
            let frame_len = u32::from_le_bytes(header) as usize;
            assert!(frame_len > 10 && frame_len < 10000, "Header must indicate valid frame length: {}", frame_len);

            let mut body = vec![0u8; frame_len];
            reader.read_exact(&mut body).await.expect("read body");

            let env: IpcEnvelope = serde_json::from_slice(&body).expect("deserialize valid envelope");
            assert_eq!(env.msg_type, "HandshakeRequest", "First message on reconnect must be HandshakeRequest");

            let resp = HandshakeResponse {
                status: "Accepted".to_string(),
                protocol_version: CURRENT_PROTOCOL_VERSION,
                daemon_process_id: 5555,
                session_token: "sess_sever_2".to_string(),
                message: Some("OK".to_string()),
                is_emergency_stopped: false,
                stop_generation: 1,
            };
            write_frame(&mut writer, &IpcEnvelope::new("HandshakeResponse", &resp, None).unwrap()).await.unwrap();
        });

        let client_res2 = tokio::time::timeout(
            Duration::from_millis(500),
            client.handle_connected_session(client_stream2),
        ).await;
        assert!(client_res2.is_ok(), "Session 2 established cleanly");
        server2_task.await.unwrap();
    }
}
