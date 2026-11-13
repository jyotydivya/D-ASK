#![cfg_attr(not(test), windows_subsystem = "windows")]

pub mod ipc;
pub mod overlay;
pub mod render;
pub mod state;
pub mod tts;
pub mod stt;
pub mod whisper;
pub mod voice_gate;
#[cfg(feature = "approval-fixture")]
mod approval_fixture;

use ipc::protocol::{
    self, CURRENT_PROTOCOL_VERSION, IpcEnvelope,
};
use ipc::IpcClient;
use state::hud_state::{HudState, OrbState};
use std::borrow::Cow;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::PermissionRequestedEventHandler;
use windows::core::Interface;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
use winit::dpi::{LogicalPosition, LogicalSize};
use winit::event::{Event, KeyEvent, WindowEvent};
use winit::event_loop::{EventLoop, EventLoopBuilder};
use winit::keyboard::{KeyCode, PhysicalKey};
use winit::platform::windows::WindowBuilderExtWindows;
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::{WindowBuilder, WindowLevel};
use wry::http::{Request, Response, StatusCode};
use wry::WebViewExtWindows;

#[allow(non_camel_case_types)]
#[derive(Debug, Copy, Clone)]
#[repr(C)]
enum ACCENT_STATE {
    ACCENT_DISABLED = 0,
    ACCENT_ENABLE_GRADIENT = 1,
    ACCENT_ENABLE_TRANSPARENTGRADIENT = 2,
    ACCENT_ENABLE_BLURBEHIND = 3,
    ACCENT_ENABLE_ACRYLICBLURBEHIND = 4,
    ACCENT_INVALID_STATE = 5,
}

#[repr(C)]
struct ACCENT_POLICY {
    accent_state: ACCENT_STATE,
    accent_flags: u32,
    gradient_color: u32,
    animation_id: u32,
}

#[repr(C)]
struct WINDOWCOMPOSITIONATTRIBDATA {
    attribute: u32,
    data: *mut std::ffi::c_void,
    size_of_data: usize,
}

type PfnSetWindowCompositionAttribute =
    unsafe extern "system" fn(HWND, *mut WINDOWCOMPOSITIONATTRIBDATA) -> i32;

