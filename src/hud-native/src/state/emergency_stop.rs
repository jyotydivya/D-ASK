use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use chrono::{DateTime, Utc};
use crate::ipc::protocol::{EmergencyStopRequest, ResumeExecutionRequest, ResumeExecutionResponse};

#[derive(Debug, Clone)]
pub struct StopEventDetails {
    pub stop_id: String,
    pub source: String,
    pub reason: String,
    pub timestamp: DateTime<Utc>,
    pub generation: u64,
    pub acknowledged: bool,
}

#[derive(Debug, Clone)]
pub struct PendingResumeRequest {
    pub resume_id: String,
    pub session_id: String,
    pub stop_generation: u64,
    pub requested_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct NativeEmergencyStopLatch {
    is_latched: AtomicBool,
    generation: AtomicU64,
    last_stop: Mutex<Option<StopEventDetails>>,
    pending_resume: Mutex<Option<PendingResumeRequest>>,
}

impl Default for NativeEmergencyStopLatch {
    fn default() -> Self {
        Self {
            is_latched: AtomicBool::new(false),
            generation: AtomicU64::new(1),
            last_stop: Mutex::new(None),
            pending_resume: Mutex::new(None),
        }
    }
}

impl NativeEmergencyStopLatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if native stop latch is currently active.
    /// Thread-safe, lock-free.
    pub fn is_latched(&self) -> bool {
        self.is_latched.load(Ordering::SeqCst)
    }

    /// Monotonic generation counter.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Immediately latch the emergency stop natively.
    /// Synchronous, fail-closed, and independent of IPC/WebView2/Daemon.
    ///
    /// Coalescing: Repeated stop calls while already latched do NOT increment
    /// generation or alter the pending stop ID.
    ///
    /// Returns: (EmergencyStopRequest, generation, is_new_latch)
    pub fn trigger_stop(
        &self,
        source: &str,
        reason: &str,
        stop_id: Option<String>,
    ) -> (EmergencyStopRequest, u64, bool) {
        // 1. Any outstanding resume request is atomically invalidated by a Stop event
        {
            let mut pending = self.pending_resume.lock().unwrap();
            *pending = None;
        }

        let mut last = self.last_stop.lock().unwrap();

        // 2. Coalescing: If ALREADY latched, preserve the original unacknowledged stop event
        if self.is_latched.load(Ordering::SeqCst) {
            if let Some(ref existing) = *last {
                let req = EmergencyStopRequest {
                    stop_id: existing.stop_id.clone(),
                    source: existing.source.clone(),
                    reason: existing.reason.clone(),
                    timestamp: existing.timestamp,
                };
                return (req, existing.generation, false);
            }
        }

        // 3. Newly latched: advance generation monotonically
        let sid = stop_id.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let now = Utc::now();
        let new_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.is_latched.store(true, Ordering::SeqCst);

        let req = EmergencyStopRequest {
            stop_id: sid.clone(),
            source: source.to_string(),
            reason: reason.to_string(),
            timestamp: now,
        };

        *last = Some(StopEventDetails {
            stop_id: sid,
            source: source.to_string(),
            reason: reason.to_string(),
            timestamp: now,
            generation: new_gen,
            acknowledged: false,
        });

        (req, new_gen, true)
    }

    /// Reconcile stop state from daemon during handshake or reconnection.
    /// If either side is stopped, reconcile to stopped.
    pub fn reconcile_from_daemon(&self, daemon_stopped: bool, daemon_generation: u64) {
        if daemon_stopped {
            self.is_latched.store(true, Ordering::SeqCst);
            let mut current = self.generation.load(Ordering::SeqCst);
            while daemon_generation > current {
                match self.generation.compare_exchange_weak(
                    current,
                    daemon_generation,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => break,
                    Err(actual) => current = actual,
                }
            }
            // Reconciling to stopped invalidates any outstanding resume
            let mut pending = self.pending_resume.lock().unwrap();
            *pending = None;
        }
    }

    /// Mark that the daemon has confirmed receipt of the stop request.
    pub fn mark_acknowledged(&self, daemon_generation: u64) {
        let mut last = self.last_stop.lock().unwrap();
        if let Some(ref mut stop) = *last {
            stop.acknowledged = true;
        }
        if daemon_generation > self.generation.load(Ordering::SeqCst) {
            self.generation.store(daemon_generation, Ordering::SeqCst);
        }
    }

