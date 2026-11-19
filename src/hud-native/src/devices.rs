//! Phone discovery for the Hardware Matrix (the `/api/devices` answer of the HUD's custom protocol).
//!
//! The HUD used to answer `/api/devices` with a fixed "no phone" reply, so the matrix could never show a connected phone.
//! This module asks adb which Android devices are attached and answers in the shape the page already expects.
//!
//! Read-only: `adb devices -l`, `getprop` and `dumpsys battery`. Nothing here changes the phone. The scan runs on its own
//! thread every few seconds and the page's 2.5 s polling only reads the last result, so the web view never waits for adb.
//! adb is found through `DASK_AgentHost__AdbPath` (the same setting the daemon uses), then ANDROID_HOME, then the default
//! SDK folder, then PATH.
//!
//! `hasPhysicalDevice` is deliberately always false: the page uses that flag to treat ordinary words such as "open" or
//! "lock" as phone commands, which would break "open notepad". The matrix is driven by `devices`, not by that flag.

use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SCAN_EVERY: Duration = Duration::from_secs(3);

static CACHE: OnceLock<Mutex<String>> = OnceLock::new();
static SCANNER: OnceLock<()> = OnceLock::new();
/// The last screenshot taken from a phone: (serial, PNG bytes, taken-at ms). Kept in memory only and served to the page as
/// `/phone-screenshot.png`; it is never written anywhere (the temporary file used to pull it is deleted at once).
static SHOT: Mutex<Option<(String, Vec<u8>, u128)>> = Mutex::new(None);

/// What the page shows before the first scan has finished (and the old fixed reply).
fn empty_reply() -> String {
    // Nothing has been scanned yet, so no cause is claimed (an empty troubleshootStep shows no warning).
    let mut diagnostics = diagnostics_json(true, &adb_path().to_string_lossy(), &[]);
    diagnostics["troubleshootStep"] = json!("");
    json!({
        "success": true, "devices": [], "activeDevice": null, "totalConnected": 0, "hasPhysicalDevice": false,
        "diagnostics": diagnostics,
    }).to_string()
}

/// The page's panel already shows `diagnostics.troubleshootStep` ("DIAGNOSTIC: ...") when it is not empty. These are the fields of the
/// page's HardwareDiagnostics type; the one that matters is the sentence that names the cause.
fn diagnostics_json(adb_ok: bool, adb_path: &str, listed: &[Listed]) -> Value {
    let count = |state: &str| listed.iter().filter(|d| d.state == state).count();
    json!({
        "adbRunning": adb_ok,
        "adbPath": adb_path,
        "devicesFoundCount": listed.len(),
        "usbAttached": listed.iter().any(|d| !d.serial.contains(':')),
        "wirelessAttached": listed.iter().any(|d| d.serial.contains(':')),
        "unauthorizedCount": count("unauthorized"),
        "iphoneDetected": false,
        "troubleshootStep": troubleshoot(adb_ok, listed),
    })
}

/// One sentence naming why no phone is usable, or "" when at least one phone is ready (or while the very first scan is still running).
fn troubleshoot(adb_ok: bool, listed: &[Listed]) -> String {
    if !adb_ok {
        return "The HUD cannot start adb. Start D-ASK with Start-D-ASK.cmd (it sets where adb is), and check that adb.exe exists.".into();
    }
    if listed.iter().any(|d| d.state == "device") { return String::new(); }
    if listed.iter().any(|d| d.state == "unauthorized") {
        return "A phone is connected but has not allowed this PC. Unlock it and tap Allow on 'Allow USB debugging?' (tick Always allow). No prompt? In Developer options tap 'Revoke USB debugging authorizations', then unplug and replug.".into();
    }
    if listed.iter().any(|d| d.state == "offline") {
        return "adb lists the phone as offline. Unplug and replug it; if that does not help, run Check-Phone.cmd -RestartAdb.".into();
    }
    if listed.is_empty() {
        return "adb sees no phone. USB: use a data cable, set USB mode to File transfer and turn on USB debugging. Wi-Fi: Wireless debugging must be on and 'adb connect IP:PORT' must have said connected (the port changes each time it is switched on). Run Check-Phone.cmd to find out which.".into();
    }
    "adb lists a device in a state this panel does not recognise. Run Check-Phone.cmd.".into()
}

/// The latest scan result. The first call starts the background scanner.
pub fn json() -> String {
    SCANNER.get_or_init(|| {
        std::thread::spawn(|| {
            let mut last_seen: Vec<Value> = Vec::new();
            loop {
                let reply = scan(&mut last_seen);
                if let Some(cache) = CACHE.get() {
                    if let Ok(mut slot) = cache.lock() { *slot = reply; }
                }
                std::thread::sleep(SCAN_EVERY);
            }
        });
    });
    CACHE.get_or_init(|| Mutex::new(empty_reply())).lock().map(|s| s.clone()).unwrap_or_else(|_| empty_reply())
}

fn adb_path() -> PathBuf {
    if let Some(p) = std::env::var_os("DASK_AgentHost__AdbPath").filter(|p| !p.is_empty()) { return PathBuf::from(p); }
    if let Some(home) = std::env::var_os("ANDROID_HOME").or_else(|| std::env::var_os("ANDROID_SDK_ROOT")) {
        let p = PathBuf::from(home).join("platform-tools").join("adb.exe");
        if p.is_file() { return p; }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(local).join("Android").join("Sdk").join("platform-tools").join("adb.exe");
        if p.is_file() { return p; }
    }
    PathBuf::from("adb")
}

