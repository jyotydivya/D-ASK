//! Full-screen, click-through overlay behaviour for the HUD window.
//!
//! Why the HUD used to block the desktop: Windows hit-tests every pixel of a window's rectangle, transparent or not,
//! and WebView2's child windows take every click inside it. CSS `pointer-events` can't help, because the click never
//! leaves the WebView. `WM_NCHITTEST`/`HTTRANSPARENT` can't help either: it only passes a click to windows of the
//! same thread, and WebView2's windows belong to another process.
//!
//! What works is a layered window with `WS_EX_TRANSPARENT`: Windows then skips the whole window, children included,
//! when it decides who gets the mouse. A layered window at full alpha keeps WebView2's per-pixel transparency.
//!
//! - Ambient: layered + transparent + no-activate. Everything goes to the applications underneath.
//! - Interactive: a watcher clears `WS_EX_TRANSPARENT` only while the cursor is over a control or panel the page
//!   reported, so empty and decorative areas still pass through.
//! - Hidden: the window is hidden and the WebView stops rendering. The process, its daemon session and any running
//!   task carry on.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};
use windows::Win32::Foundation::{COLORREF, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, ScreenToClient, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, IsWindow, IsWindowVisible,
    SetForegroundWindow, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
    HWND_TOPMOST, LWA_ALPHA, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
};

/// The page may report at most this many regions; anything more is refused.
pub const MAX_REGIONS: usize = 96;
const WATCH_INTERVAL: Duration = Duration::from_millis(16);
const BOUNDS_CHECK_INTERVAL: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum InteractionMode {
    Ambient = 0,
    Interactive = 1,
    Hidden = 2,
}

impl InteractionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            InteractionMode::Ambient => "ambient",
            InteractionMode::Interactive => "interactive",
            InteractionMode::Hidden => "hidden",
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => InteractionMode::Interactive,
            2 => InteractionMode::Hidden,
            _ => InteractionMode::Ambient,
        }
    }

    /// The page can only lower interaction (to Ambient or Hidden), never raise it: it must not be able to take
    /// focus from the user's applications on its own. Interactive is reached only through the user's hotkey.
    pub fn from_page_request(s: &str) -> Option<Self> {
        match s {
            "ambient" => Some(InteractionMode::Ambient),
            "hidden" => Some(InteractionMode::Hidden),
            _ => None,
        }
    }
}

/// A rectangle in client pixels, from the page's CSS pixels times the window's scale factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Region {
    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && py >= self.y && px < self.x + self.w && py < self.y + self.h
    }
}

/// Validates the page's regions (CSS pixels, `[x, y, w, h]`) and converts them to client pixels.
/// Anything malformed rejects the whole message, which leaves the previous regions in place.
pub fn regions_from_css(rects: &[[f64; 4]], scale: f64) -> Result<Vec<Region>, String> {
    if rects.len() > MAX_REGIONS {
        return Err(format!("{} regions exceeds the limit of {}", rects.len(), MAX_REGIONS));
    }
    if !(scale.is_finite() && scale > 0.0 && scale <= 8.0) {
        return Err("invalid scale factor".into());
    }
    rects
        .iter()
        .map(|r| {
            if r.iter().any(|v| !v.is_finite()) || r[2] < 0.0 || r[3] < 0.0 || r.iter().any(|v| v.abs() > 100_000.0) {
                return Err("invalid region".to_string());
            }
            Ok(Region { x: r[0] * scale, y: r[1] * scale, w: r[2] * scale, h: r[3] * scale })
        })
        .collect()
}

pub fn point_hits(regions: &[Region], x: f64, y: f64) -> bool {
    regions.iter().any(|r| r.contains(x, y))
}

// ── Phase 7B.1a (D-5): the approval surface ─────────────────────────────────────────────────────────────────────────
//
// In Ambient mode the whole HUD is click-through. While, and only while, the daemon has an approval pending for this
// HUD, one rectangle (the approval panel the page reports) may take mouse input, so the user can approve or deny without
// making the HUD interactive. The window keeps WS_EX_NOACTIVATE, so a click never takes focus from the user's
// application, and keyboard input never reaches the panel. Everything else stays click-through. The surface:
//   - exists only between a daemon ActionApprovalRequest and its terminal state (or expiry, Stop, disconnect);
//   - is armed only after APPROVAL_ARM_DELAY, so a click already in flight when it appears cannot land on it;
//   - is disarmed after one decision click, until the daemon answers;
//   - is a single bounded rectangle inside the window, for the pending approval id only.