unsafe fn enable_transparent_gradient(hwnd: HWND, color: u32) -> bool {
    const WCA_ACCENT_POLICY: u32 = 19;
    let user32 = match GetModuleHandleA(windows::core::s!("user32.dll")) {
        Ok(h) => h,
        Err(_) => return false,
    };
    let func_ptr = GetProcAddress(user32, windows::core::s!("SetWindowCompositionAttribute"));
    if let Some(func_ptr) = func_ptr {
        let set_attr: PfnSetWindowCompositionAttribute = std::mem::transmute(func_ptr);
        let mut accent = ACCENT_POLICY {
            accent_state: ACCENT_STATE::ACCENT_ENABLE_TRANSPARENTGRADIENT,
            accent_flags: 2,
            gradient_color: color,
            animation_id: 0,
        };
        let mut data = WINDOWCOMPOSITIONATTRIBDATA {
            attribute: WCA_ACCENT_POLICY,
            data: &mut accent as *mut ACCENT_POLICY as *mut std::ffi::c_void,
            size_of_data: std::mem::size_of::<ACCENT_POLICY>(),
        };
        set_attr(hwnd, &mut data) != 0
    } else {
        false
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum WebBridgeMessage {
    FrontendReady,
    CameraIntent { enabled: bool },
    UserCommand { text: String },
    SetState { state: String },
    ModelInference { prompt: String, task_id: Option<String>, max_tokens: Option<i32> },
    Approval { task_id: String, approved: bool },
    Cancel { task_id: String },
    ThemeChange { theme: String },
    EmergencyStop { reason: Option<String> },
    ResumeExecution { reason: Option<String> },
    AgentTaskSubmit(ipc::agent_bridge::AgentSubmitPayload),
    AgentTaskCancel(ipc::agent_bridge::AgentCancelPayload),
    /// Read-only recovery of a FINISHED task's result after a HUD restart (history that was not saved before the HUD closed).
    AgentTaskStatus(ipc::agent_bridge::AgentStatusPayload),
    /// The page may only lower interaction: "ambient" or "hidden".
    SetInteraction { mode: String },
    HitRegions(HitRegionsPayload),
    ActionApprovalDecision {
        approval_id: String,
        approved: bool,
        reason: Option<String>,
        parameters_sha256: Option<String>,
        action_id: Option<String>,
        action_type: Option<String>,
        /// Phase 7B.1a: echo of the daemon's action digest; without it the daemon refuses an approval.
        #[serde(default)]
        action_digest: Option<String>,
    },
    /// Phase 7B.1a: where the approval panel is (CSS pixels), so it alone can take clicks in Ambient mode.
    ApprovalSurface(ApprovalSurfacePayload),
    /// Offline TTS (Windows SAPI, local voices only): speak this text / stop speaking now.
    Speak { text: String },
    StopSpeaking,
    Ping,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalSurfacePayload {
    pub approval_id: String,
    /// `[x, y, width, height]`, or null when the panel is not showing a pending approval.
    pub rect: Option<[f64; 4]>,
}

/// The page's interactive areas in CSS pixels, `[x, y, width, height]`, and its viewport `[width, height, dpr]`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HitRegionsPayload {
    pub rects: Vec<[f64; 4]>,
    pub viewport: [f64; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayHotkey {
    ToggleInteractive,
    ToggleHidden,
}

#[derive(Debug, Clone)]
pub enum HudAppEvent {
    IpcTelemetry(Box<protocol::TelemetryUpdate>),
    IpcState(Box<protocol::StateUpdate>),
    IpcAlert(Box<protocol::ResourceAlert>),
    IpcActionApproval(Box<protocol::ActionApprovalRequest>),
    IpcActionLifecycle(Box<protocol::ActionLifecycleNotification>),
    IpcEmergencyStopResponse(Box<protocol::EmergencyStopResponse>),
    IpcResumeExecutionResponse(Box<protocol::ResumeExecutionResponse>),
    IpcAgent(Box<ipc::agent_bridge::AgentFrontendMessage>),
    IpcConnection { connected: bool, emergency_stopped: bool },
    GlobalPanicStop,
    OverlayHotkeysRegistered { toggle_ok: bool, hide_ok: bool },
    OverlayHotkeyPressed(OverlayHotkey),
    FrontendMessage(String),
    /// Phase 7B.1a: a liveness probe the UI event loop must acknowledge (proves it is not hung).
    LivenessProbe(i64),
    IpcApprovalState(Box<protocol::ApprovalStateNotification>),
    IpcMessageRejected(Box<protocol::MessageRejectedNotification>),
}

fn get_mime_type(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".wasm") {
        "application/wasm"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else if lower.ends_with(".woff") {
        "font/woff"
    } else if lower.ends_with(".ttf") {
        "font/ttf"
    } else if lower.ends_with(".task") {
        "application/octet-stream"
    } else {
        "application/octet-stream"
    }
}

fn resolve_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("d:\\D-ASK\\D-ASK"));
    if cwd.ends_with("hud-native") {
        cwd.parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .unwrap_or(cwd)
    } else {
        cwd
    }
}

fn serve_local_file(root: &Path, rel_path: &str) -> Option<(Vec<u8>, &'static str)> {
    let clean = rel_path.trim_start_matches('/');
    if clean == "api/devices" {
        return Some((
            b"{\"activeDevice\":null,\"hasPhysicalDevice\":false}".to_vec(),
            "application/json; charset=utf-8",
        ));
    }
    let target = if clean.is_empty() || clean == "index.html" {
        root.join(".next").join("server").join("app").join("index.html")
    } else if let Some(stripped) = clean.strip_prefix("_next/static/") {
        root.join(".next").join("static").join(stripped)
    } else if let Some(stripped) = clean.strip_prefix("mediapipe/") {
        root.join("public").join("mediapipe").join(stripped)
    } else {
        root.join("public").join(clean)
    };

    if target.is_file() {
        if let Ok(bytes) = fs::read(&target) {
            let mime = get_mime_type(&target.to_string_lossy());
            return Some((bytes, mime));
        }
    }
    None
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // One HUD per user session. A second one couldn't register the hotkeys (Emergency Stop included) and would stack
    // a second full-screen overlay over the first. Checked before the log is opened: opening it truncates the file,
    // which would erase the running HUD's log.
    let _single_instance = match acquire_single_instance() {
        Some(guard) => guard,
        None => {
            eprintln!("Another D-ASK HUD is already running in this session; this one exits without starting.");
            return Ok(());
        }
    };

    let log_path = std::env::var("DASK_HUD_LOG").unwrap_or_else(|_| "d:\\D-ASK\\D-ASK\\scratch\\hud_trace.log".to_string());
    if let Ok(f) = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
    {
        tracing_subscriber::fmt()
            .with_writer(std::sync::Mutex::new(f))
            .with_env_filter(
                EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| EnvFilter::new("info,hud_native=debug")),
            )
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| EnvFilter::new("info,hud_native=debug")),
            )
            .init();
    }

    info!("Starting D-ASK Native Desktop Host (Rust + WebView2 + Three.js)...");


    let state = HudState::new_shared();
    let args: Vec<String> = std::env::args().collect();
    let headless = args.iter().any(|a| a == "--headless" || a == "-h");

    let duration_secs: Option<u64> = args
        .iter()
        .position(|a| a == "--duration-secs")
        .and_then(|idx| args.get(idx + 1))
        .and_then(|val| val.parse::<u64>().ok());

    let state_override = args
        .iter()
        .position(|a| a == "--state")
        .and_then(|idx| args.get(idx + 1))
        .and_then(|val| OrbState::from_str(val));

    if let Some(target_state) = state_override {
        info!("Applying manual state override: {:?}", target_state);
        let mut s = state.lock().unwrap();
        s.active_status = target_state.as_str().to_string();
        s.orb_mode = target_state.as_str().to_string();
    }

    // Set up multithreaded Tokio runtime for IPC Named Pipe client
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let (event_loop, event_proxy) = if !headless {
        let el: EventLoop<HudAppEvent> = EventLoopBuilder::with_user_event().build()?;
        let ep = el.create_proxy();
        (Some(el), Some(ep))
    } else {
        (None, None)
    };

    let native_latch = Arc::new(state::emergency_stop::NativeEmergencyStopLatch::new());
    // Phase 7B.1a: shared with the UI event loop and the hotkey thread; each heartbeat carries their acknowledgements.
    let liveness_probe = Arc::new(state::liveness::LivenessProbe::new());
    let (client, outgoing_tx, priority_tx) = IpcClient::new(state.clone(), native_latch.clone(), event_proxy.clone());
    let client = client.with_liveness(liveness_probe.clone());

    let mut hotkey_handle = if let Some(ref ep) = event_proxy {
        Some(spawn_global_panic_hotkey_thread(state.clone(), native_latch.clone(), ep.clone(), priority_tx.clone(), liveness_probe.clone()))
    } else {
        None
    };

    if headless {
        info!("Running HUD in headless test / telemetry verification mode.");
        let client_task = rt.spawn(client.run_client_loop());

        let state_clone = state.clone();
        rt.spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                let s = state_clone.lock().unwrap();
                let effective_state = s.effective_orb_state();
                if let Some(t) = &s.latest_telemetry {
                    info!(
                        "[HUD TELEMETRY] RAM: {:.1} MB avail ({:.1}% load) | CPU: {:.1}% | GPU: {} | State: {:?} ({})",
                        t.system_ram.available_bytes as f64 / (1024.0 * 1024.0),
                        t.system_ram.load_percentage,
                        t.cpu.total_usage_percent,
                        t.gpu.adapter_name,
                        effective_state,
                        s.active_status
                    );
                }
            }
        });

        if let Some(secs) = duration_secs {
            info!("Headless HUD will automatically stop after {} seconds.", secs);
            std::thread::sleep(std::time::Duration::from_secs(secs));
        } else {
            let (tx, rx) = std::sync::mpsc::channel();
            ctrlc_handler(tx);
            let _ = rx.recv();
        }

        info!("HUD shutting down gracefully.");
        if let Some(mut handle) = hotkey_handle {
            handle.shutdown();
        }
        client_task.abort();
        return Ok(());
    }

    // Graphical Desktop Mode with Winit + Wry WebView2
    let event_loop = event_loop.unwrap();
    let event_proxy = event_proxy.unwrap();

    // Created hidden; the overlay controller sizes it to the display's work area and shows it without focus.
    let window = Arc::new(
        WindowBuilder::new()
            .with_title("D-ASK Holographic Orb HUD")
            .with_position(LogicalPosition::new(0.0, 0.0))
            .with_inner_size(LogicalSize::new(1280.0, 800.0))
            .with_transparent(true)
            .with_decorations(false)
            .with_window_level(WindowLevel::AlwaysOnTop)
            .with_resizable(false)
            .with_visible(false)
            .with_no_redirection_bitmap(true)
            .build(&event_loop)?,
    );

    let raw_hwnd = match window.window_handle().unwrap().as_raw() {
        RawWindowHandle::Win32(handle) => handle.hwnd.get(),
        _ => panic!("Expected Win32 window handle"),
    };
    let hwnd = HWND(raw_hwnd as _);

    unsafe {
        let ok = enable_transparent_gradient(hwnd, 0x00000000);
        info!(
            "[WIN32] enable_transparent_gradient on parent HWND (0x{:X}): {}",
            raw_hwnd, ok
        );
    }

    let overlay = overlay::OverlayController::new(hwnd);
    // Offline TTS (Windows SAPI): owned by the event loop; stopped on every Emergency Stop path.
    let tts = tts::Tts::start();
    overlay.prepare();

    let root_path = resolve_root();
    info!("Resolved project root: {}", root_path.display());

    let proxy_for_ipc = event_proxy.clone();
    let root_for_protocol = root_path.clone();

    let webview_builder = wry::WebViewBuilder::new()
        .with_transparent(true)
        .with_background_color((0, 0, 0, 0))
        .with_asynchronous_custom_protocol("dask".into(), move |_id, req: Request<Vec<u8>>, responder| {
            let path = req.uri().path().to_string();
            debug!("[CUSTOM PROTOCOL] Request: {}", path);

            // Offline STT: the page POSTs 16-bit PCM WAV; Windows SAPI transcribes it on its own thread (never this one).
            if path == "/api/stt" {
                let json = |status: StatusCode, body: serde_json::Value| Response::builder()
                    .status(status)
                    .header("Content-Type", "application/json")
                    .body(Cow::Owned(body.to_string().into_bytes()))
                    .unwrap();
                if req.method() != "POST" { responder.respond(json(StatusCode::METHOD_NOT_ALLOWED, serde_json::json!({ "error": "POST a WAV" }))); return; }
                let body = req.into_body();
                let received = chrono::Utc::now();   // the end of the recorded segment (voice gate freshness)
                if let Err(why) = stt::validate_wav(&body) { responder.respond(json(StatusCode::BAD_REQUEST, serde_json::json!({ "error": why }))); return; }
                let stt_root = root_for_protocol.clone();
                std::thread::spawn(move || {
                    let file = std::env::temp_dir().join(format!("dask-stt-{}.wav", uuid::Uuid::new_v4()));
                    let t0 = std::time::Instant::now();
                    let result = std::fs::write(&file, &body).map_err(|e| e.to_string()).and_then(|_| stt::transcribe(&stt_root, &file, &body));
                    // Acceptance evidence ONLY: DASK_STT_EVIDENCE_DIR (unset in normal use; set by scripts\hud\voice-live.ps1 for its own
                    // stack) keeps the recording and its transcript in that folder. Otherwise the recording is never kept.
                    let stem = format!("utt-{}", chrono::Utc::now().format("%H%M%S%3f"));
                    if let Some(dir) = std::env::var_os("DASK_STT_EVIDENCE_DIR").map(std::path::PathBuf::from).filter(|d| d.is_dir()) {
                        let _ = std::fs::copy(&file, dir.join(format!("{stem}.wav")));
                        let note = match &result { Ok((t, e)) => format!("{e}\t{t}\n"), Err(e) => format!("error\t{e}\n") };
                        let _ = std::fs::write(dir.join(format!("{stem}.txt")), note);
                    }
                    let _ = std::fs::remove_file(&file);   // the temporary file is always deleted
                    match result {
                        Ok((text, engine)) => {
                            info!("[STT] Transcribed {} bytes of audio ({} characters) with {} in {} ms.", body.len(), text.len(), engine, t0.elapsed().as_millis());
                            // Acceptance ONLY (DASK_VOICE_GATE_DIR, unset in normal use): the page gets the text only if the harness
                            // released it for the open test step; otherwise "" (the page never submits an empty transcript).
                            match voice_gate::gate_dir() {
                                None => responder.respond(json(StatusCode::OK, serde_json::json!({ "text": text, "engine": engine }))),
                                Some(gate) => match voice_gate::hold(&gate, &stem, &text, engine, &body, received, voice_gate::VERDICT_TIMEOUT) {
                                    voice_gate::Outcome::Released(t) => responder.respond(json(StatusCode::OK, serde_json::json!({ "text": t, "engine": engine, "gate": "released" }))),
                                    voice_gate::Outcome::Withheld(why) => responder.respond(json(StatusCode::OK, serde_json::json!({ "text": "", "engine": engine, "gate": "withheld", "reason": why }))),
                                },
                            }
                        }
                        Err(e) => { warn!("[STT] Transcription failed: {}", e); responder.respond(json(StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({ "error": "transcription failed" }))) }
                    }
                });
                return;
            }

            if let Some((bytes, mime)) = serve_local_file(&root_for_protocol, &path) {
                responder.respond(Response::builder()
                    .header("Content-Type", mime)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Cow::Owned(bytes))
                    .unwrap())
            } else {
                warn!("[CUSTOM PROTOCOL] 404 Not Found: {}", path);
                responder.respond(Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .header("Content-Type", "text/plain")
                    .body(Cow::Borrowed(b"404 Not Found" as &[u8]))
                    .unwrap())
            }
        })
        .with_ipc_handler(move |req| {
            let body = req.body().to_string();
            let _ = proxy_for_ipc.send_event(HudAppEvent::FrontendMessage(body));
        })
        .with_url("dask://localhost/");

    let camera_user_intent = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let camera_intent_for_perm = camera_user_intent.clone();
    let webview = match webview_builder.build(&*window) {
        Ok(w) => {
            info!("[WEBVIEW] Successfully built WebView2");
            w
        }
        Err(e) => {
            error!("[WEBVIEW] Failed to build WebView: {:?}", e);
            eprintln!("[WEBVIEW] Failed to build WebView: {:?}", e);
            return Err(e.into());
        }
    };

    // Configure WebView2 DirectComposition and camera/mic permissions
    unsafe {
        let raw_controller = webview.controller();
        if let Ok(c2) = raw_controller.cast::<ICoreWebView2Controller2>() {
            let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                A: 0,
                R: 0,
                G: 0,
                B: 0,
            });
            info!("[WEBVIEW2] Configured ICoreWebView2Controller2 default background alpha to 0");
        }

        if let Ok(core) = raw_controller.CoreWebView2() {
            let mut token = 0i64;
            let _ = core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(move |_sender, args| {
                    if let Some(args) = args {
                        unsafe {
                            let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                            let _ = args.PermissionKind(&mut kind);
                            let mut uri_ptr = windows::core::PWSTR::null();
                            let _ = args.Uri(&mut uri_ptr);
                            let uri_str = if !uri_ptr.is_null() {
                                let s = uri_ptr.to_string().unwrap_or_default();
                                windows::Win32::System::Com::CoTaskMemFree(Some(uri_ptr.as_ptr() as _));
                                s
                            } else {
                                String::new()
                            };

                            let is_trusted_origin = uri_str.starts_with("dask://localhost") || uri_str.starts_with("http://dask.localhost");
                            let has_user_intent = camera_intent_for_perm.load(std::sync::atomic::Ordering::SeqCst);

                            if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                                if is_trusted_origin && has_user_intent {
                                    info!("[WEBVIEW2 SECURITY] Granting CAMERA permission upon verified user action from origin '{}'", uri_str);
                                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                                    camera_intent_for_perm.store(false, std::sync::atomic::Ordering::SeqCst);
                                } else {
                                    warn!("[WEBVIEW2 SECURITY] Denying CAMERA permission: origin='{}' (trusted={}), user_intent={}", uri_str, is_trusted_origin, has_user_intent);
                                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
                                }
                            } else if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                                if is_trusted_origin {
                                    info!("[WEBVIEW2 SECURITY] Granting MICROPHONE permission for trusted origin '{}'", uri_str);
                                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                                } else {
                                    warn!("[WEBVIEW2 SECURITY] Denying MICROPHONE permission for untrusted origin '{}'", uri_str);
                                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
                                }
                            }
                        }
                    }
                    Ok(())
                })),
                &mut token,
            );
            info!("[WEBVIEW2] Registered secured PermissionRequested event handler for camera/mic");
        }
    }

    overlay.show_without_focus();
    let _overlay_watcher = overlay.spawn_watcher();
    let mut last_viewport: Option<[f64; 3]> = None;

    // Spawn IPC client and forward events to event_proxy
    // Test-only fixture mode (feature-gated, absent from production builds): no daemon connection at all.
    #[cfg(feature = "approval-fixture")]
    let fixture_mode = approval_fixture::enabled();
    #[cfg(not(feature = "approval-fixture"))]
    let fixture_mode = false;
    #[cfg(feature = "approval-fixture")]
    let proxy_for_fixture = event_proxy.clone();
    #[cfg(feature = "approval-fixture")]
    if fixture_mode {
        warn!("[FIXTURE] Approval-surface fixture mode: no daemon connection; approvals are synthetic and authorize nothing.");
        approval_fixture::spawn(event_proxy.clone());
    }

    let proxy_for_daemon = event_proxy.clone();
    let state_for_daemon = state.clone();
    if !fixture_mode {
        rt.spawn(async move {
            // Run IPC client in background
            rt_daemon_bridge(client, state_for_daemon, proxy_for_daemon).await;
        });
    }

    let app_start = std::time::Instant::now();
    let outgoing_tx_for_events = outgoing_tx.clone();
    let priority_tx_for_events = priority_tx.clone();
    let native_latch_for_events = native_latch.clone();

    event_loop.run(move |event, target| match event {
        Event::WindowEvent { event, .. } => match event {
            WindowEvent::CloseRequested => target.exit(),
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        physical_key: PhysicalKey::Code(code),
                        ..
                    },
                ..
            } => match code {
                // While interactive, Escape returns to ambient instead of closing the HUD.
                KeyCode::Escape if overlay.mode() == overlay::InteractionMode::Interactive => {
                    set_overlay_mode(&overlay, &webview, overlay::InteractionMode::Ambient);
                }
                KeyCode::Escape | KeyCode::KeyQ => target.exit(),
                _ => {}
            },
            _ => {}
        },
        Event::UserEvent(app_event) => match app_event {
            HudAppEvent::IpcTelemetry(t) => {
                if let Ok(json) = serde_json::to_string(&serde_json::json!({
                    "type": "TelemetryUpdate",
                    "payload": *t,
                })) {
                    let script = format!(
                        "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({});",
                        json
                    );
                    let _ = webview.evaluate_script(&script);
                }
            }
            HudAppEvent::IpcState(s) => {
                if let Ok(json) = serde_json::to_string(&serde_json::json!({
                    "type": "StateUpdate",
                    "payload": *s,
                })) {
                    let script = format!(
                        "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({});",
                        json
                    );
                    let _ = webview.evaluate_script(&script);
                }
            }
            HudAppEvent::IpcAlert(a) => {
                if let Ok(json) = serde_json::to_string(&serde_json::json!({
                    "type": "ResourceAlert",
                    "payload": *a,
                })) {
                    let script = format!(
                        "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({});",
                        json
                    );
                    let _ = webview.evaluate_script(&script);
                }
            }
            HudAppEvent::IpcActionApproval(req) => {
                // Phase 7B.1a: open the (bounded, armed-later) Ambient approval surface for exactly this approval.
                let remaining = (req.expires_at_utc - chrono::Utc::now()).to_std().unwrap_or(std::time::Duration::ZERO);
                overlay.begin_approval(&req.approval_id, remaining);
                if let Ok(json) = serde_json::to_string(&serde_json::json!({
                    "type": "ActionApprovalRequest",
                    "payload": *req,
                })) {
                    let script = format!(
                        "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({});",
                        json
                    );
                    let _ = webview.evaluate_script(&script);
                }
            }
            HudAppEvent::IpcActionLifecycle(notif) => {
                if let Ok(json) = serde_json::to_string(&serde_json::json!({
                    "type": "ActionLifecycleNotification",
                    "payload": *notif,
                })) {
                    let script = format!(
                        "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({});",
                        json
                    );
                    let _ = webview.evaluate_script(&script);
                }
            }
            HudAppEvent::IpcEmergencyStopResponse(resp) => {
                tts.stop();
                overlay.end_approval(None);
                if let Ok(json) = serde_json::to_string(&serde_json::json!({
                    "type": "EmergencyStopResponse",
                    "payload": *resp,
                })) {
                    let script = format!(
                        "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({});",
                        json
                    );
                    let _ = webview.evaluate_script(&script);
                }
            }
            HudAppEvent::IpcResumeExecutionResponse(resp) => {
                if let Ok(json) = serde_json::to_string(&serde_json::json!({
                    "type": "ResumeExecutionResponse",
                    "payload": *resp,
                })) {
                    let script = format!(
                        "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({});",
                        json
                    );
                    let _ = webview.evaluate_script(&script);
                }
            }
            HudAppEvent::IpcAgent(message) => {
                // P1/P2: the task an approved input belonged to has ended: stop passing input through.
                if message.msg_type == "AgentTaskResultNotification" {
                    overlay.end_input_passthrough();
                }
                dispatch_to_frontend(&webview, &*message);
            }
            HudAppEvent::LivenessProbe(seq) => {
                liveness_probe.ack_event_loop(seq);
            }
            HudAppEvent::IpcApprovalState(n) => {
                // Any state the daemon reports for this approval other than Pending means it can no longer be decided.
                if n.is_terminal() {
                    overlay.end_approval(Some(&n.approval_id));
                }
                dispatch_to_frontend(&webview, &serde_json::json!({ "type": "ApprovalStateNotification", "payload": *n }));
            }
            HudAppEvent::IpcMessageRejected(n) => {
                dispatch_to_frontend(&webview, &serde_json::json!({ "type": "MessageRejectedNotification", "payload": *n }));
            }
            HudAppEvent::IpcConnection { connected, emergency_stopped } => {
                if !connected {
                    // Disconnect fails closed: the daemon has invalidated this session's approvals.
                    overlay.end_approval(None);
                }
                dispatch_connection(&webview, connected, emergency_stopped);
            }
            HudAppEvent::OverlayHotkeysRegistered { toggle_ok, hide_ok } => {
                overlay.toggle_hotkey_ok.store(toggle_ok, std::sync::atomic::Ordering::SeqCst);
                overlay.hide_hotkey_ok.store(hide_ok, std::sync::atomic::Ordering::SeqCst);
                // Never fall back to interactive: an overlay that takes input without the user asking blocks the desktop.
                // It stays click-through and says why it can't be made interactive.
                if !toggle_ok {
                    warn!("[OVERLAY] Ctrl+Alt+Space is unavailable; staying in ambient mode (click-through). The HUD can't be made interactive until it is restarted without the conflict.");
                }
                dispatch_interaction(&webview, &overlay);
            }
            HudAppEvent::OverlayHotkeyPressed(key) => {
                let next = match key {
                    OverlayHotkey::ToggleInteractive => overlay::after_toggle_interactive(overlay.mode()),
                    OverlayHotkey::ToggleHidden => overlay::after_toggle_hidden(overlay.mode()),
                };
                set_overlay_mode(&overlay, &webview, next);
            }
            HudAppEvent::GlobalPanicStop => {
                tts.stop();
                overlay.end_approval(None);
                let script = "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({type:'EmergencyStopTriggered',payload:{source:'GlobalHotkey'}});";
                let _ = webview.evaluate_script(script);
            }
            HudAppEvent::FrontendMessage(raw_msg) => {
                if raw_msg.len() > 65536 {
                    warn!("[IPC BRIDGE SECURITY] Discarded payload exceeding 64KB limit: {} bytes", raw_msg.len());
                    return;
                }
                // Never the content: it can hold what the user typed.
                debug!("[IPC BRIDGE] Frontend message: {} bytes", raw_msg.len());
                match serde_json::from_str::<WebBridgeMessage>(&raw_msg) {
                    Ok(WebBridgeMessage::FrontendReady) => {
                        info!("[IPC BRIDGE] Frontend UI is ready and mounted");
                        // The page can load after the handshake, so it is told the current state.
                        let (connected, stopped) = {
                            let s = state.lock().unwrap();
                            (matches!(s.connection, state::hud_state::ConnectionStatus::Connected), s.is_emergency_stopped)
                        };
                        dispatch_connection(&webview, connected, stopped || native_latch_for_events.is_latched());
                        dispatch_interaction(&webview, &overlay);
                    }
                    Ok(WebBridgeMessage::CameraIntent { enabled }) => {
                        info!("[IPC BRIDGE] Camera intent updated by user action: enabled={}", enabled);
                        camera_user_intent.store(enabled, std::sync::atomic::Ordering::SeqCst);
                    }
                    Ok(WebBridgeMessage::SetState { state: target_state }) => {
                        let trimmed = target_state.trim();
                        if trimmed.len() <= 32 {
                            info!("[IPC BRIDGE] SetState requested: {}", trimmed);
                            {
                                let mut s = state.lock().unwrap();
                                s.active_status = trimmed.to_string();
                                s.orb_mode = trimmed.to_string();
                            }
                            let script = format!(
                                "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({{type: 'StateUpdate', payload: {{activeStatus: '{}', orbMode: '{}', sequenceNumber: 0}}}});",
                                trimmed, trimmed
                            );
                            let _ = webview.evaluate_script(&script);
                        } else {
                            warn!("[IPC BRIDGE SECURITY] Rejected oversized state parameter: {}", trimmed);
                        }
                    }
                    Ok(WebBridgeMessage::ModelInference { prompt, .. }) => {
                        // Refused, never forwarded (docs/issues/daemon-inference-estop-delay.md): the daemon handles one message per session at a
                        // time, so a long generation on THIS pipe would hold back an Emergency Stop sent on it. The HUD frontend never sends this
                        // message (agent inference runs in the agent host's own llama-server); only a page script could, so the bridge refuses it.
                        warn!("[IPC BRIDGE SECURITY] Refused ModelInference from the web view ({} bytes): direct daemon inference is not offered to the page", prompt.len());
                    }
                    Ok(WebBridgeMessage::UserCommand { text }) => {
                        info!("[IPC BRIDGE] User command dispatched ({} chars)", text.chars().count());
                        if let Ok(envelope) = IpcEnvelope::new(
                            "UserCommand",
                            &serde_json::json!({ "text": text }),
                            None,
                        ) {
                            let _ = outgoing_tx_for_events.try_send(envelope);
                        }
                    }
                    Ok(WebBridgeMessage::Approval { task_id: _, approved: _ }) => {
                        // Phase 7B.1a (F6): the retired page approval path. It never reached any policy; there is exactly
                        // one approval path (ActionApprovalDecision -> daemon policy). Refused here, explicitly, and not sent.
                        warn!("[IPC BRIDGE] Refused obsolete 'Approval' message: it authorizes nothing.");
                        dispatch_to_frontend(&webview, &serde_json::json!({
                            "type": "MessageRejectedNotification",
                            "payload": {
                                "rejectedType": "Approval",
                                "code": "obsolete_authorization_message",
                                "message": "This approval path is obsolete and authorizes nothing. Approvals are decided only in the approval panel.",
                                "timestamp": chrono::Utc::now(),
                            },
                        }));
                    }
                    Ok(WebBridgeMessage::Cancel { task_id }) => {
                        info!("[IPC BRIDGE] Task cancellation: task_id={}", task_id);
                        if let Ok(envelope) = IpcEnvelope::new(
                            "TaskCancel",
                            &serde_json::json!({ "taskId": task_id }),
                            None,
                        ) {
                            let _ = outgoing_tx_for_events.try_send(envelope);
                        }
                    }
                    Ok(WebBridgeMessage::AgentTaskSubmit(payload)) => {
                        let connected = matches!(state.lock().unwrap().connection, state::hud_state::ConnectionStatus::Connected);
                        let stopped = native_latch_for_events.is_latched();
                        info!("[IPC BRIDGE] Agent task requested ({} chars)", payload.objective.chars().count());
                        // Acceptance ONLY (DASK_VOICE_GATE_DIR, unset in normal use): once the harness enforces the gate, only the
                        // transcript it released for the current test step is forwarded to the daemon (one-shot, exact).
                        let gated = voice_gate::gate_dir().map(|gate| voice_gate::check_submit(&gate, &payload.objective));
                        if let Some(Err(why)) = gated {
                            dispatch_to_frontend(&webview, &ipc::agent_bridge::gate_rejection(&payload.request_id, &why));
                        } else {
                            match ipc::agent_bridge::build_submit(&payload, connected, stopped) {
                                Ok(envelope) => send_agent_request(&outgoing_tx_for_events, &webview, envelope),
                                Err(message) => dispatch_to_frontend(&webview, &message),
                            }
                        }
                    }
                    Ok(WebBridgeMessage::Speak { text }) => tts.speak(&text),
                    Ok(WebBridgeMessage::StopSpeaking) => tts.stop(),
                    Ok(WebBridgeMessage::AgentTaskCancel(payload)) => {
                        let connected = matches!(state.lock().unwrap().connection, state::hud_state::ConnectionStatus::Connected);
                        info!("[IPC BRIDGE] Agent task cancel requested: {}", payload.task_id);
                        match ipc::agent_bridge::build_cancel(&payload, connected) {
                            Ok(envelope) => send_agent_request(&outgoing_tx_for_events, &webview, envelope),
                            Err(message) => dispatch_to_frontend(&webview, &message),
                        }
                    }
                    Ok(WebBridgeMessage::AgentTaskStatus(payload)) => {
                        let connected = matches!(state.lock().unwrap().connection, state::hud_state::ConnectionStatus::Connected);
                        match ipc::agent_bridge::build_status(&payload, connected) {
                            Ok(envelope) => send_agent_request(&outgoing_tx_for_events, &webview, envelope),
                            Err(message) => dispatch_to_frontend(&webview, &message),
                        }
                    }
                    Ok(WebBridgeMessage::SetInteraction { mode }) => match overlay::InteractionMode::from_page_request(&mode) {
                        Some(m) => set_overlay_mode(&overlay, &webview, m),
                        None => warn!("[OVERLAY] Ignored a page request for mode {:?}: the page can only lower interaction.", mode),
                    },
                    Ok(WebBridgeMessage::HitRegions(payload)) => {
                        match overlay::regions_from_css(&payload.rects, window.scale_factor()) {
                            Ok(regions) => overlay.set_regions(regions),
                            Err(e) => warn!("[OVERLAY] Rejected hit regions: {e}"),
                        }
                        if last_viewport != Some(payload.viewport) {
                            last_viewport = Some(payload.viewport);
                            let r = overlay.window_rect();
                            info!(
                                "[OVERLAY] Page viewport {}x{} CSS px at DPR {}; window {}x{} at {},{}; scale factor {}",
                                payload.viewport[0], payload.viewport[1], payload.viewport[2],
                                r.right - r.left, r.bottom - r.top, r.left, r.top, window.scale_factor()
                            );
                        }
                    }
                    Ok(WebBridgeMessage::ApprovalSurface(p)) => {
                        if let Err(e) = overlay.set_approval_region(&p.approval_id, p.rect, window.scale_factor()) {
                            warn!("[OVERLAY] Refused approval surface for {}: {e}", p.approval_id);
                        }
                    }
                    Ok(WebBridgeMessage::EmergencyStop { reason }) => {
                        overlay.end_approval(None);
                        let r = reason.unwrap_or_else(|| "User clicked Stop HUD button".to_string());
                        warn!("[IPC BRIDGE] Emergency Stop requested from HUD UI: {}", r);
                        let (stop_req, gen, _) = native_latch_for_events.trigger_stop("FrontendButton", &r, None);
                        {
                            let mut s = state.lock().unwrap();
                            s.is_emergency_stopped = true;
                            s.stop_generation = gen;
                            s.active_status = "EmergencyStop".to_string();
                            s.orb_mode = "Critical".to_string();
                        }
                        if let Ok(envelope) = protocol::IpcEnvelope::new("EmergencyStopRequest", &stop_req, None) {
                            match priority_tx_for_events.try_send(envelope) {
                                Ok(_) => info!("[FRONTEND STOP] EmergencyStopRequest queued to priority channel."),
                                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                    warn!("[FRONTEND STOP] Priority channel full; stop preserved in dedicated latch state.");
                                }
                                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                                    warn!("[FRONTEND STOP] Priority channel closed; stop preserved in dedicated latch state.");
                                }
                            }
                        }
                        let _ = webview.evaluate_script(
                            "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({type:'EmergencyStopTriggered',payload:{source:'FrontendButton'}});"
                        );
                    }
                    Ok(WebBridgeMessage::ResumeExecution { reason }) => {
                        let r = reason.unwrap_or_else(|| "User clicked Resume HUD button".to_string());
                        info!("[IPC BRIDGE] Resume Execution requested from HUD UI: {}", r);
                        let session_id = state.lock().unwrap().session_id.clone().unwrap_or_default();
                        if session_id.is_empty() {
                            warn!("[IPC BRIDGE] Cannot resume: No active IPC session connected to daemon.");
                        } else {
                            let resume_id = uuid::Uuid::new_v4().simple().to_string();
                            match native_latch_for_events.record_resume_request(resume_id, session_id) {
                                Ok(mut resume_req) => {
                                    resume_req.reason = r;
                                    if let Ok(envelope) = protocol::IpcEnvelope::new("ResumeExecutionRequest", &resume_req, None) {
                                        let _ = outgoing_tx_for_events.try_send(envelope);
                                    }
                                }
                                Err(e) => {
                                    warn!("[IPC BRIDGE] Cannot record resume request: {}", e);
                                }
                            }
                        }
                    }
                    Ok(WebBridgeMessage::ActionApprovalDecision {
                        approval_id,
                        approved,
                        reason,
                        parameters_sha256,
                        action_id,
                        action_type,
                        action_digest,
                    }) => {
                        info!(
                            "[IPC BRIDGE] Action approval decision: approval_id={}, approved={}",
                            approval_id, approved
                        );
                        // One click per approval: the surface takes no more input until the daemon answers.
                        overlay.disarm_approval(&approval_id);
                        // P1/P2: the user just approved ONE input action in this (foreground) HUD. Windows lets only the
                        // foreground process hand on the foreground, so grant it to the VERIFIED daemon process only, for
                        // these input types only; the daemon still checks the foreground before every input event.
                        if approved
                            && matches!(action_type.as_deref(), Some("Desktop.ClickElement") | Some("Desktop.TypeText") | Some("Desktop.PressKeys"))
                        {
                            let pid = ipc::client::VERIFIED_DAEMON_PID.load(std::sync::atomic::Ordering::SeqCst);
                            if pid != 0 {
                                let granted = unsafe { windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid) }.is_ok();
                                info!("[IPC BRIDGE] Foreground permission for the approved input granted to daemon PID {}: {}", pid, granted);
                                overlay.begin_input_passthrough(std::time::Duration::from_secs(45));
                            } else {
                                info!("[IPC BRIDGE] No verified daemon PID; foreground permission not granted (the daemon will refuse the input).");
                            }
                        }
                        let dec = protocol::ActionApprovalResponse {
                            action_digest,
                            approval_id,
                            action_id: action_id.unwrap_or_default(),
                            action_type: action_type.unwrap_or_default(),
                            parameters_sha256: parameters_sha256.unwrap_or_default(),
                            approved,
                            decision_source: "UserExplicitConfirmation".to_string(),
                            decided_at_utc: chrono::Utc::now(),
                            session_id: None,
                            stop_generation: 0,
                            rejection_reason: reason,
                        };
                        #[cfg(feature = "approval-fixture")]
                        if fixture_mode {
                            approval_fixture::on_decision(proxy_for_fixture.clone(), &dec.approval_id, dec.approved);
                            return;
                        }
                        if let Ok(envelope) = protocol::IpcEnvelope::new("ActionApprovalResponse", &dec, None) {
                            let _ = outgoing_tx_for_events.try_send(envelope);
                        }
                    }
                    Ok(WebBridgeMessage::ThemeChange { theme }) => {
                        info!("[IPC BRIDGE] Theme changed to: {}", theme);
                    }
                    Ok(WebBridgeMessage::Ping) => {
                        let _ = webview.evaluate_script(
                            "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({type:'Pong'});",
                        );
                    }
                    Err(e) => {
                        warn!("[IPC BRIDGE] Discarding invalid bridge message ({} bytes): line {}, column {}", raw_msg.len(), e.line(), e.column());
                    }
                }
            }
        },
        Event::AboutToWait => {
            if let Some(secs) = duration_secs {
                if app_start.elapsed().as_secs() >= secs {
                    info!("Duration of {}s elapsed. Exiting HUD.", secs);
                    target.exit();
                }
            }
        }
        Event::LoopExiting => {
            overlay.shutdown();
            info!("HUD event loop exiting. Cleaning up panic hotkey thread...");
            if let Some(ref mut handle) = hotkey_handle {
                handle.shutdown();
            }
        }
        _ => {}
    })?;

    Ok(())
}