    /// Returns unacknowledged or active stop details for reconciliation on reconnect.
    pub fn get_pending_stop(&self) -> Option<EmergencyStopRequest> {
        let last = self.last_stop.lock().unwrap();
        if self.is_latched.load(Ordering::SeqCst) {
            last.as_ref().map(|s| EmergencyStopRequest {
                stop_id: s.stop_id.clone(),
                source: s.source.clone(),
                reason: s.reason.clone(),
                timestamp: s.timestamp,
            })
        } else {
            None
        }
    }

    /// Records an authorized resume request. Must be called before transmitting ResumeExecutionRequest.
    /// Binds the request to the active session ID and current stop generation.
    pub fn record_resume_request(
        &self,
        resume_id: String,
        session_id: String,
    ) -> Result<ResumeExecutionRequest, &'static str> {
        if !self.is_latched.load(Ordering::SeqCst) {
            return Err("CannotResumeWhenNotStopped: Execution is not emergency-stopped.");
        }
        if session_id.is_empty() {
            return Err("NoActiveSession: Cannot request resume without an active IPC session.");
        }

        let active_gen = self.generation.load(Ordering::SeqCst);
        let now = Utc::now();

        {
            let mut pending = self.pending_resume.lock().unwrap();
            *pending = Some(PendingResumeRequest {
                resume_id: resume_id.clone(),
                session_id: session_id.clone(),
                stop_generation: active_gen,
                requested_at: now,
            });
        }