/// A click already in progress when the panel appears must not land on it.
pub const APPROVAL_ARM_DELAY: Duration = Duration::from_millis(800);
/// Never longer than the daemon's maximum approval lifetime.
pub const MAX_APPROVAL_LIFETIME: Duration = Duration::from_secs(30);
/// The panel's largest allowed size, in CSS pixels: a page cannot claim the screen as an "approval surface".
pub const MAX_APPROVAL_W_CSS: f64 = 640.0;
pub const MAX_APPROVAL_H_CSS: f64 = 600.0;

#[derive(Debug, Clone)]
pub struct ApprovalSurface {
    pub approval_id: String,
    armed_at: Instant,
    expires_at: Instant,
    region: Option<Region>,
    disarmed: bool,
}

impl ApprovalSurface {
    pub fn new(approval_id: &str, now: Instant, expires_in: Duration) -> Self {
        Self {
            approval_id: approval_id.to_string(),
            armed_at: now + APPROVAL_ARM_DELAY,
            expires_at: now + expires_in.min(MAX_APPROVAL_LIFETIME),
            region: None,
            disarmed: false,
        }
    }

    /// Whether the panel takes the mouse at this client point now. Everything else is click-through.
    pub fn takes_input_at(&self, now: Instant, x: f64, y: f64) -> bool {
        !self.disarmed && now >= self.armed_at && now < self.expires_at && self.region.map_or(false, |r| r.contains(x, y))
    }

    pub fn expired(&self, now: Instant) -> bool {
        now >= self.expires_at
    }
}

/// Validates the page's approval panel rectangle (CSS pixels) against the window's client size (client pixels).
pub fn approval_region_from_css(rect: [f64; 4], scale: f64, client_w: f64, client_h: f64) -> Result<Region, String> {
    if !(scale.is_finite() && scale > 0.0 && scale <= 8.0) {
        return Err("invalid scale factor".into());
    }
    if rect.iter().any(|v| !v.is_finite()) || rect[2] < 1.0 || rect[3] < 1.0 {
        return Err("invalid approval region".into());
    }
    if rect[2] > MAX_APPROVAL_W_CSS || rect[3] > MAX_APPROVAL_H_CSS {
        return Err("approval region is larger than the allowed panel size".into());
    }
    let r = Region { x: rect[0] * scale, y: rect[1] * scale, w: rect[2] * scale, h: rect[3] * scale };
    if r.x < 0.0 || r.y < 0.0 || r.x + r.w > client_w || r.y + r.h > client_h {
        return Err("approval region is outside the window".into());
    }
    Ok(r)
}

/// Which mode a hotkey press leads to. `Ctrl+Alt+Space` toggles Ambient and Interactive (and brings a hidden HUD
/// back as Interactive); `Ctrl+Alt+H` toggles Hidden.
pub fn after_toggle_interactive(current: InteractionMode) -> InteractionMode {
    match current {
        InteractionMode::Interactive => InteractionMode::Ambient,
        _ => InteractionMode::Interactive,
    }
}

pub fn after_toggle_hidden(current: InteractionMode) -> InteractionMode {
    match current {
        InteractionMode::Hidden => InteractionMode::Ambient,
        _ => InteractionMode::Hidden,
    }
}

/// Whether a mode may be entered. Ambient is always allowed: it is the safe state, in which the HUD never takes input
/// or focus. Hidden needs a hotkey to come back. Interactive is reached only through the user's own hotkey.
pub fn mode_allowed(target: InteractionMode, toggle_hotkey_ok: bool, hide_hotkey_ok: bool) -> bool {
    match target {
        InteractionMode::Interactive => true,
        InteractionMode::Ambient => true,
        // Either hotkey brings a hidden HUD back.
        InteractionMode::Hidden => hide_hotkey_ok || toggle_hotkey_ok,
    }
}