/// Runs adb with a time limit. Output goes to a temporary file, not a pipe: `adb devices` may start the adb server, which
/// keeps the handles it inherited open, and reading a pipe would then wait for the server instead of for adb.
fn run_adb(adb: &Path, args: &[&str], limit: Duration) -> Option<String> {
    let tmp = std::env::temp_dir().join(format!("dask-adb-{}.txt", uuid::Uuid::new_v4()));
    let out = std::fs::File::create(&tmp).ok()?;
    let spawned = Command::new(adb)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    // adb could not be started (wrong path, not installed): remove the empty output file, or one is left behind every scan.
    let mut child = match spawned { Ok(c) => c, Err(_) => { let _ = std::fs::remove_file(&tmp); return None; } };
    let started = Instant::now();
    let finished = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(25)),
            _ => break false,
        }
    };
    if !finished { let _ = child.kill(); let _ = child.wait(); }
    let text = std::fs::read(&tmp).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    let _ = std::fs::remove_file(&tmp);
    if finished { text } else { None }
}

struct Listed { serial: String, state: String, model: Option<String> }

/// Parses `adb devices -l`:  `61e93202   device product:CPH2467 model:CPH2467 device:OP5958L1 transport_id:1`
fn parse_devices(text: &str) -> Vec<Listed> {
    text.lines()
        .skip_while(|l| !l.starts_with("List of devices"))
        .skip(1)
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next()?.to_string();
            let model = parts.find_map(|t| t.strip_prefix("model:")).map(|m| m.replace('_', " "));
            Some(Listed { serial, state, model })
        })
        .collect()
}

struct Details { maker: String, model: String, release: String, level: Option<u32>, charging: bool }

fn read_details(adb: &Path, serial: &str) -> Details {
    let script = "getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; dumpsys battery";
    let text = run_adb(adb, &["-s", serial, "shell", script], Duration::from_secs(6)).unwrap_or_default();
    let mut lines = text.lines().map(str::trim);
    let maker = lines.next().unwrap_or("").to_string();
    let model = lines.next().unwrap_or("").to_string();
    let release = lines.next().unwrap_or("").to_string();
    let (mut level, mut charging) = (None, false);
    for l in lines {
        if let Some(v) = l.strip_prefix("level: ") { level = v.trim().parse::<u32>().ok(); }
        if let Some(v) = l.strip_prefix("status: ") { charging = v.trim() == "2"; }   // BATTERY_STATUS_CHARGING
    }
    Details { maker, model, release, level, charging }
}

fn device_json(serial: &str, status: &str, name: &str, model: &str, release: &str, level: u32, charging: bool) -> Value {
    json!({
        "id": serial,
        "name": name,
        "model": model,
        "os": "Android",
        "connectionType": if status != "CONNECTED" { "DISCONNECTED" } else if serial.contains(':') { "BLUETOOTH / WIRELESS" } else { "USB" },
        "status": status,
        "isLocked": false,
        "batteryLevel": level,
        "isCharging": charging,
        "currentApp": "",
        "bluetoothMac": "",
        "signalStrength": 0,
        "osVersion": if release.is_empty() { "Android".to_string() } else { format!("Android {release}") },
        "lastActive": chrono::Local::now().format("%H:%M:%S").to_string(),
        "isPhysical": true,
    })
}

/// The same devices, marked as no longer connected.
fn as_disconnected(devices: &[Value]) -> Vec<Value> {
    devices.iter().map(|v| {
        let mut v = v.clone();
        v["status"] = json!("DISCONNECTED");
        v["connectionType"] = json!("DISCONNECTED");
        v
    }).collect()
}

/// One scan. `last_seen` remembers the previous devices so that an unplugged phone is reported as DISCONNECTED instead of
/// simply vanishing (the page keeps its old list when it receives an empty one).
fn scan(last_seen: &mut Vec<Value>) -> String {
    let adb = adb_path();
    let listed_text = run_adb(&adb, &["devices", "-l"], Duration::from_secs(8));
    let adb_ok = listed_text.is_some();   // false: adb could not be started, or did not answer in time
    let listed = listed_text.map(|t| parse_devices(&t)).unwrap_or_default();
    let mut devices: Vec<Value> = Vec::new();
    for d in &listed {
        match d.state.as_str() {
            "device" => {
                let det = read_details(&adb, &d.serial);
                let model = if det.model.is_empty() { d.model.clone().unwrap_or_else(|| "Android phone".into()) } else { det.model.clone() };
                let name = if det.maker.is_empty() { model.clone() } else { format!("{} {}", det.maker, model) };
                devices.push(device_json(&d.serial, "CONNECTED", &name, &model, &det.release, det.level.unwrap_or(0), det.charging));
            }
            "unauthorized" => {
                let model = d.model.clone().unwrap_or_else(|| "Android phone".into());
                devices.push(device_json(&d.serial, "UNAUTHORIZED", &format!("{model} (allow USB debugging on the phone)"), &model, "", 0, false));
            }
            _ => {}
        }
    }
    if devices.is_empty() {
        devices = as_disconnected(last_seen);
    } else {
        *last_seen = devices.clone();
    }
    if let Ok(shot) = SHOT.lock() {
        if let Some((serial, _, at)) = shot.as_ref() {
            for d in devices.iter_mut() {
                if d["id"] == serial.as_str() { d["screenshotUrl"] = json!(format!("/phone-screenshot.png?t={at}")); }
            }
        }
    }
    let connected: Vec<&Value> = devices.iter().filter(|d| d["status"] == "CONNECTED").collect();
    json!({
        "success": true,
        "devices": devices,
        "activeDevice": connected.first().map(|d| (*d).clone()),
        "totalConnected": connected.len(),
        "hasPhysicalDevice": false,
        "diagnostics": diagnostics_json(adb_ok, &adb.to_string_lossy(), &listed),
    }).to_string()
}

// ── The panel's buttons ──────────────────────────────────────────────────────────────────────────────────────────────

