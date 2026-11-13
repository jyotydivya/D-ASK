use crate::ipc::agent_bridge::{self, AgentFrontendMessage};
use crate::ipc::framing::{read_frame, write_frame};
use crate::ipc::peer;
use crate::ipc::protocol::{
    ActionApprovalRequest, ActionLifecycleNotification, EmergencyStopResponse,
    HandshakeRequest, HandshakeResponse, HeartbeatPing, IpcEnvelope, ResourceAlert,
    ResumeExecutionResponse, StateRestoreRequest, StateRestoreResponse, StateUpdate,
    TelemetryUpdate, CURRENT_PROTOCOL_VERSION, PIPE_NAME,
};
use crate::ipc::protocol::{ApprovalStateNotification, HeartbeatPong, MessageRejectedNotification};
use crate::state::emergency_stop::NativeEmergencyStopLatch;
use crate::state::hud_state::{ConnectionStatus, SharedHudState};
use crate::state::liveness::{LivenessProbe, WM_LIVENESS_PROBE};
use chrono::Utc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// P1/P2: the PID of the pipe server this HUD verified in the current session (0 = none). Set only after the handshake
/// PID matched the OS-verified pipe server; used solely to grant THAT process permission to bring an approved input
/// target to the front (AllowSetForegroundWindow) when the user approves an input action.
pub static VERIFIED_DAEMON_PID: AtomicU32 = AtomicU32::new(0);
use std::sync::Arc;
use std::time::Duration;
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use windows::Win32::Storage::FileSystem::SECURITY_ANONYMOUS;

pub const PRIORITY_QUEUE_CAPACITY: usize = 16;
pub const ORDINARY_QUEUE_CAPACITY: usize = 64;
pub const ORDINARY_WRITE_TIMEOUT: Duration = Duration::from_millis(500);
const INCOMING_QUEUE_CAPACITY: usize = 256;

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

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
    server_policy: peer::ServerPolicy,
    /// Phase 7B.1a: loop acknowledgements carried in every heartbeat.
    liveness: Arc<LivenessProbe>,
    /// Strictly increasing across sessions, so a stale acknowledgement can never look like a future one.
    ping_seq: i64,
    /// Set when the daemon reports the lease was not renewed: re-confirm the hotkey before the next ping.
    reannounce_hotkey: Arc<AtomicBool>,
}