fn dispatch_to_frontend<T: serde::Serialize>(webview: &wry::WebView, message: &T) {
    if let Ok(json) = serde_json::to_string(message) {
        let script = format!("if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({});", json);
        let _ = webview.evaluate_script(&script);
    }
}

/// Holds a named mutex for the life of the process. None when another HUD already holds it.
fn acquire_single_instance() -> Option<windows::Win32::Foundation::HANDLE> {
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    let name = std::env::var("DASK_HUD_INSTANCE").unwrap_or_else(|_| "D-ASK-HUD".to_string());
    let wide: Vec<u16> = format!("Local\\{name}").encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let handle = CreateMutexW(None, true, windows::core::PCWSTR(wide.as_ptr())).ok()?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return None;
        }
        Some(handle)
    }
}

fn set_overlay_mode(overlay: &overlay::OverlayController, webview: &wry::WebView, mode: overlay::InteractionMode) {
    if overlay.apply_mode(mode) {
        // Hidden stops rendering; the page's scripts, its pipe traffic and any task keep running.
        let _ = webview.set_visible(mode != overlay::InteractionMode::Hidden);
        if mode == overlay::InteractionMode::Interactive {
            let _ = webview.focus();
        }
    }
    dispatch_interaction(webview, overlay);
}

fn dispatch_interaction(webview: &wry::WebView, overlay: &overlay::OverlayController) {
    use std::sync::atomic::Ordering;
    dispatch_to_frontend(
        webview,
        &serde_json::json!({
            "type": "InteractionState",
            "payload": {
                "mode": overlay.mode().as_str(),
                "toggleHotkey": "Ctrl+Alt+Space",
                "hideHotkey": "Ctrl+Alt+H",
                "stopHotkey": "Ctrl+Shift+F12",
                "toggleAvailable": overlay.toggle_hotkey_ok.load(Ordering::SeqCst),
                "hideAvailable": overlay.hide_hotkey_ok.load(Ordering::SeqCst),
            },
        }),
    );
}