/// The only actions the panel may run. Each maps to a fixed adb command below; the page never supplies a command line, a
/// package name or a path. (A click in the panel is the user's own action; there is no separate approval card here, unlike
/// requests typed into the console, which the daemon approves and audits.)
///
/// "pair_bluetooth" is replaced by two new actions:
///   "pair_discover"  – runs `adb mdns services` and returns the pairing / connect endpoints it finds (no phone touched, read-only).
///   "pair_connect"   – validates the 6-digit code and the pairing address, runs `adb pair`, polls for the connect endpoint,
///                      then runs `adb connect` and confirms with `adb devices -l`. Never stores or logs the code.
const ACTIONS: &[&str] = &[
    "lock", "unlock", "go_home", "home", "volume_up", "volume_down", "launch_app", "launch", "take_screenshot", "screenshot",
    "enable_tcpip", "pair_discover", "pair_connect",
];

/// Apps the buttons may open: (shell command, package to confirm in the foreground). A fixed list.
fn app_command(app: &str) -> Option<(&'static str, Option<&'static str>)> {
    match app.trim().to_lowercase().as_str() {
        "youtube" => Some(("monkey -p com.google.android.youtube -c android.intent.category.LAUNCHER 1", Some("com.google.android.youtube"))),
        "instagram" => Some(("monkey -p com.instagram.android -c android.intent.category.LAUNCHER 1", Some("com.instagram.android"))),
        "chrome" => Some(("monkey -p com.android.chrome -c android.intent.category.LAUNCHER 1", Some("com.android.chrome"))),
        "whatsapp" => Some(("monkey -p com.whatsapp -c android.intent.category.LAUNCHER 1", Some("com.whatsapp"))),
        "camera" => Some(("am start -a android.media.action.STILL_IMAGE_CAMERA", None)),
        "settings" => Some(("am start -a android.settings.SETTINGS", None)),
        _ => None,
    }
}

/// `192.168.1.5:5555`: four numbers 0-255 and a port; nothing else is ever handed to `adb connect`.
fn valid_host_port(s: &str) -> bool {
    let Some((host, port)) = s.trim().split_once(':') else { return false };
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.parse::<u8>().is_ok())
        && port.len() <= 5
        && port.parse::<u16>().map(|p| p > 0).unwrap_or(false)
}

fn shell(adb: &Path, serial: &str, cmd: &str, secs: u64) -> Option<String> {
    run_adb(adb, &["-s", serial, "shell", cmd], Duration::from_secs(secs))
}

/// Some(true) awake, Some(false) asleep, None unknown.
fn is_awake(adb: &Path, serial: &str) -> Option<bool> {
    let t = shell(adb, serial, "dumpsys power | grep mWakefulness", 5)?;
    if t.contains("mWakefulness=Asleep") || t.contains("mWakefulness=Dozing") { Some(false) }
    else if t.contains("mWakefulness=Awake") { Some(true) }
    else { None }
}

fn focus_text(adb: &Path, serial: &str) -> String {
    shell(adb, serial, "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'", 5).unwrap_or_default()
}

fn key(adb: &Path, serial: &str, code: &str) -> bool {
    shell(adb, serial, &format!("input keyevent {code}"), 5).is_some()
}