/// Result of one connection attempt.
enum ConnectOutcome {
    /// The pipe could not be opened (daemon not up yet).
    NotReady(String),
    /// Something answered the pipe but is not the daemon we are willing to talk to. Nothing was sent.
    Rejected(String),
    /// A verified daemon was connected; this is how the session ended.
    Session(Result<(), Box<dyn std::error::Error + Send + Sync>>),
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
                // Production policy only: exact daemon paths derived from this executable's location.
                server_policy: peer::ServerPolicy::production(),
                liveness: Arc::new(LivenessProbe::new()),
                ping_seq: 0,
                reannounce_hotkey: Arc::new(AtomicBool::new(false)),
            },
            tx,
            ptx,
        )
    }

    /// Shares the liveness probe with the UI event loop and the panic-hotkey thread (Phase 7B.1a).
    pub fn with_liveness(mut self, probe: Arc<LivenessProbe>) -> Self {
        self.liveness = probe;
        self
    }

    /// The next heartbeat: its sequence, and the loop acknowledgements that prove the HUD is responsive.
    fn next_ping(&mut self, hotkey_registered: bool) -> HeartbeatPing {
        self.ping_seq += 1;
        let (event_loop_ack, hotkey_ack) = self.liveness.acks();
        HeartbeatPing { sequence: self.ping_seq, timestamp: Utc::now(), event_loop_ack, hotkey_ack, hotkey_registered }
    }

    /// Posts probe `seq` to both loops; the next ping carries what they acknowledged.
    fn post_probes(&self, seq: i64) {
        if let Some(proxy) = &self.event_proxy {
            let _ = proxy.send_event(crate::HudAppEvent::LivenessProbe(seq));
        }
        let tid = self.liveness.hotkey_thread();
        if tid != 0 {
            unsafe {
                use windows::Win32::Foundation::{LPARAM, WPARAM};
                use windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW;
                let _ = PostThreadMessageW(tid, WM_LIVENESS_PROBE, WPARAM(seq as usize), LPARAM(0));
            }
        }
    }

    /// Test-only: the policy cannot be replaced in production builds.
    #[cfg(test)]
    fn with_server_policy(mut self, policy: peer::ServerPolicy) -> Self {
        self.server_policy = policy;
        self
    }

    pub async fn run_client_loop(mut self) {
        let mut backoff_ms = 100u64;
        let mut rejections = 0u32;

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

            match self.connect_once(PIPE_NAME).await {
                ConnectOutcome::Session(result) => {
                    backoff_ms = 100; // Reset backoff
                    rejections = 0;

                    if let Err(e) = result {
                        warn!("Pipe session terminated: {}. Reconnecting...", e);
                    }

                    self.active_session_token = None;
                    self.latch.invalidate_pending_resume();

                    {
                        let mut s = self.state.lock().unwrap();
                        s.connection = ConnectionStatus::Disconnected;
                        s.session_id = None;
                    }
                    self.notify_connection(false, self.latch.is_latched());
                }
                ConnectOutcome::NotReady(e) => {
                    debug!("Daemon pipe not ready ({}). Retrying in {}ms...", e, backoff_ms);
                    tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                    backoff_ms = (backoff_ms * 2).min(2000);
                }
                ConnectOutcome::Rejected(reason) => {
                    rejections += 1;
                    // Loud on the first refusal and then roughly every 30s; never a handshake or stop traffic.
                    if rejections == 1 || rejections % 15 == 0 {
                        error!(
                            "REFUSING to talk to the process serving '{}': {}. Nothing was sent to it. \
                             Emergency-stop delivery to the real daemon is unavailable until the daemon is the \
                             only owner of the pipe. (refusal #{})",
                            PIPE_NAME, reason, rejections
                        );
                    } else {
                        debug!("Pipe server refused again: {}", reason);
                    }
                    tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                    backoff_ms = (backoff_ms * 2).min(2000);
                }
            }
        }
    }

    /// Opens the pipe, verifies who answered, and only then runs the session (handshake etc.).
    /// Client identity of the server is validated on EVERY new connection.
    async fn connect_once(&mut self, pipe_name: &str) -> ConnectOutcome {
        // Taken before the open: the server existed when the open succeeded, so it was created earlier.
        let started = peer::now_filetime();

        // Explicit SQOS: the server may learn nothing about us and can never impersonate us.
        let pipe_stream = match ClientOptions::new()
            .security_qos_flags(SECURITY_ANONYMOUS.0)
            .open(pipe_name)
        {
            Ok(p) => p,
            Err(e) => return ConnectOutcome::NotReady(e.to_string()),
        };

        let verified = match peer::verify_server(&pipe_stream, started, &self.server_policy) {
            Ok(v) => v,
            Err(reason) => {
                drop(pipe_stream);
                return ConnectOutcome::Rejected(reason);
            }
        };
        info!("Verified pipe server PID {} ({}).", verified.pid, verified.image_path);

        {
            let mut s = self.state.lock().unwrap();
            s.connection = ConnectionStatus::Handshaking;
        }

        info!("Connected to D-ASK Daemon named pipe! Performing handshake...");
        let result = self.session_inner(pipe_stream, Some(verified.pid)).await;
        drop(verified); // the process handle is held for the whole session
        ConnectOutcome::Session(result)
    }

    /// Test-only entry that skips server verification. It does not exist in production builds.
    #[cfg(test)]
    async fn handle_connected_session(
        &mut self,
        pipe_stream: tokio::net::windows::named_pipe::NamedPipeClient,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.session_inner(pipe_stream, None).await
    }

    async fn session_inner(
        &mut self,
        pipe_stream: tokio::net::windows::named_pipe::NamedPipeClient,
        verified_daemon_pid: Option<u32>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        VERIFIED_DAEMON_PID.store(0, Ordering::SeqCst);
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

        // The self-reported PID is untrusted; it must equal the PID of the verified pipe server.
        if let Some(pid) = verified_daemon_pid {
            if handshake_resp.daemon_process_id != pid {
                return Err(format!(
                    "Handshake daemon PID {} does not match the verified pipe server PID {}",
                    handshake_resp.daemon_process_id, pid
                )
                .into());
            }
            VERIFIED_DAEMON_PID.store(pid, Ordering::SeqCst);
        }

        info!(
            "Handshake accepted by Daemon (PID: {}, DaemonStopped: {})",
            handshake_resp.daemon_process_id, handshake_resp.is_emergency_stopped
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
        self.notify_connection(true, final_stopped);

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
        // After a stall (e.g. the process was suspended) send one ping, not a burst: each ping needs a fresh proof.
        heartbeat_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Agent requests queued before this point were meant for a session that no longer exists.
        let session_started = Utc::now();

        // Frames are read on their own task for two reasons. The daemon replies inline on its read loop, so if
        // this loop stopped reading during a write, two messages in a row would block both sides until the write
        // timeout ended the session. And a frame half-read in a select branch would be lost if another branch won.
        let (incoming_tx, mut incoming_rx) = mpsc::channel::<Result<IpcEnvelope, String>>(INCOMING_QUEUE_CAPACITY);
        let reader_task = AbortOnDrop(tokio::spawn(async move {
            loop {
                match read_frame(&mut reader).await {
                    Ok(Some(env)) => {
                        if incoming_tx.send(Ok(env)).await.is_err() {
                            return;
                        }
                    }
                    Ok(None) => return,
                    Err(e) => {
                        let _ = incoming_tx.send(Err(e.to_string())).await;
                        return;
                    }
                }
            }
        }));

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
                    let (hotkey_registered, hotkey_reason) = {
                        let s = self.state.lock().unwrap();
                        (s.panic_hotkey_registered, s.panic_hotkey_error.clone())
                    };
                    // Phase 7B.1a: after a lapsed lease the daemon needs a fresh hotkey confirmation before a ping counts.
                    if self.reannounce_hotkey.swap(false, Ordering::SeqCst) {
                        let notif = crate::ipc::protocol::PanicHotkeyStatusNotification {
                            is_available: hotkey_registered,
                            reason: hotkey_reason.unwrap_or_else(|| "Panic hotkey re-confirmed after a lapsed liveness lease".to_string()),
                            error_code: if hotkey_registered { 0 } else { -1 },
                            timestamp: Utc::now(),
                        };
                        let env = IpcEnvelope::new("PanicHotkeyStatusNotification", &notif, None)?;
                        if !matches!(tokio::time::timeout(ORDINARY_WRITE_TIMEOUT, write_frame(&mut writer, &env)).await, Ok(Ok(_))) {
                            error!("Failed to re-confirm the panic hotkey. Terminating session.");
                            break;
                        }
                    }
                    let ping = self.next_ping(hotkey_registered);
                    let ping_seq = ping.sequence;
                    let env = IpcEnvelope::new("HeartbeatPing", &ping, None)?;
                    match tokio::time::timeout(ORDINARY_WRITE_TIMEOUT, write_frame(&mut writer, &env)).await {
                        Ok(Ok(_)) => {
                            // The next ping proves both loops handled this probe within one interval.
                            self.post_probes(ping_seq);
                        },
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
                    if outgoing.timestamp < session_started {
                        if let Some(rejection) = agent_bridge::stale_rejection(&outgoing) {
                            warn!("Dropped a stale {} instead of sending it on a new session.", outgoing.msg_type);
                            self.forward_to_frontend(rejection);
                            continue;
                        }
                    }
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

                incoming = incoming_rx.recv() => {
                    match incoming {
                        Some(Ok(env)) => {
                            self.dispatch_envelope(env).await;
                        }
                        Some(Err(e)) => {
                            error!("Error reading incoming frame: {}", e);
                            break;
                        }
                        None => {
                            info!("Daemon closed connection stream.");
                            break;
                        }
                    }
                }
            }
        }

        drop(reader_task);
        Ok(())
    }

    fn forward_to_frontend(&self, message: AgentFrontendMessage) {
        if let Some(proxy) = &self.event_proxy {
            let _ = proxy.send_event(crate::HudAppEvent::IpcAgent(Box::new(message)));
        }
    }

    fn notify_connection(&self, connected: bool, emergency_stopped: bool) {
        if let Some(proxy) = &self.event_proxy {
            let _ = proxy.send_event(crate::HudAppEvent::IpcConnection { connected, emergency_stopped });
        }
    }

    async fn dispatch_envelope(&self, envelope: IpcEnvelope) {
        debug!("HUD received IPC message: {}", envelope.msg_type);

        if agent_bridge::is_forwarded_type(&envelope.msg_type) {
            self.forward_to_frontend(AgentFrontendMessage {
                msg_type: envelope.msg_type,
                reply_to_id: envelope.reply_to_id,
                payload: envelope.payload,
            });
            return;
        }

        match envelope.msg_type.as_str() {
            "HeartbeatPong" => {
                if let Ok(pong) = serde_json::from_value::<HeartbeatPong>(envelope.payload) {
                    if !pong.lease_renewed {
                        debug!("Heartbeat {} did not renew the liveness lease: {:?}", pong.sequence, pong.reason);
                        self.reannounce_hotkey.store(true, Ordering::SeqCst);
                    }
                }
            }
            "ApprovalStateNotification" => {
                if let Ok(n) = serde_json::from_value::<ApprovalStateNotification>(envelope.payload) {
                    info!("Approval {} is now {} (decision accepted: {:?})", n.approval_id, n.state, n.decision_accepted);
                    if let Some(proxy) = &self.event_proxy {
                        let _ = proxy.send_event(crate::HudAppEvent::IpcApprovalState(Box::new(n)));
                    }
                }
            }
            "MessageRejectedNotification" => {
                if let Ok(n) = serde_json::from_value::<MessageRejectedNotification>(envelope.payload) {
                    warn!("Daemon rejected {} ({}): {}", n.rejected_type, n.code, n.message);
                    if let Some(proxy) = &self.event_proxy {
                        let _ = proxy.send_event(crate::HudAppEvent::IpcMessageRejected(Box::new(n)));
                    }
                }
            }
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
            let env = IpcEnvelope::new("HeartbeatPing", &HeartbeatPing::bare(i as i64, Utc::now()), None).unwrap();
            assert!(ordinary_tx.try_send(env).is_ok());
        }

        // 2. Verify ordinary channel is full: subsequent try_send MUST fail
        let overflow_env = IpcEnvelope::new("HeartbeatPing", &HeartbeatPing::bare(999, Utc::now()), None).unwrap();
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
                let env = IpcEnvelope::new("HeartbeatPing", &HeartbeatPing::bare(seq, Utc::now()), None).unwrap();
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

// ───────── Phase 6: the session loop must keep reading while it writes ─────────

    /// A smoke check that a session survives a daemon reply overlapping a client write. This is NOT proof of
    /// the deadlock fix: Windows absorbs these writes for a tokio server, so it also passes on the old loop.
    /// The real daemon's blocking write can't be reproduced here. The evidence is scripts/hud/first-stop-race.ps1,
    /// run live against the real daemon on both versions, and the source check below guards the fix.
    #[tokio::test]
    async fn phase6_session_survives_a_daemon_reply_overlapping_a_write() {
        use tokio::net::windows::named_pipe::ServerOptions;

        let name = format!(r"\\.\pipe\dask-p6-{}", uuid::Uuid::new_v4().simple());
        // No buffering, matching the real daemon's pipe.
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .in_buffer_size(0)
            .out_buffer_size(0)
            .create(&name)
            .expect("create server");

        let state = Arc::new(std::sync::Mutex::new(crate::state::hud_state::HudState::default()));
        let latch = Arc::new(NativeEmergencyStopLatch::new());
        let (mut client, ordinary_tx, priority_tx) = IpcClient::new(state, latch, None);
        let stream = ClientOptions::new().open(&name).expect("connect client");
        let (delivered_tx, delivered_rx) = tokio::sync::oneshot::channel::<()>();

        let server_task = tokio::spawn(async move {
            let s = server;
            s.connect().await.expect("server accept");
            let (mut reader, mut writer) = tokio::io::split(s);

            let hs = read_frame(&mut reader).await.unwrap().unwrap();
            assert_eq!(hs.msg_type, "HandshakeRequest");
            let resp = HandshakeResponse {
                status: "Accepted".to_string(),
                protocol_version: CURRENT_PROTOCOL_VERSION,
                daemon_process_id: 1,
                session_token: "sess_p6".to_string(),
                message: None,
                is_emergency_stopped: false,
                stop_generation: 1,
            };
            write_frame(&mut writer, &IpcEnvelope::new("HandshakeResponse", &resp, None).unwrap()).await.unwrap();

            // Read until the stop arrives, ignoring the client's start-up messages.
            loop {
                let env = read_frame(&mut reader).await.unwrap().expect("client stayed connected");
                if env.msg_type == "EmergencyStopRequest" {
                    break;
                }
            }

            // Like the daemon: reply inline, reading nothing until the reply is fully taken.
            let big = serde_json::json!({ "padding": "x".repeat(200_000) });
            write_frame(&mut writer, &IpcEnvelope::new("TelemetryUpdate", &big, None).unwrap()).await.unwrap();
            // tokio buffers one write internally, so this next write returns only once the client has taken the
            // whole frame above. That gives the same wait as the .NET daemon, whose write blocks until it is read.
            write_frame(&mut writer, &IpcEnvelope::new("TelemetryUpdate", &serde_json::json!({}), None).unwrap()).await.unwrap();

            // Then the message the client queued behind the stop must still arrive on this session.
            loop {
                let env = read_frame(&mut reader).await.unwrap().expect("client stayed connected");
                if env.msg_type == "SecondMessage" {
                    let _ = delivered_tx.send(());
                    // Stay connected: the session must still be alive when the test cuts it off.
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    return;
                }
            }
        });

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let stop = EmergencyStopRequest {
                stop_id: "stop_p6".to_string(),
                source: "Test".to_string(),
                reason: "reply overlap".to_string(),
                timestamp: Utc::now(),
            };
            priority_tx.try_send(IpcEnvelope::new("EmergencyStopRequest", &stop, None).unwrap()).unwrap();
            // Too large for the pipe to absorb, so this write can only finish once the server reads again.
            let large = serde_json::json!({ "padding": "y".repeat(200_000) });
            ordinary_tx.try_send(IpcEnvelope::new("SecondMessage", &large, None).unwrap()).unwrap();
            // Keep the channels open for the session.
            tokio::time::sleep(Duration::from_secs(5)).await;
        });

        // The session must outlive the 500 ms write timeout: it only ends when the test cuts it off.
        let session = tokio::time::timeout(Duration::from_millis(1800), client.handle_connected_session(stream)).await;
        assert!(session.is_err(), "the session ended early (write timeout deadlock): {:?}", session.map(|r| r.map_err(|e| e.to_string())));
        assert!(delivered_rx.await.is_ok(), "the queued message must arrive on the original session");
        server_task.abort();
    }

    #[test]
    fn phase6_frames_are_not_read_inside_the_select_loop() {
        // A half-read frame dropped by another select branch would corrupt the stream.
        let src = include_str!("client.rs");
        let session = &src[src.find("async fn session_inner").unwrap()..src.find("fn forward_to_frontend").unwrap()];
        let banned = ["frame_res = ", "read_frame(&mut reader)"].concat();
        assert!(!session.contains(&banned), "read_frame must not be a select branch");
    }

    // ───────── Phase 4B-1R.8 (H3): server verification ─────────

    fn h3_pipe_name() -> String {
        format!(r"\\.\pipe\dask-h3-{}", uuid::Uuid::new_v4().simple())
    }

    fn h3_client(policy: peer::ServerPolicy) -> IpcClient {
        let state = Arc::new(std::sync::Mutex::new(crate::state::hud_state::HudState::default()));
        let latch = Arc::new(NativeEmergencyStopLatch::new());
        let (client, _ordinary_tx, _priority_tx) = IpcClient::new(state, latch, None);
        client.with_server_policy(policy)
    }

    #[tokio::test]
    async fn h3_unverified_server_is_refused_and_receives_nothing() {
        use tokio::net::windows::named_pipe::ServerOptions;
        use std::path::PathBuf;

        let name = h3_pipe_name();
        let mut server = ServerOptions::new().first_pipe_instance(true).create(&name).expect("create server");

        // The in-process test "daemon" is NOT an allowed identity: only cmd.exe is.
        let mut client = h3_client(peer::ServerPolicy::allow_only(vec![PathBuf::from(r"C:\Windows\System32\cmd.exe")]));

        let server_task = tokio::spawn(async move {
            server.connect().await.expect("server accept");
            tokio::time::timeout(Duration::from_secs(1), read_frame(&mut server)).await
        });

        match client.connect_once(&name).await {
            ConnectOutcome::Rejected(reason) => assert!(reason.contains("not in the allowed"), "{reason}"),
            ConnectOutcome::NotReady(e) => panic!("expected Rejected, pipe not ready: {e}"),
            ConnectOutcome::Session(_) => panic!("an unverified server was accepted and a session ran"),
        }

        // The refused server received no bytes at all: no handshake, no emergency-stop traffic.
        match server_task.await.expect("server task") {
            Ok(Ok(None)) | Ok(Err(_)) => {}
            Ok(Ok(Some(env))) => panic!("refused server received a frame: {}", env.msg_type),
            Err(_) => panic!("server read timed out instead of seeing the connection close"),
        }
    }

    #[tokio::test]
    async fn h3_handshake_must_report_the_verified_server_pid() {
        use tokio::net::windows::named_pipe::ServerOptions;

        for (offset, expect_ok) in [(0u32, true), (1u32, false)] {
            let name = h3_pipe_name();
            let server = ServerOptions::new().first_pipe_instance(true).create(&name).expect("create server");
            let me = std::env::current_exe().unwrap();
            let mut client = h3_client(peer::ServerPolicy::allow_only(vec![me]));

            let server_task = tokio::spawn(async move {
                let s = server;
                s.connect().await.expect("server accept");
                let (mut reader, mut writer) = tokio::io::split(s);
                let hs = read_frame(&mut reader).await.unwrap().unwrap();
                assert_eq!(hs.msg_type, "HandshakeRequest");
                let resp = HandshakeResponse {
                    status: "Accepted".to_string(),
                    protocol_version: CURRENT_PROTOCOL_VERSION,
                    daemon_process_id: std::process::id() + offset,
                    session_token: "sess_h3".to_string(),
                    message: Some("OK".to_string()),
                    is_emergency_stopped: false,
                    stop_generation: 1,
                };
                write_frame(&mut writer, &IpcEnvelope::new("HandshakeResponse", &resp, None).unwrap()).await.unwrap();
                // Let the client finish its post-handshake messages, then close.
                let _ = tokio::time::timeout(Duration::from_millis(300), async {
                    while let Ok(Some(_)) = read_frame(&mut reader).await {}
                })
                .await;
            });

            let outcome = tokio::time::timeout(Duration::from_secs(5), client.connect_once(&name))
                .await
                .expect("connect_once within timeout");
            match (outcome, expect_ok) {
                (ConnectOutcome::Session(Ok(())), true) => {}
                (ConnectOutcome::Session(Err(e)), false) => {
                    assert!(e.to_string().contains("does not match the verified pipe server PID"), "{e}")
                }
                (ConnectOutcome::Session(r), _) => panic!("offset {offset}: unexpected session result {r:?}"),
                (ConnectOutcome::Rejected(r), _) => panic!("offset {offset}: verified server was rejected: {r}"),
                (ConnectOutcome::NotReady(e), _) => panic!("offset {offset}: pipe not ready: {e}"),
            }
            let _ = server_task.await;
        }
    }

    #[test]
    fn h3_client_source_has_explicit_sqos_and_no_unverified_production_entry() {
        let src = include_str!("client.rs");
        assert!(src.contains(".security_qos_flags(SECURITY_ANONYMOUS.0)"), "SQOS must be set explicitly to anonymous");
        // Built at runtime: include_str! also embeds this test's own text.
        let banned = ["Impersonate", "NamedPipeClient"].concat();
        assert!(!src.contains(&banned), "pipe-client impersonation must never be introduced");
        let idx = src.find("async fn handle_connected_session").expect("test helper present");
        assert!(
            src[..idx].trim_end().ends_with("#[cfg(test)]"),
            "handle_connected_session skips server verification and must be test-only"
        );
        let cfg_idx = src.find("fn with_server_policy").expect("policy setter present");
        assert!(src[..cfg_idx].trim_end().ends_with("#[cfg(test)]"), "policy override must be test-only");
    }

    /// Driven by the manual H3 live harness against a REAL DAsk.Daemon.exe; skipped in normal runs.
    #[tokio::test]
    #[ignore = "needs a live daemon: set DASK_LIVE_PIPE and DASK_LIVE_DAEMON_EXE (see the H3 live harness)"]
    async fn h3_live_real_daemon_verification_and_stop_delivery() {
        use std::path::PathBuf;

        let pipe = std::env::var("DASK_LIVE_PIPE").expect("DASK_LIVE_PIPE");
        let daemon = PathBuf::from(std::env::var("DASK_LIVE_DAEMON_EXE").expect("DASK_LIVE_DAEMON_EXE"));

        // 1. A policy that does not name the real daemon: the host must refuse it and send nothing.
        let mut refusing = h3_client(peer::ServerPolicy::allow_only(vec![PathBuf::from(r"C:\Windows\System32\cmd.exe")]));
        match refusing.connect_once(&pipe).await {
            ConnectOutcome::Rejected(r) => println!("LIVE: real daemon refused under a non-matching policy: {r}"),
            ConnectOutcome::NotReady(e) => panic!("pipe not ready: {e}"),
            ConnectOutcome::Session(_) => panic!("a non-allowlisted server was accepted"),
        }

        // 2. Correct policy, native stop latched BEFORE connecting: it must reach the real daemon.
        let state = Arc::new(std::sync::Mutex::new(crate::state::hud_state::HudState::default()));
        let latch = Arc::new(NativeEmergencyStopLatch::new());
        latch.trigger_stop("LiveHarness", "stop before connect", Some("live_stop_1".to_string()));
        let (client, _ordinary_tx, _priority_tx) = IpcClient::new(state.clone(), latch.clone(), None);
        let mut client = client.with_server_policy(peer::ServerPolicy::allow_only(vec![daemon]));

        // The session runs until the daemon closes it; cut it off after a few seconds.
        let _ = tokio::time::timeout(Duration::from_secs(4), client.connect_once(&pipe)).await;

        let s = state.lock().unwrap();
        assert!(matches!(s.connection, ConnectionStatus::Connected), "host never reached Connected with the verified daemon");
        assert!(s.session_id.is_some(), "no session established");
        assert!(latch.is_latched(), "native latch must stay latched");
        println!("LIVE: host verified the real daemon and completed the handshake (session {:?})", s.session_id);
    }
}
