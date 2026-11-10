//! Phase 7B.1a: proof, carried in every heartbeat, that the HUD can still stop things.
//!
//! The IPC task sends ping `n`, then posts probe `n` to the winit UI event loop (a user event) and to the panic-hotkey
//! message loop (a thread message). Each loop stores the probe value it handled. Ping `n+1` carries both values, and
//! the daemon renews the HUD's liveness lease only if both are at least `n`. A hung UI loop or a dead hotkey thread
//! therefore stops renewing the lease within one interval, although the pipe and this IPC task are still alive.

use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};

/// Thread message posted to the panic-hotkey thread; `wParam` is the probe value.
pub const WM_LIVENESS_PROBE: u32 = 0x8000 + 0x51; // WM_APP + 0x51

#[derive(Debug, Default)]
pub struct LivenessProbe {
    event_loop_ack: AtomicI64,
    hotkey_ack: AtomicI64,
    hotkey_thread_id: AtomicU32,
}

impl LivenessProbe {
    pub fn new() -> Self {
        Self::default()
    }

    /// Called by the UI event loop when it handles a probe.
    pub fn ack_event_loop(&self, value: i64) {
        self.event_loop_ack.fetch_max(value, Ordering::SeqCst);
    }

    /// Called by the panic-hotkey thread when it handles a probe.
    pub fn ack_hotkey(&self, value: i64) {
        self.hotkey_ack.fetch_max(value, Ordering::SeqCst);
    }

    pub fn acks(&self) -> (i64, i64) {
        (self.event_loop_ack.load(Ordering::SeqCst), self.hotkey_ack.load(Ordering::SeqCst))
    }

    pub fn set_hotkey_thread(&self, thread_id: u32) {
        self.hotkey_thread_id.store(thread_id, Ordering::SeqCst);
    }

    pub fn hotkey_thread(&self) -> u32 {
        self.hotkey_thread_id.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acks_only_move_forward() {
        let p = LivenessProbe::new();
        assert_eq!(p.acks(), (0, 0));
        p.ack_event_loop(5);
        p.ack_event_loop(3); // a late, older probe cannot move the proof backwards
        p.ack_hotkey(4);
        assert_eq!(p.acks(), (5, 4));
    }
}