/// One action on one phone. Ok = what was done and whether it was confirmed; Err = what went wrong.
fn act(adb: &Path, serial: &str, name: &str, action: &str, body: &Value) -> Result<String, String> {
    let settle = |ms: u64| std::thread::sleep(Duration::from_millis(ms));
    match action {
        "lock" => {
            if !key(adb, serial, "223") { return Err(format!("{name}: LOCK FAILED (ADB DID NOT ANSWER)")); }
            settle(700);
            match is_awake(adb, serial) {
                Some(false) => Ok(format!("{name}: SCREEN OFF (CONFIRMED)")),
                Some(true) => Err(format!("{name}: LOCK WAS SENT BUT THE SCREEN IS STILL ON")),
                None => Ok(format!("{name}: LOCK SENT (NOT CONFIRMED)")),
            }
        }
        "unlock" => {
            if !key(adb, serial, "224") { return Err(format!("{name}: WAKE FAILED (ADB DID NOT ANSWER)")); }
            settle(700);
            match is_awake(adb, serial) {
                Some(true) => Ok(format!("{name}: SCREEN ON (CONFIRMED). A PIN OR PATTERN HAS TO BE ENTERED ON THE PHONE ITSELF")),
                Some(false) => Err(format!("{name}: WAKE WAS SENT BUT THE SCREEN IS STILL OFF")),
                None => Ok(format!("{name}: WAKE SENT (NOT CONFIRMED)")),
            }
        }
        "go_home" | "home" => {
            if !key(adb, serial, "3") { return Err(format!("{name}: HOME FAILED (ADB DID NOT ANSWER)")); }
            settle(800);
            if focus_text(adb, serial).to_lowercase().contains("launcher") { Ok(format!("{name}: HOME SCREEN (CONFIRMED)")) }
            else { Ok(format!("{name}: HOME KEY SENT (NOT CONFIRMED)")) }
        }
        "volume_up" | "volume_down" => {
            let up = action == "volume_up";
            if !key(adb, serial, if up { "24" } else { "25" }) { return Err(format!("{name}: VOLUME KEY FAILED (ADB DID NOT ANSWER)")); }
            Ok(format!("{name}: VOLUME {} KEY SENT (NOT CONFIRMED)", if up { "UP" } else { "DOWN" }))
        }
        "launch_app" | "launch" => {
            let app = body["targetApp"].as_str().or_else(|| body["app"].as_str()).unwrap_or("");
            let Some((cmd, package)) = app_command(app) else {
                return Err(format!("{name}: '{}' IS NOT ON THE ALLOWED APP LIST (YOUTUBE, INSTAGRAM, CHROME, WHATSAPP, CAMERA, SETTINGS)", app.to_uppercase()));
            };
            if shell(adb, serial, cmd, 8).is_none() { return Err(format!("{name}: OPENING {} FAILED (ADB DID NOT ANSWER)", app.to_uppercase())); }
            settle(1500);
            match package {
                Some(p) if focus_text(adb, serial).contains(p) => Ok(format!("{name}: {} OPEN IN THE FOREGROUND (CONFIRMED)", app.to_uppercase())),
                Some(_) => Err(format!("{name}: {} WAS STARTED BUT IS NOT IN THE FOREGROUND (INSTALLED? PHONE LOCKED?)", app.to_uppercase())),
                None => Ok(format!("{name}: {} REQUEST SENT (NOT CONFIRMED)", app.to_uppercase())),
            }
        }
        "take_screenshot" | "screenshot" => {
            // The screenshot stays on the PHONE, in Pictures/Screenshots, where the Gallery looks (the file name is fixed by this code:
            // "D-ASK_<date>_<time>.png"). A temporary copy is pulled only to show it in the panel and is deleted at once; nothing
            // is saved on this PC.
            let file = format!("D-ASK_{}.png", chrono::Local::now().format("%Y%m%d_%H%M%S"));
            let dir = "/sdcard/Pictures/Screenshots";
            let remote = format!("{dir}/{file}");
            let local = std::env::temp_dir().join(format!("dask-shot-{}.png", uuid::Uuid::new_v4()));
            let local_s = local.to_string_lossy().into_owned();
            let ok = shell(adb, serial, &format!("mkdir -p {dir}"), 5).is_some()
                && shell(adb, serial, &format!("screencap -p {remote}"), 10).is_some()
                && run_adb(adb, &["-s", serial, "pull", &remote, &local_s], Duration::from_secs(15)).is_some();
            let bytes = std::fs::read(&local).ok();
            let _ = std::fs::remove_file(&local);
            match bytes {
                Some(b) if ok && b.starts_with(&[0x89, b'P', b'N', b'G']) => {
                    // Ask Android's media scanner to index the new file so the Gallery lists it right away.
                    let _ = shell(adb, serial, &format!("am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://{remote}"), 8);
                    let on_phone = shell(adb, serial, &format!("ls -l {remote}"), 5).map(|t| t.contains(&file)).unwrap_or(false);
                    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                    if let Ok(mut slot) = SHOT.lock() { *slot = Some((serial.to_string(), b, at)); }
                    if on_phone {
                        Ok(format!("{name}: SCREENSHOT SAVED ON THE PHONE (PICTURES/SCREENSHOTS/{file}, CONFIRMED) AND SHOWN IN THE PANEL. OPEN THE GALLERY; IF IT IS NOT LISTED YET, REFRESH THE GALLERY"))
                    } else {
                        Ok(format!("{name}: SCREENSHOT SHOWN IN THE PANEL BUT NOT CONFIRMED ON THE PHONE (PICTURES/SCREENSHOTS/{file})"))
                    }
                }
                _ => Err(format!("{name}: SCREENSHOT FAILED (ADB DID NOT RETURN AN IMAGE)")),
            }
        }
        "enable_tcpip" => {
            let out = run_adb(adb, &["-s", serial, "tcpip", "5555"], Duration::from_secs(10)).unwrap_or_default();
            if !out.to_lowercase().contains("restarting in tcp mode") { return Err(format!("{name}: COULD NOT SWITCH ADB TO WI-FI ({})", out.trim().to_uppercase())); }
            let ip = shell(adb, serial, "ip -f inet addr show wlan0", 5).unwrap_or_default()
                .lines().find_map(|l| l.trim().strip_prefix("inet ").and_then(|r| r.split('/').next()).map(str::to_string));
            match ip {
                Some(ip) => Ok(format!("{name}: WI-FI ADB ENABLED ON PORT 5555. CONNECT TO {ip}:5555 (PHONE AND PC MUST BE ON THE SAME WI-FI)")),
                None => Ok(format!("{name}: WI-FI ADB ENABLED ON PORT 5555 (THE PHONE'S WI-FI ADDRESS WAS NOT FOUND: IS IT ON WI-FI?)")),
            }
        }
        _ => Err(format!("{name}: '{}' IS NOT AVAILABLE FROM THIS PANEL", action.to_uppercase())),
    }
}

fn fail(status: u16, message: &str) -> (u16, String) {
    (status, json!({ "success": false, "error": message }).to_string())
}

// ── mDNS service record helpers ──────────────────────────────────────────────────────────────────────────────────────

/// One line from `adb mdns services`:  `<name>\t_adb-tls-pairing._tcp\t<ip:port>`  or `..._adb-tls-connect._tcp...`.
/// Returns `(pairing_endpoints, connect_endpoints)` both as `ip:port` strings.
fn parse_mdns(text: &str) -> (Vec<String>, Vec<String>) {
    let mut pair_eps: Vec<String> = Vec::new();
    let mut conn_eps: Vec<String> = Vec::new();
    for line in text.lines() {
        // Columns are tab-separated in adb's output; any run of whitespace is accepted so a different adb build still parses.
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 { continue; }
        let svc = cols[cols.len() - 2];
        let ep = cols[cols.len() - 1];
        if !valid_host_port(ep) { continue; }   // skip malformed (headers, hostnames)
        if svc.contains("_adb-tls-pairing._tcp") {
            pair_eps.push(ep.to_string());
        } else if svc.contains("_adb-tls-connect._tcp") {
            conn_eps.push(ep.to_string());
        }
    }
    (pair_eps, conn_eps)
}

/// What `pair_connect` needs from the request, checked BEFORE adb is touched: the 6-digit code (trimmed) and the pairing address if the
/// caller gave one (an empty string means "discover it"). Err = (HTTP status, message).
fn pair_inputs(v: &Value) -> Result<(String, String), (u16, &'static str)> {
    let code = v["pairCode"].as_str().unwrap_or("").trim().to_string();
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err((400, "THE PAIRING CODE MUST BE EXACTLY 6 DIGITS (0-9). CHECK THE CODE SHOWN ON THE PHONE."));
    }
    let supplied = v["deviceIp"].as_str().unwrap_or("").trim().to_string();
    if !supplied.is_empty() && !valid_host_port(&supplied) {
        return Err((400, "THE PAIRING ADDRESS IS NOT A VALID IP:PORT. USE THE ADDRESS SHOWN IN THE 'PAIR DEVICE WITH PAIRING CODE' DIALOG, NOT THE MAIN WIRELESS DEBUGGING ADDRESS."));
    }
    Ok((code, supplied))
}