pub struct OverlayController {
    hwnd: isize,
    mode: AtomicU8,
    regions: Mutex<Vec<Region>>,
    /// Serialises every read-modify-write of the extended style between the UI thread and the watcher.
    style_lock: Mutex<()>,
    previous_foreground: AtomicIsize,
    pub toggle_hotkey_ok: AtomicBool,
    pub hide_hotkey_ok: AtomicBool,
    stop: AtomicBool,
    /// Phase 7B.1a: the pending approval's panel, if any. Locked only inside `style_lock` when the style depends on it.
    approval: Mutex<Option<ApprovalSurface>>,
    /// P1/P2: after the user approves ONE input action, the window is fully click-through until that task's result
    /// arrives (or this deadline), so the HUD can never sit between the approved input and its target. Emergency Stop
    /// stays on its global hotkey, and any physical mouse or keyboard use stops the input in the daemon.
    input_passthrough_until: Mutex<Option<Instant>>,
}

fn hwnd_of(v: isize) -> HWND {
    HWND(v as *mut _)
}

impl OverlayController {
    pub fn new(hwnd: HWND) -> Arc<Self> {
        Arc::new(Self {
            hwnd: hwnd.0 as isize,
            // Ambient by default: shown without taking focus or input. Set by `prepare`, before the first show.
            mode: AtomicU8::new(InteractionMode::Ambient as u8),
            regions: Mutex::new(Vec::new()),
            style_lock: Mutex::new(()),
            previous_foreground: AtomicIsize::new(0),
            toggle_hotkey_ok: AtomicBool::new(false),
            hide_hotkey_ok: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            approval: Mutex::new(None),
            input_passthrough_until: Mutex::new(None),
        })
    }

    /// P1/P2: an approved input action is about to run; take no input at all until it ends (bounded by `max`).
    pub fn begin_input_passthrough(&self, max: Duration) {
        *self.input_passthrough_until.lock().unwrap() = Some(Instant::now() + max);
        self.update_ex_style(WS_EX_TRANSPARENT.0, 0);
        info!("[OVERLAY] Input pass-through on for an approved input action (at most {} s).", max.as_secs());
    }

    /// P1/P2: the input action's task ended; normal Interactive / Ambient behaviour resumes.
    pub fn end_input_passthrough(&self) {
        if self.input_passthrough_until.lock().unwrap().take().is_some() {
            info!("[OVERLAY] Input pass-through off.");
        }
    }

    fn input_passthrough_active(&self) -> bool {
        let mut g = self.input_passthrough_until.lock().unwrap();
        match *g {
            Some(until) if Instant::now() < until => true,
            Some(_) => { *g = None; info!("[OVERLAY] Input pass-through ended at its deadline."); false }
            None => false,
        }
    }

    /// The daemon asked this HUD to show an approval. Replaces any earlier one (the daemon allows one per task).
    pub fn begin_approval(&self, approval_id: &str, expires_in: Duration) {
        // Multi-step input: the daemon serves one call per task at a time, so a new approval means the previous approved
        // input has finished. Pass-through must end, or the user could not decide the next step's card.
        self.end_input_passthrough();
        *self.approval.lock().unwrap() = Some(ApprovalSurface::new(approval_id, Instant::now(), expires_in));
        info!("[OVERLAY] Approval surface opened for {} (armed after {} ms).", approval_id, APPROVAL_ARM_DELAY.as_millis());
    }

    /// The approval reached a terminal state, or was invalidated (Stop, disconnect, expiry). `None` ends any approval.
    /// Click-through is restored in the same critical section, so no watcher step can leave the panel taking input.
    pub fn end_approval(&self, approval_id: Option<&str>) {
        let _guard = self.style_lock.lock().unwrap();
        let mut a = self.approval.lock().unwrap();
        if a.as_ref().map_or(false, |s| approval_id.map_or(true, |id| s.approval_id == id)) {
            info!("[OVERLAY] Approval surface closed for {}.", a.as_ref().unwrap().approval_id);
            *a = None;
        }
        drop(a);
        if self.mode() == InteractionMode::Ambient {
            self.set_style_locked(WS_EX_TRANSPARENT.0, 0);
        }
    }

    /// After one decision click: no further input until the daemon answers.
    pub fn disarm_approval(&self, approval_id: &str) {
        let _guard = self.style_lock.lock().unwrap();
        if let Some(s) = self.approval.lock().unwrap().as_mut() {
            if s.approval_id == approval_id {
                s.disarmed = true;
            }
        }
        if self.mode() == InteractionMode::Ambient {
            self.set_style_locked(WS_EX_TRANSPARENT.0, 0);
        }
    }