fn dispatch_connection(webview: &wry::WebView, connected: bool, emergency_stopped: bool) {
    dispatch_to_frontend(
        webview,
        &serde_json::json!({
            "type": "AgentConnection",
            "payload": { "connected": connected, "emergencyStopped": emergency_stopped },
        }),
    );
}

/// A full or closed queue fails the request now instead of leaving the frontend waiting.
fn send_agent_request(tx: &mpsc::Sender<IpcEnvelope>, webview: &wry::WebView, envelope: IpcEnvelope) {
    if let Err(e) = tx.try_send(envelope) {
        let refused = match e {
            mpsc::error::TrySendError::Full(env) | mpsc::error::TrySendError::Closed(env) => env,
        };
        warn!("[IPC BRIDGE] {} refused: the outgoing queue is full or closed.", refused.msg_type);
        if let Some(message) = ipc::agent_bridge::queue_rejection(&refused) {
            dispatch_to_frontend(webview, &message);
        }
    }
}

async fn rt_daemon_bridge(
    client: IpcClient,
    state: state::hud_state::SharedHudState,
    proxy: winit::event_loop::EventLoopProxy<HudAppEvent>,
) {
    let client_task = tokio::spawn(client.run_client_loop());

    let mut last_seq = -1i64;
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;

        let (telemetry, state_update, alert) = {
            let s = state.lock().unwrap();
            let telem = s.latest_telemetry.clone();
            let seq = s.last_sequence;
            let st = if seq != last_seq {
                last_seq = seq;
                Some(protocol::StateUpdate {
                    active_status: s.active_status.clone(),
                    orb_mode: s.orb_mode.clone(),
                    task_id: s.active_tasks.first().map(|t| t.task_id.clone()),
                    task_summary: s.active_tasks.first().map(|t| t.title.clone()),
                    sequence_number: seq,
                })
            } else {
                None
            };
            let alert = s.active_alerts.first().cloned();
            (telem, st, alert)
        };

        if let Some(t) = telemetry {
            let _ = proxy.send_event(HudAppEvent::IpcTelemetry(Box::new(t)));
        }
        if let Some(st) = state_update {
            let _ = proxy.send_event(HudAppEvent::IpcState(Box::new(st)));
        }
        if let Some(a) = alert {
            let _ = proxy.send_event(HudAppEvent::IpcAlert(Box::new(a)));
        }
    }

    #[allow(unreachable_code)]
    client_task.abort();
}