/// True when the address the caller typed is a phone's CONNECT address (the main Wireless debugging screen), which can never be paired.
fn is_connect_address(addr: &str, pair_eps: &[String], conn_eps: &[String]) -> bool {
    conn_eps.iter().any(|e| e == addr) && !pair_eps.iter().any(|e| e == addr)
}

/// One sentence for the HUD history line after "FIND PHONE" (the page shows `result` as is; without it the HUD prints a generic line).
fn describe_discovery(pair_eps: &[String], conn_eps: &[String]) -> String {
    if !pair_eps.is_empty() {
        format!("PAIRING DIALOG FOUND AT {}. TYPE THE 6-DIGIT CODE SHOWN ON THE PHONE AND PRESS PAIR AND CONNECT.", pair_eps.join(", "))
    } else if !conn_eps.is_empty() {
        format!("A PHONE IS ADVERTISING WIRELESS DEBUGGING AT {} BUT NO PAIRING DIALOG IS OPEN. TO PAIR IT, OPEN 'PAIR DEVICE WITH PAIRING CODE' ON THE PHONE.", conn_eps.join(", "))
    } else {
        "NO PHONE FOUND ON THE NETWORK. TURN ON WIRELESS DEBUGGING, OPEN 'PAIR DEVICE WITH PAIRING CODE' ON THE PHONE AND KEEP IT OPEN. BOTH DEVICES MUST BE ON THE SAME WI-FI.".to_string()
    }
}

/// Extract just the IP part from "ip:port".
fn ip_of(ep: &str) -> &str {
    ep.split(':').next().unwrap_or(ep)
}