    /// The page reports where the approval panel is. Refused unless it is for the pending approval and is a single,
    /// bounded rectangle inside the window.
    pub fn set_approval_region(&self, approval_id: &str, rect: Option<[f64; 4]>, scale: f64) -> Result<(), String> {
        let wr = self.window_rect();
        let (cw, ch) = ((wr.right - wr.left) as f64, (wr.bottom - wr.top) as f64);
        let region = match rect {
            Some(r) => Some(approval_region_from_css(r, scale, cw, ch)?),
            None => None,
        };
        let mut a = self.approval.lock().unwrap();
        match a.as_mut() {
            Some(s) if s.approval_id == approval_id => {
                s.region = region;
                Ok(())
            }
            _ => Err("no approval with that id is pending".into()),
        }
    }

    pub fn pending_approval(&self) -> Option<String> {
        self.approval.lock().unwrap().as_ref().map(|s| s.approval_id.clone())
    }

    /// Sets/clears extended-style bits; the caller holds `style_lock`.
    fn set_style_locked(&self, set: u32, clear: u32) {
        unsafe {
            let current = GetWindowLongPtrW(self.hwnd(), GWL_EXSTYLE) as u32;
            let next = (current | set) & !clear;
            if next != current {
                SetWindowLongPtrW(self.hwnd(), GWL_EXSTYLE, next as isize);
            }
        }
    }

    /// One Ambient-mode step: the approval panel under the cursor takes the mouse; everything else is click-through.
    /// The decision is re-checked under `style_lock`, so a concurrent `end_approval` always wins.
    fn ambient_step(&self, client_x: f64, client_y: f64) {
        let _guard = self.style_lock.lock().unwrap();
        if self.mode() != InteractionMode::Ambient {
            return;
        }
        let now = Instant::now();
        let mut a = self.approval.lock().unwrap();
        if a.as_ref().map_or(false, |s| s.expired(now)) {
            info!("[OVERLAY] Approval surface expired for {}.", a.as_ref().unwrap().approval_id);
            *a = None;
        }
        let takes = a.as_ref().map_or(false, |s| s.takes_input_at(now, client_x, client_y));
        drop(a);
        if takes {
            // NOACTIVATE stays set: the panel takes clicks, never focus or keys.
            self.set_style_locked(WS_EX_NOACTIVATE.0, WS_EX_TRANSPARENT.0);
        } else {
            self.set_style_locked(WS_EX_TRANSPARENT.0, 0);
        }
    }

    pub fn hwnd(&self) -> HWND {
        hwnd_of(self.hwnd)
    }

    pub fn mode(&self) -> InteractionMode {
        InteractionMode::from_u8(self.mode.load(Ordering::SeqCst))
    }

    pub fn set_regions(&self, regions: Vec<Region>) {
        *self.regions.lock().unwrap() = regions;
    }

    pub fn region_count(&self) -> usize {
        self.regions.lock().unwrap().len()
    }

    fn update_ex_style(&self, set: u32, clear: u32) {
        self.update_ex_style_when(set, clear, None);
    }

    /// Changes the extended style, but only if the mode is still `required` once the style lock is held. Mode changes
    /// store the new mode before taking this lock, so a watcher step that started in Interactive can't clear
    /// click-through after the switch to Ambient.
    fn update_ex_style_when(&self, set: u32, clear: u32, required: Option<InteractionMode>) {
        let _guard = self.style_lock.lock().unwrap();
        if let Some(mode) = required {
            if self.mode() != mode {
                return;
            }
        }
        unsafe {
            let current = GetWindowLongPtrW(self.hwnd(), GWL_EXSTYLE) as u32;
            let next = (current | set) & !clear;
            if next != current {
                SetWindowLongPtrW(self.hwnd(), GWL_EXSTYLE, next as isize);
            }
        }
    }

    pub fn ex_style(&self) -> u32 {
        unsafe { GetWindowLongPtrW(self.hwnd(), GWL_EXSTYLE) as u32 }
    }

    /// One-time setup before the window is first shown: layered at full alpha, which keeps the WebView's per-pixel
    /// transparency while allowing the window to be skipped by hit-testing.
    pub fn prepare(&self) {
        self.update_ex_style(WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0, 0);
        unsafe {
            if let Err(e) = SetLayeredWindowAttributes(self.hwnd(), COLORREF(0), 255, LWA_ALPHA) {
                warn!("[OVERLAY] SetLayeredWindowAttributes failed: {e}");
            }
        }
        self.fit_to_work_area(true);
    }

    /// The first show, without taking focus from the user's application.
    pub fn show_without_focus(&self) {
        unsafe {
            let _ = ShowWindow(self.hwnd(), SW_SHOWNOACTIVATE);
        }
    }