pub struct HotkeyThreadHandle {
    thread_id: u32,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl HotkeyThreadHandle {
    pub fn shutdown(&mut self) {
        if self.thread_id != 0 {
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
                use windows::Win32::Foundation::{LPARAM, WPARAM};
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for HotkeyThreadHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn spawn_global_panic_hotkey_thread(
    state: state::hud_state::SharedHudState,
    latch: Arc<state::NativeEmergencyStopLatch>,
    proxy: winit::event_loop::EventLoopProxy<HudAppEvent>,
    priority_tx: tokio::sync::mpsc::Sender<protocol::IpcEnvelope>,
    probe: Arc<state::liveness::LivenessProbe>,
) -> HotkeyThreadHandle {
    let (tx_tid, rx_tid) = std::sync::mpsc::channel();
    let state_clone = state.clone();

    let join_handle = std::thread::spawn(move || unsafe {
        use windows::Win32::System::Threading::GetCurrentThreadId;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_F12, VK_SPACE,
        };
        use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

        let tid = GetCurrentThreadId();
        let _ = tx_tid.send(tid);
        // Phase 7B.1a: the IPC task posts liveness probes here; answering them proves this message loop is pumping.
        probe.set_hotkey_thread(tid);

        const PANIC_HOTKEY_ID: i32 = 0x9001;

        // Dedicated global panic hotkey: Ctrl + Shift + F12
        let res = RegisterHotKey(
            None,
            PANIC_HOTKEY_ID,
            MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
            VK_F12.0 as u32,
        );

        let is_ok = res.is_ok();
        let reason_str = if is_ok {
            info!("[PANIC HOTKEY] Registered isolated global panic hotkey (Ctrl + Shift + F12) on background message loop.");
            "Registered isolated global panic hotkey (Ctrl + Shift + F12)".to_string()
        } else {
            let err_msg = format!("Failed to register global panic hotkey Ctrl+Shift+F12: {:?}", res);
            error!("[PANIC HOTKEY] {}", err_msg);
            err_msg
        };

        if !is_ok {
            // Fail-closed startup: If panic hotkey registration fails, latch emergency stop immediately!
            latch.trigger_stop(
                "PanicHotkeyRegistrationFailure",
                &format!("Fail-closed: Emergency panic hotkey registration failed ({})", reason_str),
                None,
            );
        }

        {
            let mut s = state_clone.lock().unwrap();
            s.panic_hotkey_registered = is_ok;
            s.panic_hotkey_error = if is_ok { None } else { Some(reason_str.clone()) };
            if !is_ok {
                s.is_emergency_stopped = true;
                s.active_status = "EmergencyStop".to_string();
                s.orb_mode = "Critical".to_string();
            }
        }

        // Overlay hotkeys. Ctrl+Shift+Space is avoided: VS Code-based editors use it, and a global hotkey would take it.
        const OVERLAY_TOGGLE_ID: i32 = 0x9002;
        const OVERLAY_HIDE_ID: i32 = 0x9003;
        let toggle_ok = RegisterHotKey(None, OVERLAY_TOGGLE_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_SPACE.0 as u32).is_ok();
        let hide_ok = RegisterHotKey(None, OVERLAY_HIDE_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x48).is_ok();
        if toggle_ok {
            info!("[OVERLAY] Registered Ctrl+Alt+Space (ambient / interactive).");
        } else {
            error!("[OVERLAY] Could not register Ctrl+Alt+Space; another application may own it.");
        }
        if hide_ok {
            info!("[OVERLAY] Registered Ctrl+Alt+H (hide / show).");
        } else {
            error!("[OVERLAY] Could not register Ctrl+Alt+H; another application may own it.");
        }
        let _ = proxy.send_event(HudAppEvent::OverlayHotkeysRegistered { toggle_ok, hide_ok });

        let notif = protocol::PanicHotkeyStatusNotification {
            is_available: is_ok,
            reason: reason_str,
            error_code: if is_ok { 0 } else { -1 },
            timestamp: chrono::Utc::now(),
        };

        if let Ok(env) = protocol::IpcEnvelope::new("PanicHotkeyStatusNotification", &notif, None) {
            let _ = priority_tx.try_send(env);
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == state::liveness::WM_LIVENESS_PROBE {
                probe.ack_hotkey(msg.wParam.0 as i64);
                continue;
            }
            if msg.message == WM_HOTKEY && msg.wParam.0 as i32 == OVERLAY_TOGGLE_ID {
                let _ = proxy.send_event(HudAppEvent::OverlayHotkeyPressed(OverlayHotkey::ToggleInteractive));
            } else if msg.message == WM_HOTKEY && msg.wParam.0 as i32 == OVERLAY_HIDE_ID {
                let _ = proxy.send_event(HudAppEvent::OverlayHotkeyPressed(OverlayHotkey::ToggleHidden));
            } else if msg.message == WM_HOTKEY && msg.wParam.0 as i32 == PANIC_HOTKEY_ID {
                warn!("[PANIC HOTKEY] >>> GLOBAL PANIC HOTKEY (Ctrl + Shift + F12) ACTIVATED <<<");

                // 1. Immediately set native thread-safe monotonic stop latch
                let (stop_req, gen, _is_new) = latch.trigger_stop(
                    "GlobalHotkey",
                    "Dedicated global panic hotkey Ctrl+Shift+F12 pressed",
                    None,
                );

                // 2. Update HUD visual state immediately
                {
                    let mut s = state_clone.lock().unwrap();
                    s.is_emergency_stopped = true;
                    s.stop_generation = gen;
                    s.active_status = "EmergencyStop".to_string();
                    s.orb_mode = "Critical".to_string();
                }

                // 3. Reliable delivery: Enqueue over bounded priority control channel (Non-blocking)
                if let Ok(env) = protocol::IpcEnvelope::new("EmergencyStopRequest", &stop_req, None) {
                    match priority_tx.try_send(env) {
                        Ok(_) => info!("[PANIC HOTKEY] EmergencyStopRequest sent via priority channel (StopId={}, Gen={}).", stop_req.stop_id, gen),
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                            warn!("[PANIC HOTKEY] Priority channel full; stop preserved in dedicated latch state.");
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            warn!("[PANIC HOTKEY] Priority channel closed; stop preserved in dedicated latch state.");
                        }
                    }
                }

                let _ = proxy.send_event(HudAppEvent::GlobalPanicStop);
            }
        }

        let _ = UnregisterHotKey(None, PANIC_HOTKEY_ID);
        let _ = UnregisterHotKey(None, OVERLAY_TOGGLE_ID);
        let _ = UnregisterHotKey(None, OVERLAY_HIDE_ID);
        info!("[PANIC HOTKEY] Panic hotkey unregistered and thread exiting cleanly.");
    });

    let thread_id = rx_tid.recv().unwrap_or(0);
    HotkeyThreadHandle {
        thread_id,
        join_handle: Some(join_handle),
    }
}

fn ctrlc_handler(tx: std::sync::mpsc::Sender<()>) {
    std::thread::spawn(move || {
        let _ = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(tokio::signal::ctrl_c());
        let _ = tx.send(());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hotkey_thread_handle_shutdown_and_drop() {
        let (tx, rx) = std::sync::mpsc::channel();
        let join_handle = std::thread::spawn(move || {
            let _ = rx.recv();
        });

        let mut handle = HotkeyThreadHandle {
            thread_id: 0,
            join_handle: Some(join_handle),
        };

        let _ = tx.send(());
        handle.shutdown();
        assert!(handle.join_handle.is_none(), "Join handle must be consumed on shutdown");
    }
}