/// POST /api/devices from the panel's buttons. Returns (HTTP status, JSON body). Blocking: call it off the UI thread.
pub fn control(body: &[u8]) -> (u16, String) {
    let Ok(v) = serde_json::from_slice::<Value>(body) else { return fail(400, "BAD REQUEST: THE BODY IS NOT JSON") };
    let action = v["action"].as_str().unwrap_or("").to_lowercase();
    if !ACTIONS.contains(&action.as_str()) {
        return fail(501, &format!("'{}' IS NOT AVAILABLE FROM THIS PANEL. TYPE A REQUEST INSTEAD, E.G. 'RAISE THE VOLUME ON MY PHONE'.", action.to_uppercase()));
    }
    let adb = adb_path();

    // ── pair_discover: scan adb mdns services and return what it finds (no adb pair / connect yet) ──────────────────
    if action == "pair_discover" {
        let raw = run_adb(&adb, &["mdns", "services"], Duration::from_secs(8)).unwrap_or_default();
        let (pair_eps, conn_eps) = parse_mdns(&raw);
        let result = describe_discovery(&pair_eps, &conn_eps);
        return (200, json!({
            "success": true,
            "result": result,
            "pairingEndpoints": pair_eps,
            "connectEndpoints": conn_eps,
            "rawOutput": raw.trim(),
        }).to_string());
    }

    // ── pair_connect: validate code + address, pair, then connect ────────────────────────────────────────────────────
    if action == "pair_connect" {
        // 1. Validate the 6-digit pairing code and the (optional) pairing address. The code is used only as an argument and is never
        //    logged or stored. All of this happens before adb is touched.
        let (pair_code, supplied) = match pair_inputs(&v) { Ok(x) => x, Err((status, message)) => return fail(status, message) };

        // 2. Determine the pairing endpoint (ip:pairport). Not supplied: discover it; never guess when there are several.
        let raw = run_adb(&adb, &["mdns", "services"], Duration::from_secs(8)).unwrap_or_default();
        let (pair_eps, conn_eps) = parse_mdns(&raw);
        let pair_ep: String = if !supplied.is_empty() {
            if is_connect_address(&supplied, &pair_eps, &conn_eps) {
                return fail(409, &format!("{} IS THE CONNECT ADDRESS (THE MAIN WIRELESS DEBUGGING SCREEN). PAIRING NEEDS THE ADDRESS SHOWN INSIDE THE 'PAIR DEVICE WITH PAIRING CODE' DIALOG, WHICH IS A DIFFERENT PORT.", supplied));
            }
            supplied
        } else {
            match pair_eps.len() {
                0 => return fail(404, "NO WIRELESS DEBUGGING PAIRING DIALOG FOUND. OPEN DEVELOPER OPTIONS > WIRELESS DEBUGGING > 'PAIR DEVICE WITH PAIRING CODE' ON THE PHONE FIRST AND KEEP IT OPEN, THEN TRY AGAIN."),
                1 => pair_eps.into_iter().next().unwrap(),
                _ => return fail(409, &format!("MORE THAN ONE PHONE IS SHOWING A PAIRING DIALOG ({}). CLOSE THE OTHERS SO THE RIGHT ONE IS CHOSEN.", pair_eps.join(", "))),
            }
        };

        // 3. Run `adb pair <ip:pairport> <code>`.  The code is passed as a separate argument so it never touches a shell.
        let pair_out = match run_adb(&adb, &["pair", &pair_ep, &pair_code], Duration::from_secs(25)) {
            Some(o) => o,
            None => return fail(504, "THE PAIRING COMMAND DID NOT FINISH IN TIME. MAKE SURE THE PHONE'S 'PAIR WITH PAIRING CODE' DIALOG IS STILL OPEN AND TRY AGAIN."),
        };
        // Check adb's real output.
        if !pair_out.to_lowercase().contains("successfully paired") {
            // Detect the common mistake: the user gave the main wireless-debugging address (connect port) instead of the
            // pairing-dialog address.  The pairing endpoint shows a different port each time; the connect endpoint is
            // persistent and usually 5-digit.  `adb pair` on the connect port produces "failed to pair" or "error".
            let hint = if pair_out.to_lowercase().contains("failed") || pair_out.to_lowercase().contains("error") {
                " (HINT: IF YOU TYPED AN IP:PORT YOURSELF, MAKE SURE IT IS FROM THE 'PAIR DEVICE WITH PAIRING CODE' DIALOG, NOT THE MAIN WIRELESS DEBUGGING SCREEN — THOSE ARE DIFFERENT PORTS.)"
            } else { "" };
            return fail(502, &format!("PAIRING FAILED: {}{}", pair_out.trim().to_uppercase(), hint));
        }

        // 4. Poll `adb mdns services` for up to ~10 s for a _adb-tls-connect._tcp endpoint on the same IP.
        let pair_ip = ip_of(&pair_ep).to_string();
        let connect_ep: Option<String> = {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut found = None;
            while Instant::now() < deadline {
                let raw = run_adb(&adb, &["mdns", "services"], Duration::from_secs(5)).unwrap_or_default();
                let (_, conn_eps) = parse_mdns(&raw);
                if let Some(ep) = conn_eps.into_iter().find(|ep| ip_of(ep) == pair_ip) {
                    found = Some(ep);
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            found
        };
        let connect_ep = match connect_ep {
            Some(ep) => ep,
            None => return fail(504, &format!(
                "PAIRED SUCCESSFULLY BUT COULD NOT FIND A WIRELESS DEBUGGING CONNECT ENDPOINT FOR {} WITHIN 10 SECONDS. \
                 CHECK THAT WIRELESS DEBUGGING IS STILL ENABLED ON THE PHONE AND TRY THE BUTTON AGAIN.",
                pair_ip
            )),
        };

        // 5. Run `adb connect <ip:connectport>`.
        let conn_out = run_adb(&adb, &["connect", &connect_ep], Duration::from_secs(12)).unwrap_or_default();
        let conn_low = conn_out.to_lowercase();
        if !conn_low.contains("connected to") || conn_low.contains("failed") || conn_low.contains("cannot") {
            return fail(502, &format!("PAIRED BUT CONNECT FAILED: {}", conn_out.trim().to_uppercase()));
        }

        // 6. Confirm with `adb devices -l` that the serial shows up as "device".
        let devs_out = run_adb(&adb, &["devices", "-l"], Duration::from_secs(8)).unwrap_or_default();
        let confirmed = parse_devices(&devs_out).iter().any(|d| d.serial == connect_ep && d.state == "device");

        // The code is now out of scope and will be dropped; it was never written to any log or file.
        return if confirmed {
            (200, json!({
                "success": true,
                "result": format!("PAIRED AND CONNECTED TO {} OVER WI-FI (CONFIRMED)", connect_ep),
                "connectedTo": connect_ep,
            }).to_string())
        } else {
            (200, json!({
                "success": true,
                "result": format!("PAIRED AND CONNECT COMMAND SENT TO {} — adb devices DID NOT YET CONFIRM IT AS 'device'. WAIT A MOMENT AND CHECK THE PANEL.", connect_ep),
                "connectedTo": connect_ep,
            }).to_string())
        };
    }

    let listed = run_adb(&adb, &["devices", "-l"], Duration::from_secs(8)).map(|t| parse_devices(&t)).unwrap_or_default();
    let mut targets: Vec<&Listed> = listed.iter().filter(|d| d.state == "device").collect();
    if let Some(only) = v["targetDeviceId"].as_str().filter(|s| !s.is_empty()) {
        if !v["broadcastAll"].as_bool().unwrap_or(false) { targets.retain(|d| d.serial == only); }
    }
    if targets.is_empty() {
        return fail(404, "NO CONNECTED PHONE FOUND. PLUG IN THE USB CABLE AND ALLOW USB DEBUGGING ON THE PHONE.");
    }
    let mut ok_lines = Vec::new();
    let mut bad_lines = Vec::new();
    for d in targets {
        let name = d.model.clone().unwrap_or_else(|| d.serial.clone());
        match act(&adb, &d.serial, &name, &action, &v) {
            Ok(m) => ok_lines.push(m),
            Err(e) => bad_lines.push(e),
        }
    }
    let mut all = ok_lines.clone();
    all.extend(bad_lines.iter().cloned());
    let summary = all.join(" · ");
    if ok_lines.is_empty() { return fail(502, &summary); }
    let mut reply = json!({ "success": true, "result": summary });
    if let Ok(shot) = SHOT.lock() {
        if let Some((_, _, at)) = shot.as_ref() { reply["screenshotUrl"] = json!(format!("/phone-screenshot.png?t={at}")); }
    }
    (200, reply.to_string())
}

/// The last screenshot taken from a phone (PNG), if any.
pub fn screenshot_png() -> Option<Vec<u8>> {
    SHOT.lock().ok().and_then(|s| s.as_ref().map(|(_, b, _)| b.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_apps_can_be_opened() {
        assert!(app_command("YouTube").is_some());
        assert!(app_command(" camera ").is_some());
        assert!(app_command("com.evil.app").is_none());
        assert!(app_command("youtube; rm -rf /sdcard").is_none());
        assert!(app_command("").is_none());
    }

    #[test]
    fn connect_targets_must_be_ip_and_port() {
        assert!(valid_host_port("192.168.1.5:5555"));
        assert!(valid_host_port(" 10.0.0.2:38765 "));
        assert!(!valid_host_port("192.168.1.5"));
        assert!(!valid_host_port("192.168.1.5:0"));
        assert!(!valid_host_port("192.168.1.256:5555"));
        assert!(!valid_host_port("host.example.com:5555"));
        assert!(!valid_host_port("192.168.1.5:5555 -x"));
        assert!(!valid_host_port("192.168.1.5:5555;calc"));
    }

    // ── pair_discover ──────────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn mdns_output_parses_pairing_and_connect_lines() {
        // adb mdns services uses TAB-separated columns: name \t service-type \t ip:port
        let raw = "adb-12345-pairing\t_adb-tls-pairing._tcp\t192.168.1.5:38765\nadb-12345-connect\t_adb-tls-connect._tcp\t192.168.1.5:5555\n";
        let (pair_eps, conn_eps) = parse_mdns(raw);
        assert_eq!(pair_eps, vec!["192.168.1.5:38765"]);
        assert_eq!(conn_eps, vec!["192.168.1.5:5555"]);
    }

    #[test]
    fn mdns_parser_ignores_lines_with_bad_endpoints() {
        let raw = "adb-x\t_adb-tls-pairing._tcp\tnot-an-ip\nadb-y\t_adb-tls-connect._tcp\t10.0.0.1:5555\n";
        let (pair_eps, conn_eps) = parse_mdns(raw);
        assert!(pair_eps.is_empty(), "malformed endpoint should be dropped");
        assert_eq!(conn_eps, vec!["10.0.0.1:5555"]);
    }

    #[test]
    fn mdns_parser_handles_empty_and_header_only_output() {
        let (p, c) = parse_mdns("");
        assert!(p.is_empty() && c.is_empty());
        // adb sometimes prints a header line before the records
        let (p2, c2) = parse_mdns("List of mDNS services\n");
        assert!(p2.is_empty() && c2.is_empty());
    }

    // ── pair_connect input validation (all checks happen BEFORE adb is touched) ────────────────────────────────────

    // The next tests never touch adb, the phone or the network.

    #[test]
    fn pair_inputs_accept_exactly_six_digits_and_trim_spaces() {
        let check = |code: &str, ip: &str| pair_inputs(&json!({ "pairCode": code, "deviceIp": ip }));
        assert_eq!(check("123456", "").unwrap(), ("123456".to_string(), String::new()));
        assert_eq!(check(" 492817 ", " 192.168.1.5:38765 ").unwrap(), ("492817".to_string(), "192.168.1.5:38765".to_string()));
        for bad in ["", "12345", "1234567", "12345a", "abcdef", "12 456"] {
            let e = check(bad, "").unwrap_err();
            assert_eq!(e.0, 400, "{bad:?}");
            assert!(e.1.contains("6 DIGITS"), "{bad:?}");
        }
        assert_eq!(pair_inputs(&json!({ "action": "pair_connect" })).unwrap_err().0, 400);   // no code at all
    }

    #[test]
    fn pair_inputs_refuse_a_bad_pairing_address() {
        for bad_ip in ["evil; calc", "192.168.1.256:38765", "192.168.1.5", "192.168.1.5:0", "hostname:38765", "192.168.1.5:38765 -x"] {
            let e = pair_inputs(&json!({ "pairCode": "123456", "deviceIp": bad_ip })).unwrap_err();
            assert_eq!(e.0, 400, "{bad_ip:?}");
            assert!(e.1.contains("IP:PORT"), "{bad_ip:?}");
        }
    }

    #[test]
    fn control_refuses_bad_pairing_input_before_touching_adb() {
        // Validation comes first, so these never start adb.
        let (status, body) = control(br#"{"action":"pair_connect","pairCode":"12345"}"#);
        assert_eq!(status, 400);
        assert!(body.contains("6 DIGITS"));
        assert_eq!(control(br#"{"action":"pair_connect","pairCode":"123456","deviceIp":"evil; calc"}"#).0, 400);
    }

    #[test]
    fn a_connect_address_is_never_accepted_for_pairing() {
        let pair = vec!["10.89.22.81:37499".to_string()];
        let conn = vec!["10.89.22.81:44643".to_string()];
        assert!(is_connect_address("10.89.22.81:44643", &pair, &conn));
        assert!(!is_connect_address("10.89.22.81:37499", &pair, &conn));
        assert!(!is_connect_address("10.89.22.81:1111", &pair, &conn));
    }

    #[test]
    fn find_phone_says_what_was_found() {
        let pair = vec!["10.89.22.81:37499".to_string()];
        let conn = vec!["10.89.22.81:44643".to_string()];
        let found = describe_discovery(&pair, &conn);
        assert!(found.contains("37499") && found.contains("6-DIGIT"));
        assert!(describe_discovery(&[], &conn).contains("NO PAIRING DIALOG"));
        assert!(describe_discovery(&[], &[]).contains("NO PHONE FOUND"));
    }

    #[test]
    fn mdns_lines_parse_with_tabs_as_adb_prints_them_and_with_spaces() {
        // the real output seen on this PC (tabs), and the same text with spaces
        let tabs = "List of discovered mdns services
adb-10BFCF0N9C005NX-KDu5iQ	_adb-tls-pairing._tcp	10.89.22.81:39011
adb-10BFCF0N9C005NX-KDu5iQ	_adb-tls-connect._tcp	10.89.22.81:44643
";
        let spaces = tabs.replace("	", "   ");
        for raw in [tabs.to_string(), spaces] {
            let (p, c) = parse_mdns(&raw);
            assert_eq!(p, vec!["10.89.22.81:39011"]);
            assert_eq!(c, vec!["10.89.22.81:44643"]);
        }
    }

    #[test]
    fn ip_extraction_works_for_valid_endpoints() {
        assert_eq!(ip_of("192.168.1.5:38765"), "192.168.1.5");
        assert_eq!(ip_of("10.0.0.2:5555"), "10.0.0.2");
    }

    #[test]
    fn connect_endpoint_matching_uses_same_ip_as_pairing_endpoint() {
        // Simulate two connect endpoints; only the one on the pairing IP should be chosen.
        let raw_mdns = "a\t_adb-tls-connect._tcp\t192.168.1.5:5555\nb\t_adb-tls-connect._tcp\t10.0.0.9:5555\n";
        let (_, conn_eps) = parse_mdns(raw_mdns);
        let pair_ip = "192.168.1.5";
        let matched: Vec<_> = conn_eps.into_iter().filter(|ep| ip_of(ep) == pair_ip).collect();
        assert_eq!(matched, vec!["192.168.1.5:5555"]);
    }

    #[test]
    fn unlisted_actions_are_refused_before_adb_is_touched() {
        for a in ["format_phone", "shell", "add_device", "install", "", "pair_bluetooth"] {
            let (status, body) = control(format!(r#"{{"action":"{a}"}}"#).as_bytes());
            assert_eq!(status, 501, "{a}");
            assert!(body.contains("NOT AVAILABLE"), "{a}");
        }
        assert_eq!(control(b"not json").0, 400);
    }

    /// Needs a real phone: `cargo test devices::tests::live_buttons -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_buttons() {
        for a in [r#"{"action":"volume_down"}"#, r#"{"action":"volume_up"}"#, r#"{"action":"take_screenshot"}"#, r#"{"action":"launch_app","targetApp":"settings"}"#, r#"{"action":"go_home"}"#, r#"{"action":"launch_app","targetApp":"notallowed"}"#] {
            let (status, body) = control(a.as_bytes());
            println!("{status} {a}\n   -> {body}");
        }
        let png = screenshot_png();
        println!("screenshot bytes: {:?}", png.as_ref().map(|b| b.len()));
    }

    #[test]
    fn parses_the_adb_device_list() {
        let text = "List of devices attached\n61e93202               device product:CPH2467 model:CPH2467 device:OP5958L1 transport_id:1\n192.168.1.5:5555\tunauthorized transport_id:2\n\n";
        let d = parse_devices(text);
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].serial.as_str(), d[0].state.as_str(), d[0].model.as_deref()), ("61e93202", "device", Some("CPH2467")));
        assert_eq!((d[1].serial.as_str(), d[1].state.as_str()), ("192.168.1.5:5555", "unauthorized"));
    }

    #[test]
    fn nothing_listed_means_no_devices() {
        assert!(parse_devices("List of devices attached\n\n").is_empty());
        assert!(parse_devices("").is_empty());
    }

    #[test]
    fn an_unplugged_phone_is_reported_disconnected_not_dropped() {
        let phone = device_json("61e93202", "CONNECTED", "OnePlus CPH2467", "CPH2467", "15", 59, true);
        assert_eq!(phone["connectionType"], "USB");
        assert_eq!(phone["name"], "OnePlus CPH2467");
        let gone = as_disconnected(&[phone]);
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0]["status"], "DISCONNECTED");
        assert_eq!(gone[0]["connectionType"], "DISCONNECTED");
        assert_eq!(gone[0]["batteryLevel"], 59);
    }

    /// Needs a real phone and adb: `cargo test devices::tests::live_scan -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_scan() {
        let mut seen = Vec::new();
        let reply: Value = serde_json::from_str(&scan(&mut seen)).unwrap();
        println!("{}", serde_json::to_string_pretty(&reply).unwrap());
        assert!(reply["totalConnected"].as_u64().unwrap_or(0) >= 1, "no connected phone found");
        assert_eq!(reply["hasPhysicalDevice"], false);
    }

    fn listed(state: &str) -> Listed { Listed { serial: "ABC123".into(), state: state.into(), model: None } }

    #[test]
    fn the_panel_is_told_why_no_phone_is_usable() {
        // adb itself could not run: the fix is how D-ASK was started
        assert!(troubleshoot(false, &[]).contains("Start-D-ASK.cmd"));
        // adb runs but lists nothing
        let none = troubleshoot(true, &[]);
        assert!(none.contains("data cable") && none.contains("Wireless debugging"));
        // a new phone that has not been allowed yet: the most common first-connection case
        let unauth = troubleshoot(true, &[listed("unauthorized")]);
        assert!(unauth.contains("Allow") && unauth.contains("Revoke USB debugging authorizations"));
        assert!(troubleshoot(true, &[listed("offline")]).contains("offline"));
        assert!(troubleshoot(true, &[listed("something-new")]).contains("does not recognise"));
        // a usable phone: no warning, even if another one is still unauthorized
        assert_eq!(troubleshoot(true, &[listed("device")]), "");
        assert_eq!(troubleshoot(true, &[listed("unauthorized"), listed("device")]), "");
    }

    #[test]
    fn diagnostics_carry_the_fields_the_page_expects() {
        let d = diagnostics_json(true, "C:\\x\\adb.exe", &[Listed { serial: "192.168.1.5:5555".into(), state: "unauthorized".into(), model: None }]);
        for key in ["adbRunning", "adbPath", "devicesFoundCount", "usbAttached", "wirelessAttached", "unauthorizedCount", "iphoneDetected", "troubleshootStep"] {
            assert!(d.get(key).is_some(), "{key}");
        }
        assert_eq!(d["wirelessAttached"], true);
        assert_eq!(d["usbAttached"], false);
        assert_eq!(d["unauthorizedCount"], 1);
        let first: Value = serde_json::from_str(&empty_reply()).unwrap();
        assert_eq!(first["diagnostics"]["troubleshootStep"], "");   // nothing is claimed before the first scan has finished
    }

    #[test]
    fn a_wifi_serial_is_a_wireless_connection() {
        assert_eq!(device_json("192.168.1.5:5555", "CONNECTED", "x", "x", "15", 1, false)["connectionType"], "BLUETOOTH / WIRELESS");
    }

    #[test]
    fn the_flag_that_enables_local_phone_commands_stays_false() {
        let reply: Value = serde_json::from_str(&empty_reply()).unwrap();
        assert_eq!(reply["hasPhysicalDevice"], false);
    }
}