    /// The work area (the monitor minus the taskbar) of the monitor the HUD is on, in physical pixels.
    pub fn target_bounds(&self, first: bool) -> RECT {
        unsafe {
            let monitor = if first {
                MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY)
            } else {
                MonitorFromWindow(self.hwnd(), MONITOR_DEFAULTTONEAREST)
            };
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if GetMonitorInfoW(monitor, &mut info).as_bool() {
                info.rcWork
            } else {
                RECT { left: 0, top: 0, right: 1280, bottom: 800 }
            }
        }
    }

    pub fn window_rect(&self) -> RECT {
        let mut r = RECT::default();
        unsafe {
            let _ = GetWindowRect(self.hwnd(), &mut r);
        }
        r
    }

    /// Returns true when the window had to be moved or resized.
    pub fn fit_to_work_area(&self, first: bool) -> bool {
        let target = self.target_bounds(first);
        let current = self.window_rect();
        if current == target && !first {
            return false;
        }
        unsafe {
            // Asynchronous, so a watcher thread can't deadlock against a busy UI thread.
            let flags = if first { SWP_NOACTIVATE } else { SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS };
            if let Err(e) = SetWindowPos(
                self.hwnd(),
                Some(HWND_TOPMOST),
                target.left,
                target.top,
                target.right - target.left,
                target.bottom - target.top,
                flags,
            ) {
                warn!("[OVERLAY] SetWindowPos failed: {e}");
            }
        }
        if !first {
            info!(
                "[OVERLAY] Display area changed; HUD now {}x{} at {},{}",
                target.right - target.left,
                target.bottom - target.top,
                target.left,
                target.top
            );
        }
        true
    }

    /// Applies a mode on the UI thread. Returns false when the mode is not allowed (see `mode_allowed`).
    pub fn apply_mode(&self, target: InteractionMode) -> bool {
        if !mode_allowed(target, self.toggle_hotkey_ok.load(Ordering::SeqCst), self.hide_hotkey_ok.load(Ordering::SeqCst)) {
            warn!("[OVERLAY] Refused to enter {} mode: the hotkey needed to leave it is unavailable.", target.as_str());
            return false;
        }
        let previous = self.mode();
        let hwnd = self.hwnd();
        unsafe {
            match target {
                InteractionMode::Interactive => {
                    let fg = GetForegroundWindow();
                    if fg != hwnd && !fg.0.is_null() {
                        self.previous_foreground.store(fg.0 as isize, Ordering::SeqCst);
                    }
                    self.update_ex_style(0, WS_EX_NOACTIVATE.0);
                    if !IsWindowVisible(hwnd).as_bool() {
                        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    }
                    self.mode.store(target as u8, Ordering::SeqCst);
                    // Allowed: this runs in response to the user's hotkey.
                    let _ = SetForegroundWindow(hwnd);
                }
                InteractionMode::Ambient => {
                    self.mode.store(target as u8, Ordering::SeqCst);
                    self.update_ex_style(WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0, 0);
                    if !IsWindowVisible(hwnd).as_bool() {
                        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    }
                    self.return_focus();
                }
                InteractionMode::Hidden => {
                    self.mode.store(target as u8, Ordering::SeqCst);
                    self.update_ex_style(WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0, 0);
                    self.return_focus();
                    let _ = ShowWindow(hwnd, SW_HIDE);
                }
            }
        }
        info!("[OVERLAY] Mode {} -> {}", previous.as_str(), target.as_str());
        true
    }

    /// Gives keyboard focus back to the application that had it before the HUD was made interactive.
    fn return_focus(&self) {
        unsafe {
            if GetForegroundWindow() != self.hwnd() {
                return;
            }
            let prev = hwnd_of(self.previous_foreground.swap(0, Ordering::SeqCst));
            if !prev.0.is_null() && IsWindow(Some(prev)).as_bool() {
                let _ = SetForegroundWindow(prev);
            }
        }
    }

    /// One step of the watcher: in Interactive mode the window takes input only while the cursor is over a region.
    /// A held mouse button keeps the current state, so a drag that leaves a region isn't cut off.
    pub fn watch_step(&self) {
        if self.input_passthrough_active() {
            if self.ex_style() & WS_EX_TRANSPARENT.0 == 0 {
                self.update_ex_style(WS_EX_TRANSPARENT.0, 0);
            }
            return;
        }
        let interactive = self.mode() == InteractionMode::Interactive;
        if !interactive {
            if self.mode() == InteractionMode::Ambient {
                let has_approval = self.approval.lock().unwrap().is_some();
                if !has_approval {
                    if self.ex_style() & WS_EX_TRANSPARENT.0 == 0 {
                        self.update_ex_style(WS_EX_TRANSPARENT.0, 0);
                    }
                    return;
                }
                unsafe {
                    // A held button keeps the current state, so a click or drag in progress is never split.
                    let held = [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].iter().any(|k| (GetAsyncKeyState(k.0 as i32) as u16 & 0x8000) != 0);
                    if held {
                        return;
                    }
                    let mut p = POINT::default();
                    if GetCursorPos(&mut p).is_err() {
                        self.ambient_step(f64::NAN, f64::NAN);
                        return;
                    }
                    let _ = ScreenToClient(self.hwnd(), &mut p);
                    self.ambient_step(p.x as f64, p.y as f64);
                }
            }
            return;
        }
        unsafe {
            let held = [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].iter().any(|k| (GetAsyncKeyState(k.0 as i32) as u16 & 0x8000) != 0);
            if held {
                return;
            }
            let mut p = POINT::default();
            if GetCursorPos(&mut p).is_err() {
                return;
            }
            let _ = ScreenToClient(self.hwnd(), &mut p);
            let over = point_hits(&self.regions.lock().unwrap(), p.x as f64, p.y as f64);
            if over {
                self.update_ex_style_when(0, WS_EX_TRANSPARENT.0, Some(InteractionMode::Interactive));
            } else {
                self.update_ex_style(WS_EX_TRANSPARENT.0, 0);
            }
        }
    }

    pub fn spawn_watcher(self: &Arc<Self>) -> std::thread::JoinHandle<()> {
        let me = self.clone();
        std::thread::spawn(move || {
            let mut last_bounds = Instant::now();
            while !me.stop.load(Ordering::SeqCst) {
                me.watch_step();
                if last_bounds.elapsed() >= BOUNDS_CHECK_INTERVAL {
                    last_bounds = Instant::now();
                    if me.mode() != InteractionMode::Hidden {
                        me.fit_to_work_area(false);
                    }
                }
                std::thread::sleep(WATCH_INTERVAL);
            }
        })
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_scale_from_css_pixels_to_client_pixels() {
        let r = regions_from_css(&[[10.0, 20.0, 100.0, 50.0]], 1.25).unwrap();
        assert_eq!(r[0], Region { x: 12.5, y: 25.0, w: 125.0, h: 62.5 });
        assert!(point_hits(&r, 12.5, 25.0));
        assert!(point_hits(&r, 137.0, 87.0));
        assert!(!point_hits(&r, 137.5, 50.0), "the right edge is exclusive");
        assert!(!point_hits(&r, 5.0, 30.0));
    }

    #[test]
    fn malformed_regions_are_refused_as_a_whole() {
        assert!(regions_from_css(&[[0.0, 0.0, -1.0, 5.0]], 1.0).is_err());
        assert!(regions_from_css(&[[f64::NAN, 0.0, 1.0, 1.0]], 1.0).is_err());
        assert!(regions_from_css(&[[0.0, 0.0, 1e9, 1.0]], 1.0).is_err());
        assert!(regions_from_css(&[[0.0, 0.0, 1.0, 1.0]], 0.0).is_err());
        let many = vec![[0.0, 0.0, 1.0, 1.0]; MAX_REGIONS + 1];
        assert!(regions_from_css(&many, 1.0).is_err());
        assert!(regions_from_css(&[], 1.5).unwrap().is_empty(), "no regions means nothing takes input");
    }

    #[test]
    fn the_page_can_only_lower_interaction() {
        assert_eq!(InteractionMode::from_page_request("ambient"), Some(InteractionMode::Ambient));
        assert_eq!(InteractionMode::from_page_request("hidden"), Some(InteractionMode::Hidden));
        assert_eq!(InteractionMode::from_page_request("interactive"), None);
        assert_eq!(InteractionMode::from_page_request(""), None);
    }

    #[test]
    fn the_watcher_cannot_clear_click_through_once_the_mode_has_left_interactive() {
        // A real hidden window, so the style calls behave as they do in the HUD.
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_POPUP};
        let hwnd = unsafe {
            CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("overlay-test"), WS_POPUP, 0, 0, 10, 10, None, None, None, None).unwrap()
        };
        let c = OverlayController::new(hwnd);
        c.update_ex_style(WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0, 0);
        // Ambient: a step that "saw" Interactive earlier must not take effect.
        c.update_ex_style_when(0, WS_EX_TRANSPARENT.0, Some(InteractionMode::Interactive));
        assert_ne!(c.ex_style() & WS_EX_TRANSPARENT.0, 0, "ambient lost click-through");
        // Interactive: the same step does take effect.
        c.mode.store(InteractionMode::Interactive as u8, Ordering::SeqCst);
        c.update_ex_style_when(0, WS_EX_TRANSPARENT.0, Some(InteractionMode::Interactive));
        assert_eq!(c.ex_style() & WS_EX_TRANSPARENT.0, 0);
        // Back to ambient: a watcher step restores click-through whatever the cursor is over.
        c.mode.store(InteractionMode::Ambient as u8, Ordering::SeqCst);
        c.watch_step();
        assert_ne!(c.ex_style() & WS_EX_TRANSPARENT.0, 0, "ambient must always end up click-through");
        unsafe { let _ = DestroyWindow(hwnd); }
    }

    // ── Phase 7B.1a: the Ambient approval surface ──

    #[test]
    fn approval_surface_takes_input_only_inside_its_region_after_arming_and_before_expiry() {
        let t0 = Instant::now();
        let mut s = ApprovalSurface::new("ap1", t0, Duration::from_secs(10));
        assert!(!s.takes_input_at(t0 + Duration::from_secs(2), 5.0, 5.0), "no region reported yet");
        s.region = Some(Region { x: 0.0, y: 0.0, w: 10.0, h: 10.0 });
        assert!(!s.takes_input_at(t0 + Duration::from_millis(100), 5.0, 5.0), "not armed yet: a click in flight must not land");
        assert!(s.takes_input_at(t0 + APPROVAL_ARM_DELAY, 5.0, 5.0));
        assert!(!s.takes_input_at(t0 + Duration::from_secs(2), 15.0, 5.0), "outside the panel stays click-through");
        assert!(!s.takes_input_at(t0 + Duration::from_secs(10), 5.0, 5.0), "expired");
        s.disarmed = true;
        assert!(!s.takes_input_at(t0 + Duration::from_secs(2), 5.0, 5.0), "disarmed after a decision click");
        assert!(!s.takes_input_at(t0 + Duration::from_secs(2), f64::NAN, f64::NAN));
    }

    #[test]
    fn approval_surface_never_outlives_the_daemon_maximum() {
        let t0 = Instant::now();
        let s = ApprovalSurface::new("ap1", t0, Duration::from_secs(3600));
        assert!(s.expired(t0 + MAX_APPROVAL_LIFETIME));
    }

    #[test]
    fn approval_region_is_bounded_single_and_inside_the_window() {
        assert!(approval_region_from_css([100.0, 100.0, 420.0, 300.0], 1.5, 1920.0, 1080.0).is_ok());
        assert!(approval_region_from_css([0.0, 0.0, 1920.0, 1080.0], 1.0, 1920.0, 1080.0).is_err(), "a page cannot claim the screen");
        assert!(approval_region_from_css([0.0, 0.0, MAX_APPROVAL_W_CSS + 1.0, 100.0], 1.0, 4000.0, 4000.0).is_err());
        assert!(approval_region_from_css([1800.0, 0.0, 300.0, 100.0], 1.0, 1920.0, 1080.0).is_err(), "outside the window");
        assert!(approval_region_from_css([-1.0, 0.0, 100.0, 100.0], 1.0, 1920.0, 1080.0).is_err());
        assert!(approval_region_from_css([f64::NAN, 0.0, 100.0, 100.0], 1.0, 1920.0, 1080.0).is_err());
        assert!(approval_region_from_css([0.0, 0.0, 0.0, 100.0], 1.0, 1920.0, 1080.0).is_err());
    }

    #[test]
    fn ambient_approval_surface_on_a_real_window_and_end_restores_click_through() {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_POPUP};
        let hwnd = unsafe {
            CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("approval-test"), WS_POPUP, 0, 0, 200, 200, None, None, None, None).unwrap()
        };
        let c = OverlayController::new(hwnd);
        c.update_ex_style(WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0, 0);
        let transparent = |c: &OverlayController| c.ex_style() & WS_EX_TRANSPARENT.0 != 0;

        // Without a pending approval, Ambient is click-through everywhere.
        c.ambient_step(10.0, 10.0);
        assert!(transparent(&c));
        assert!(c.set_approval_region("ap1", Some([0.0, 0.0, 50.0, 50.0]), 1.0).is_err(), "no approval pending");

        c.begin_approval("ap1", Duration::from_secs(10));
        assert!(c.set_approval_region("other", Some([0.0, 0.0, 50.0, 50.0]), 1.0).is_err(), "wrong id");
        c.set_approval_region("ap1", Some([0.0, 0.0, 50.0, 50.0]), 1.0).unwrap();
        c.ambient_step(10.0, 10.0);
        assert!(transparent(&c), "not armed yet");

        std::thread::sleep(APPROVAL_ARM_DELAY + Duration::from_millis(50));
        c.ambient_step(10.0, 10.0);
        assert!(!transparent(&c), "the panel takes the click");
        assert_ne!(c.ex_style() & WS_EX_NOACTIVATE.0, 0, "but never focus");
        c.ambient_step(150.0, 150.0);
        assert!(transparent(&c), "everywhere else stays click-through");

        // A decision click disarms it; the daemon's terminal state ends it.
        c.ambient_step(10.0, 10.0);
        c.disarm_approval("ap1");
        assert!(transparent(&c));
        c.ambient_step(10.0, 10.0);
        assert!(transparent(&c), "disarmed");
        c.end_approval(Some("ap1"));
        assert_eq!(c.pending_approval(), None);

        // Ending (Stop, disconnect, expiry) restores click-through at once.
        c.begin_approval("ap2", Duration::from_secs(10));
        c.set_approval_region("ap2", Some([0.0, 0.0, 50.0, 50.0]), 1.0).unwrap();
        std::thread::sleep(APPROVAL_ARM_DELAY + Duration::from_millis(50));
        c.ambient_step(10.0, 10.0);
        assert!(!transparent(&c));
        c.end_approval(None);
        assert!(transparent(&c));

        // Interactive and Hidden are not affected by the approval surface logic.
        c.begin_approval("ap3", Duration::from_secs(10));
        c.mode.store(InteractionMode::Hidden as u8, Ordering::SeqCst);
        c.ambient_step(10.0, 10.0);
        assert!(transparent(&c), "the ambient step does nothing outside Ambient");
        unsafe { let _ = DestroyWindow(hwnd); }
    }

    #[test]
    fn the_next_approval_of_a_multi_step_input_ends_the_previous_pass_through() {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_POPUP};
        let hwnd = unsafe {
            CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("passthrough-test"), WS_POPUP, 0, 0, 200, 200, None, None, None, None).unwrap()
        };
        let c = OverlayController::new(hwnd);
        c.begin_input_passthrough(Duration::from_secs(45));
        assert!(c.input_passthrough_active(), "step 1 approved: pass-through on");
        c.begin_approval("step2", Duration::from_secs(10));
        assert!(!c.input_passthrough_active(), "step 2's card must be decidable: pass-through off");
        assert_eq!(c.pending_approval().as_deref(), Some("step2"));
        unsafe { let _ = DestroyWindow(hwnd); }
    }

    #[test]
    fn hotkeys_move_between_the_three_modes() {
        use InteractionMode::*;
        assert_eq!(after_toggle_interactive(Ambient), Interactive);
        assert_eq!(after_toggle_interactive(Interactive), Ambient);
        assert_eq!(after_toggle_interactive(Hidden), Interactive);
        assert_eq!(after_toggle_hidden(Ambient), Hidden);
        assert_eq!(after_toggle_hidden(Interactive), Hidden);
        assert_eq!(after_toggle_hidden(Hidden), Ambient);
    }

    #[test]
    fn a_mode_needs_a_working_hotkey_to_leave_it() {
        use InteractionMode::*;
        assert!(mode_allowed(Interactive, false, false), "interactive is always reachable");
        assert!(mode_allowed(Ambient, false, false), "ambient is the safe state and is always allowed");
        assert!(!mode_allowed(Hidden, false, false), "with neither hotkey, hidden would strand the HUD");
        assert!(mode_allowed(Hidden, true, false), "the toggle hotkey also brings a hidden HUD back");
        assert!(mode_allowed(Ambient, true, false));
        assert!(mode_allowed(Hidden, false, true));
    }
}
