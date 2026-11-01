#![windows_subsystem = "windows"]

pub mod ipc;
pub mod render;
pub mod state;

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
    ActionApprovalDecision {
        approval_id: String,
        approved: bool,
        reason: Option<String>,
        parameters_sha256: Option<String>,
        action_id: Option<String>,
        action_type: Option<String>,
    },
    Ping,
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
    GlobalPanicStop,
    FrontendMessage(String),
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
    if clean == "api/assistant" {
        return Some((
            b"{\"reply\":\"D-ASK ONLINE\",\"actionType\":\"none\"}".to_vec(),
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
    let log_path = "d:\\D-ASK\\D-ASK\\scratch\\hud_trace.log";
    if let Ok(f) = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(log_path)
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
    let (client, outgoing_tx, priority_tx) = IpcClient::new(state.clone(), native_latch.clone(), event_proxy.clone());

    let mut hotkey_handle = if let Some(ref ep) = event_proxy {
        Some(spawn_global_panic_hotkey_thread(state.clone(), native_latch.clone(), ep.clone(), priority_tx.clone()))
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

    let window = Arc::new(
        WindowBuilder::new()
            .with_title("D-ASK Holographic Orb HUD")
            .with_position(LogicalPosition::new(100.0, 100.0))
            .with_inner_size(LogicalSize::new(1280.0, 800.0))
            .with_transparent(true)
            .with_decorations(false)
            .with_window_level(WindowLevel::AlwaysOnTop)
            .with_resizable(true)
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

    let root_path = resolve_root();
    info!("Resolved project root: {}", root_path.display());

    let proxy_for_ipc = event_proxy.clone();
    let root_for_protocol = root_path.clone();

    let webview_builder = wry::WebViewBuilder::new()
        .with_transparent(true)
        .with_background_color((0, 0, 0, 0))
        .with_custom_protocol("dask".into(), move |_id, req: Request<Vec<u8>>| {
            let path = req.uri().path();
            debug!("[CUSTOM PROTOCOL] Request: {}", path);

            if let Some((bytes, mime)) = serve_local_file(&root_for_protocol, path) {
                Response::builder()
                    .header("Content-Type", mime)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Cow::Owned(bytes))
                    .unwrap()
            } else {
                warn!("[CUSTOM PROTOCOL] 404 Not Found: {}", path);
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .header("Content-Type", "text/plain")
                    .body(Cow::Borrowed(b"404 Not Found" as &[u8]))
                    .unwrap()
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

    // Spawn IPC client and forward events to event_proxy
    let proxy_for_daemon = event_proxy.clone();
    let state_for_daemon = state.clone();
    rt.spawn(async move {
        // Run IPC client in background
        rt_daemon_bridge(client, state_for_daemon, proxy_for_daemon).await;
    });

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
            HudAppEvent::GlobalPanicStop => {
                let script = "if (window.__DASK_IPC_DISPATCH__) window.__DASK_IPC_DISPATCH__({type:'EmergencyStopTriggered',payload:{source:'GlobalHotkey'}});";
                let _ = webview.evaluate_script(script);
            }
            HudAppEvent::FrontendMessage(raw_msg) => {
                if raw_msg.len() > 65536 {
                    warn!("[IPC BRIDGE SECURITY] Discarded payload exceeding 64KB limit: {} bytes", raw_msg.len());
                    return;
                }
                debug!("[IPC BRIDGE] Frontend raw message: {}", raw_msg);
                match serde_json::from_str::<WebBridgeMessage>(&raw_msg) {
                    Ok(WebBridgeMessage::FrontendReady) => {
                        info!("[IPC BRIDGE] Frontend UI is ready and mounted");
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
                    Ok(WebBridgeMessage::ModelInference { prompt, task_id, max_tokens }) => {
                        if prompt.len() <= 8192 {
                            let tid = task_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                            let tokens = max_tokens.unwrap_or(256).clamp(1, 2048);
                            info!("[IPC BRIDGE] ModelInference requested: task_id={}, max_tokens={}", tid, tokens);
                            let req = serde_json::json!({
                                "taskId": tid,
                                "prompt": prompt,
                                "maxTokens": tokens,
                            });
                            if let Ok(envelope) = IpcEnvelope::new("ModelInferenceIpcRequest", &req, None) {
                                let _ = outgoing_tx_for_events.try_send(envelope);
                            }
                        } else {
                            warn!("[IPC BRIDGE SECURITY] Rejected oversized prompt in ModelInference: {} bytes", prompt.len());
                        }
                    }
                    Ok(WebBridgeMessage::UserCommand { text }) => {
                        info!("[IPC BRIDGE] User command dispatched: {}", text);
                        if let Ok(envelope) = IpcEnvelope::new(
                            "UserCommand",
                            &serde_json::json!({ "text": text }),
                            None,
                        ) {
                            let _ = outgoing_tx_for_events.try_send(envelope);
                        }
                    }
                    Ok(WebBridgeMessage::Approval { task_id, approved }) => {
                        info!(
                            "[IPC BRIDGE] Task approval: task_id={}, approved={}",
                            task_id, approved
                        );
                        if let Ok(envelope) = IpcEnvelope::new(
                            "TaskApproval",
                            &serde_json::json!({ "taskId": task_id, "approved": approved }),
                            None,
                        ) {
                            let _ = outgoing_tx_for_events.try_send(envelope);
                        }
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
                    Ok(WebBridgeMessage::EmergencyStop { reason }) => {
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
                    }) => {
                        info!(
                            "[IPC BRIDGE] Action approval decision: approval_id={}, approved={}",
                            approval_id, approved
                        );
                        let dec = protocol::ActionApprovalResponse {
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
                        warn!("[IPC BRIDGE] Discarding invalid bridge message: {} ({})", raw_msg, e);
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
            info!("HUD event loop exiting. Cleaning up panic hotkey thread...");
            if let Some(ref mut handle) = hotkey_handle {
                handle.shutdown();
            }
        }
        _ => {}
    })?;

    Ok(())
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
) -> HotkeyThreadHandle {
    let (tx_tid, rx_tid) = std::sync::mpsc::channel();
    let state_clone = state.clone();

    let join_handle = std::thread::spawn(move || unsafe {
        use windows::Win32::System::Threading::GetCurrentThreadId;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            RegisterHotKey, UnregisterHotKey, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_F12,
        };
        use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

        let tid = GetCurrentThreadId();
        let _ = tx_tid.send(tid);

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
            if msg.message == WM_HOTKEY && msg.wParam.0 as i32 == PANIC_HOTKEY_ID {
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