        Ok(ResumeExecutionRequest {
            resume_id,
            source: "FrontendButton".to_string(),
            reason: "User requested execution resumption".to_string(),
            session_id: Some(session_id),
            stop_generation: active_gen,
            timestamp: now,
        })
    }

    /// Invalidate any pending resume request (e.g. on session disconnect).
    pub fn invalidate_pending_resume(&self) {
        let mut pending = self.pending_resume.lock().unwrap();
        *pending = None;
    }

    /// Check if there is an outstanding resume request.
    pub fn has_pending_resume(&self) -> bool {
        self.pending_resume.lock().unwrap().is_some()
    }

    /// Validate and apply an incoming ResumeExecutionResponse.
    /// Requires matching request ID, matching active session, matching generation, and daemon success.
    /// Rejects unsolicited, duplicate, stale, replayed, wrong-session, and wrong-generation responses.
    pub fn try_resume(
        &self,
        response: &ResumeExecutionResponse,
        current_session: &str,
    ) -> Result<u64, &'static str> {
        let mut pending = self.pending_resume.lock().unwrap();
        let req = match pending.as_ref() {
            Some(r) => r,
            None => return Err("UnsolicitedResume: No outstanding resume request exists."),
        };

        // 1. Session verification
        if current_session.is_empty() || req.session_id != current_session {
            return Err("WrongSession: Resume was requested under a different or dead session.");
        }
        match response.session_id.as_deref() {
            Some(resp_session) if resp_session == current_session => {}
            Some(_) => {
                return Err("WrongSession: Response session token does not match current active session.");
            }
            None => {
                return Err("MissingSession: Response lacks required session binding token.");
            }
        }

        // 2. Request ID matching
        if req.resume_id != response.resume_id {
            return Err("WrongRequestId: Response resume ID does not match outstanding request.");
        }

        // 3. Generation validation
        let active_gen = self.generation.load(Ordering::SeqCst);
        if req.stop_generation != active_gen {
            return Err("StaleGeneration: Pending resume request generation is older than active stop generation.");
        }
        if response.stop_generation != active_gen {
            return Err("WrongGeneration: Daemon response stop generation does not match active stop generation.");
        }

        // 4. Daemon success confirmation
        if !response.success {
            *pending = None;
            return Err("DaemonRejected: Daemon rejected resume request.");
        }

        // All validations passed: clear pending request and unlatch native stop state
        *pending = None;
        self.is_latched.store(false, Ordering::SeqCst);
        let mut last = self.last_stop.lock().unwrap();
        *last = None;

        Ok(active_gen)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_native_stop_latch_lifecycle() {
        let latch = NativeEmergencyStopLatch::new();
        assert!(!latch.is_latched());
        assert_eq!(latch.generation(), 1);
        assert!(latch.get_pending_stop().is_none());

        // 1. Trigger stop
        let (req, gen, is_new) = latch.trigger_stop("TestHotkey", "Panic pressed", Some("stop_001".to_string()));
        assert!(latch.is_latched());
        assert!(is_new);
        assert_eq!(gen, 2);
        assert_eq!(req.stop_id, "stop_001");

        // 2. Pending stop is retained
        let pending = latch.get_pending_stop();
        assert!(pending.is_some());
        assert_eq!(pending.unwrap().stop_id, "stop_001");

        // 3. Acknowledging stop keeps latch set until explicit resume
        latch.mark_acknowledged(2);
        assert!(latch.is_latched());
        assert_eq!(latch.generation(), 2);

        // 4. Record resume request under active session "session_alpha"
        let resume_req = latch.record_resume_request("res_100".to_string(), "session_alpha".to_string()).unwrap();
        assert_eq!(resume_req.resume_id, "res_100");
        assert_eq!(resume_req.stop_generation, 2);
        assert!(latch.has_pending_resume());

        // 5. Valid matching response clears latch
        let valid_resp = ResumeExecutionResponse {
            resume_id: "res_100".to_string(),
            success: true,
            session_id: Some("session_alpha".to_string()),
            stop_generation: 2,
            error_message: None,
            timestamp: Utc::now(),
        };
        let res = latch.try_resume(&valid_resp, "session_alpha");
        assert!(res.is_ok());
        assert!(!latch.is_latched());
        assert!(latch.get_pending_stop().is_none());
        assert!(!latch.has_pending_resume());
    }

    #[test]
    fn test_unsolicited_resume_rejected() {
        let latch = NativeEmergencyStopLatch::new();
        latch.trigger_stop("Test", "Stop", Some("s1".to_string()));
        assert!(latch.is_latched());

        let unsolicited_resp = ResumeExecutionResponse {
            resume_id: "random_id".to_string(),
            success: true,
            session_id: Some("session_1".to_string()),
            stop_generation: 2,
            error_message: None,
            timestamp: Utc::now(),
        };

        // No request was recorded -> must reject fail-closed
        let res = latch.try_resume(&unsolicited_resp, "session_1");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("UnsolicitedResume"));
        assert!(latch.is_latched(), "Latch must remain set on unsolicited resume");
    }

    #[test]
    fn test_replayed_resume_response_rejected() {
        let latch = NativeEmergencyStopLatch::new();
        latch.trigger_stop("Test", "Stop", Some("s1".to_string()));

        let _ = latch.record_resume_request("res_1".to_string(), "sess_1".to_string()).unwrap();

        let resp = ResumeExecutionResponse {
            resume_id: "res_1".to_string(),
            success: true,
            session_id: Some("sess_1".to_string()),
            stop_generation: 2,
            error_message: None,
            timestamp: Utc::now(),
        };

        // First delivery: OK
        assert!(latch.try_resume(&resp, "sess_1").is_ok());
        assert!(!latch.is_latched());

        // Replay of same response: REJECTED (pending request was cleared)
        let replay = latch.try_resume(&resp, "sess_1");
        assert!(replay.is_err());
        assert!(replay.unwrap_err().contains("UnsolicitedResume"));
    }

    #[test]
    fn test_delayed_resume_after_newer_stop_rejected() {
        let latch = NativeEmergencyStopLatch::new();
        // 1. Initial stop -> Gen 2
        let (_, gen1, _) = latch.trigger_stop("Test", "Stop 1", Some("s1".to_string()));
        assert_eq!(gen1, 2);

        // 2. User requests resume
        let _ = latch.record_resume_request("res_delayed".to_string(), "sess_1".to_string()).unwrap();

        // 3. User triggers ANOTHER stop before resume response arrives -> Invalidation
        // Latch is cleared to false then re-triggered to test generation bump
        latch.is_latched.store(false, Ordering::SeqCst);
        let (_, gen2, _) = latch.trigger_stop("Test", "Stop 2", Some("s2".to_string()));
        assert_eq!(gen2, 3);
        assert!(!latch.has_pending_resume(), "Newer Stop must invalidate pending resume");

        // 4. Delayed response for old resume arrives
        let delayed_resp = ResumeExecutionResponse {
            resume_id: "res_delayed".to_string(),
            success: true,
            session_id: Some("sess_1".to_string()),
            stop_generation: 2,
            error_message: None,
            timestamp: Utc::now(),
        };
        let res = latch.try_resume(&delayed_resp, "sess_1");
        assert!(res.is_err());
        assert!(latch.is_latched(), "Latch must remain active on delayed resume");
    }

    #[test]
    fn test_wrong_session_and_wrong_id_rejected() {
        let latch = NativeEmergencyStopLatch::new();
        latch.trigger_stop("Test", "Stop", Some("s1".to_string()));

        let _ = latch.record_resume_request("res_good".to_string(), "sess_alpha".to_string()).unwrap();

        // Wrong ID
        let wrong_id_resp = ResumeExecutionResponse {
            resume_id: "res_wrong".to_string(),
            success: true,
            session_id: Some("sess_alpha".to_string()),
            stop_generation: 2,
            error_message: None,
            timestamp: Utc::now(),
        };
        assert!(latch.try_resume(&wrong_id_resp, "sess_alpha").is_err());

        // Wrong Session
        let wrong_sess_resp = ResumeExecutionResponse {
            resume_id: "res_good".to_string(),
            success: true,
            session_id: Some("sess_beta".to_string()),
            stop_generation: 2,
            error_message: None,
            timestamp: Utc::now(),
        };
        assert!(latch.try_resume(&wrong_sess_resp, "sess_alpha").is_err());
        assert!(latch.is_latched());
    }

    #[test]
    fn test_missing_and_wrong_session_rejected_and_latch_retained() {
        let latch = NativeEmergencyStopLatch::new();
        let (_, gen, _) = latch.trigger_stop("Test", "Stop", Some("s_bound".to_string()));
        assert!(latch.is_latched());
        assert_eq!(gen, 2);

        let _ = latch.record_resume_request("res_bound".to_string(), "sess_active".to_string()).unwrap();

        // 1. Missing session_id: None is rejected
        let missing_sess_resp = ResumeExecutionResponse {
            resume_id: "res_bound".to_string(),
            success: true,
            session_id: None,
            stop_generation: 2,
            error_message: None,
            timestamp: Utc::now(),
        };
        let missing_err = latch.try_resume(&missing_sess_resp, "sess_active");
        assert!(missing_err.is_err());
        assert!(missing_err.unwrap_err().contains("MissingSession"));
        // 2. Missing session leaves native stop latch engaged
        assert!(latch.is_latched(), "Latch must remain engaged when session_id is None");
        assert!(latch.has_pending_resume(), "Pending resume request must remain intact for retry or correct response");

        // 3. Wrong session is rejected
        let wrong_sess_resp = ResumeExecutionResponse {
            resume_id: "res_bound".to_string(),
            success: true,
            session_id: Some("sess_impostor".to_string()),
            stop_generation: 2,
            error_message: None,
            timestamp: Utc::now(),
        };
        let wrong_err = latch.try_resume(&wrong_sess_resp, "sess_active");
        assert!(wrong_err.is_err());
        assert!(wrong_err.unwrap_err().contains("WrongSession"));
        assert!(latch.is_latched(), "Latch must remain engaged when session token does not match");

        // 4. Correct session, request ID, and generation succeeds
        let valid_resp = ResumeExecutionResponse {
            resume_id: "res_bound".to_string(),
            success: true,
            session_id: Some("sess_active".to_string()),
            stop_generation: 2,
            error_message: None,
            timestamp: Utc::now(),
        };
        let success_res = latch.try_resume(&valid_resp, "sess_active");
        assert!(success_res.is_ok());
        assert_eq!(success_res.unwrap(), 2);
        assert!(!latch.is_latched(), "Latch must be cleared upon verified matching response");
        assert!(!latch.has_pending_resume(), "Pending resume must be cleared");

        // 5. Replaying the successful response is rejected
        let replay_res = latch.try_resume(&valid_resp, "sess_active");
        assert!(replay_res.is_err());
        assert!(replay_res.unwrap_err().contains("UnsolicitedResume"));
    }

    #[test]
    fn test_repeated_stop_coalesces_and_does_not_inflate_generation() {
        let latch = NativeEmergencyStopLatch::new();

        // 1st stop
        let (req1, gen1, is_new1) = latch.trigger_stop("Hotkey", "Stop", Some("stop_init".to_string()));
        assert!(is_new1);
        assert_eq!(gen1, 2);
        assert_eq!(req1.stop_id, "stop_init");

        // 1,000 rapid repeated stops while already latched
        for i in 0..1000 {
            let (req, gen, is_new) = latch.trigger_stop("Hotkey", "Spam Stop", Some(format!("spam_{}", i)));
            assert!(!is_new, "Subsequent stop must report is_new = false");
            assert_eq!(gen, 2, "Generation must NOT inflate on repeated stops");
            assert_eq!(req.stop_id, "stop_init", "Original stop_id must be preserved");
        }

        assert_eq!(latch.generation(), 2);
        assert_eq!(latch.get_pending_stop().unwrap().stop_id, "stop_init");
    }

    #[test]
    fn test_reconcile_from_daemon() {
        let latch = NativeEmergencyStopLatch::new();
        assert!(!latch.is_latched());

        // Reconcile daemon stopped = true with generation 10
        latch.reconcile_from_daemon(true, 10);
        assert!(latch.is_latched());
        assert_eq!(latch.generation(), 10);

        // Reconcile daemon stopped = false cannot clear an existing native latch
        latch.reconcile_from_daemon(false, 11);
        assert!(latch.is_latched(), "Daemon running status cannot silently clear native latch");
    }

    #[test]
    fn test_concurrent_os_thread_stop_resume_race() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let latch = Arc::new(NativeEmergencyStopLatch::new());
        // Start in stopped state with generation 2
        let (_, init_gen, _) = latch.trigger_stop("Init", "Initial stop", Some("init_stop".to_string()));
        assert_eq!(init_gen, 2);

        let thread_count = 4;
        let iterations = 2000;
        let barrier = Arc::new(Barrier::new(thread_count));
        let mut handles = Vec::new();

        // Thread 1: Hotkey spammer (triggers Stop)
        {
            let latch_c = Arc::clone(&latch);
            let barrier_c = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier_c.wait();
                for i in 0..iterations {
                    let (_, gen, _) = latch_c.trigger_stop("HotkeyThread", "Panic", Some(format!("panic_{}", i)));
                    assert!(gen >= 2);
                }
            }));
        }

        // Thread 2: Resume requester
        {
            let latch_c = Arc::clone(&latch);
            let barrier_c = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier_c.wait();
                for i in 0..iterations {
                    let _ = latch_c.record_resume_request(format!("res_{}", i), "sess_live".to_string());
                }
            }));
        }

        // Thread 3: Daemon Resume responder
        {
            let latch_c = Arc::clone(&latch);
            let barrier_c = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier_c.wait();
                for i in 0..iterations {
                    let active_gen = latch_c.generation();
                    let resp = ResumeExecutionResponse {
                        resume_id: format!("res_{}", i),
                        success: true,
                        session_id: Some("sess_live".to_string()),
                        stop_generation: active_gen,
                        error_message: None,
                        timestamp: Utc::now(),
                    };
                    let _ = latch_c.try_resume(&resp, "sess_live");
                }
            }));
        }

        // Thread 4: Reconciler / Observer
        {
            let latch_c = Arc::clone(&latch);
            let barrier_c = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier_c.wait();
                for i in 0..iterations {
                    if i % 10 == 0 {
                        latch_c.reconcile_from_daemon(true, latch_c.generation());
                    }
                    let _ = latch_c.is_latched();
                    let _ = latch_c.get_pending_stop();
                }
            }));
        }

        for h in handles {
            h.join().expect("Thread joined successfully without panic");
        }

        // Final invariant verification:
        assert!(latch.generation() >= 2);
        if let Some(stop) = latch.get_pending_stop() {
            assert!(!stop.stop_id.is_empty());
        }
    }
}
