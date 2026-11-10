//! Phase 4B-1R.8 (H3): verify WHO answered the pipe before a single byte (including the handshake) is sent.
//!
//! Limits (do not oversell): an exact-image-path allowlist is defense-in-depth. It does NOT stop same-user
//! malware, code injected into the allowed daemon, or replacement of the daemon executable in a
//! user-writable directory. The pipe name is a fixed well-known constant, so identity of the answering
//! process is the only thing the host can check.

use std::ffi::c_void;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_TIMEOUT};
use windows::Win32::Security::{EqualSid, GetTokenInformation, TokenUser, PSID, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::System::Pipes::{GetNamedPipeServerProcessId, PeekNamedPipe};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};

/// Facts gathered about the pipe server, separated from the decision so the policy is unit-testable.
#[derive(Debug, Clone)]
pub struct PeerSnapshot {
    pub pid: u32,
    /// The pipe still reports the same server PID after we hold a handle to that process.
    pub pid_stable_after_handle_open: bool,
    pub exited: bool,
    pub pipe_connected: bool,
    /// Process creation time as a FILETIME (100ns ticks since 1601); 0 when unknown.
    pub creation_filetime: u64,
    /// Same user SID as this process; None when it could not be determined.
    pub same_user: Option<bool>,
    pub session_id: Option<u32>,
    /// Canonicalized image path of the server process.
    pub image_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PeerExpectation {
    pub session_id: u32,
    /// Canonicalized (verbatim, lowercased) allowed image paths.
    pub allowed_images: Vec<String>,
    /// FILETIME taken BEFORE the open call. The server existed when the open succeeded, so it was created
    /// before this moment; a PID-reuse successor can only have been created after the original exited.
    pub connect_started_filetime: u64,
}

/// Pure decision function. `Ok(())` means acceptable; `Err` carries the reason (always fail closed).
pub fn evaluate(s: &PeerSnapshot, e: &PeerExpectation) -> Result<(), String> {
    if e.allowed_images.is_empty() {
        return Err("no allowed daemon image paths are resolvable (fail closed)".into());
    }
    if s.pid == 0 {
        return Err("pipe server PID unavailable".into());
    }
    if !s.pid_stable_after_handle_open {
        return Err("pipe server PID changed while opening the process (race)".into());
    }
    if s.exited {
        return Err("pipe server process has already exited (PID may be reused)".into());
    }
    if !s.pipe_connected {
        return Err("pipe is no longer connected after the process handle was acquired".into());
    }
    if s.creation_filetime == 0 {
        return Err("pipe server process creation time unavailable".into());
    }
    if s.creation_filetime > e.connect_started_filetime {
        return Err("pipe server process was created after the connection attempt began (PID reuse)".into());
    }
    match s.same_user {
        Some(true) => {}
        Some(false) => return Err("pipe server runs as a different user".into()),
        None => return Err("pipe server user could not be determined".into()),
    }
    match s.session_id {
        Some(id) if id == e.session_id => {}
        Some(id) => return Err(format!("pipe server is in a different logon session ({id})")),
        None => return Err("pipe server session could not be determined".into()),
    }
    let image = s.image_path.as_deref().ok_or("pipe server image path unavailable")?;
    if !e.allowed_images.iter().any(|a| a == &image.to_lowercase()) {
        return Err(format!("pipe server image '{image}' is not in the allowed daemon list"));
    }
    Ok(())
}

/// Which daemon executables the host will talk to.
#[derive(Debug, Clone)]
pub struct ServerPolicy {
    allowed: Vec<PathBuf>,
}

impl ServerPolicy {
    /// The only constructor available outside tests: derives exact daemon paths from this executable's
    /// location in the repository layout. If none exist, nothing is accepted.
    pub fn production() -> Self {
        Self { allowed: default_allowed_daemon_paths() }
    }

    #[cfg(test)]
    pub fn allow_only(paths: Vec<PathBuf>) -> Self {
        Self { allowed: paths }
    }

    fn canonical_allowed(&self) -> Vec<String> {
        self.allowed.iter().filter_map(|p| canonical_lower(p)).collect()
    }
}

/// `<root>/src/hud-native/target/<profile>/hud-native.exe` -> `<root>/src/DAsk.Daemon/bin/{Debug,Release}/net8.0/DAsk.Daemon.exe`
pub fn default_allowed_daemon_paths() -> Vec<PathBuf> {
    let Ok(exe) = std::env::current_exe() else { return Vec::new() };
    for ancestor in exe.ancestors() {
        if ancestor.file_name().map(|n| n == "hud-native").unwrap_or(false) {
            if let Some(src) = ancestor.parent() {
                return ["Debug", "Release"]
                    .iter()
                    .map(|cfg| src.join("DAsk.Daemon").join("bin").join(cfg).join("net8.0").join("DAsk.Daemon.exe"))
                    .collect();
            }
        }
    }
    Vec::new()
}

/// Resolves symlinks/junctions/casing to one canonical form; None when the file does not exist.
fn canonical_lower(p: &Path) -> Option<String> {
    std::fs::canonicalize(p).ok().map(|c| c.to_string_lossy().to_lowercase())
}

/// FILETIME "now" (100ns ticks since 1601-01-01 UTC) without extra Win32 features.
pub fn now_filetime() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    const UNIX_TO_FILETIME_SECS: u64 = 11_644_473_600;
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (d.as_secs() + UNIX_TO_FILETIME_SECS) * 10_000_000 + (d.subsec_nanos() as u64) / 100
}

/// A server that passed verification. Holding the process handle prevents its PID from being reused.
#[derive(Debug)]
pub struct VerifiedServer {
    pub pid: u32,
    pub image_path: String,
    _process: OwnedHandle,
}

#[derive(Debug)]
struct OwnedHandle(HANDLE);

// A Win32 process/token handle is a kernel object reference with no thread affinity, so owning it on a
// different thread than the one that opened it is sound. Needed because the verified server is held across
// `.await` points of the connection task.
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// Verifies the process serving `pipe`. `connect_started_filetime` must be taken before the open call.
pub fn verify_server(
    pipe: &impl AsRawHandle,
    connect_started_filetime: u64,
    policy: &ServerPolicy,
) -> Result<VerifiedServer, String> {
    let pipe_handle = HANDLE(pipe.as_raw_handle());
    let allowed = policy.canonical_allowed();
    if allowed.is_empty() {
        return Err("no allowed daemon image paths are resolvable (fail closed)".into());
    }

    unsafe {
        let mut pid = 0u32;
        GetNamedPipeServerProcessId(pipe_handle, &mut pid)
            .map_err(|e| format!("GetNamedPipeServerProcessId failed: {e}"))?;
        if pid == 0 {
            return Err("pipe server PID unavailable".into());
        }

        let raw = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid)
            .map_err(|e| format!("OpenProcess({pid}) failed: {e}"))?;
        let process = OwnedHandle(raw);

        // From here the handle pins the PID.
        let mut pid_again = 0u32;
        let stable = GetNamedPipeServerProcessId(pipe_handle, &mut pid_again).is_ok() && pid_again == pid;
        let exited = WaitForSingleObject(raw, 0) != WAIT_TIMEOUT;
        let creation = creation_filetime(raw);
        let image = image_path(raw).and_then(|p| canonical_lower(Path::new(&p)));
        let same_user = same_user_as_self(raw);
        let mut session = 0u32;
        let session_id = ProcessIdToSessionId(pid, &mut session).ok().map(|_| session);
        let connected = PeekNamedPipe(pipe_handle, None, 0, None, None, None).is_ok();

        let mut my_session = 0u32;
        ProcessIdToSessionId(GetCurrentProcessId(), &mut my_session)
            .map_err(|e| format!("cannot determine own session: {e}"))?;

        let snapshot = PeerSnapshot {
            pid,
            pid_stable_after_handle_open: stable,
            exited,
            pipe_connected: connected,
            creation_filetime: creation,
            same_user,
            session_id,
            image_path: image.clone(),
        };
        evaluate(
            &snapshot,
            &PeerExpectation {
                session_id: my_session,
                allowed_images: allowed,
                connect_started_filetime,
            },
        )?;

        Ok(VerifiedServer { pid, image_path: image.unwrap_or_default(), _process: process })
    }
}

unsafe fn creation_filetime(process: HANDLE) -> u64 {
    let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    if GetProcessTimes(process, &mut c, &mut e, &mut k, &mut u).is_ok() {
        ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64
    } else {
        0
    }
}

unsafe fn image_path(process: HANDLE) -> Option<String> {
    let mut buf = vec![0u16; 1024];
    let mut size = buf.len() as u32;
    QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).ok()?;
    Some(std::ffi::OsString::from_wide(&buf[..size as usize]).to_string_lossy().into_owned())
}

/// Reads TOKEN_USER into an 8-byte aligned buffer (it contains a pointer).
unsafe fn token_user_buffer(process: HANDLE) -> Option<Vec<u64>> {
    let mut token = HANDLE::default();
    OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
    let token = OwnedHandle(token);
    let mut needed = 0u32;
    let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut needed);
    if needed == 0 {
        return None;
    }
    let mut buf = vec![0u64; (needed as usize + 7) / 8];
    GetTokenInformation(token.0, TokenUser, Some(buf.as_mut_ptr() as *mut c_void), needed, &mut needed).ok()?;
    Some(buf)
}

unsafe fn same_user_as_self(other: HANDLE) -> Option<bool> {
    let theirs = token_user_buffer(other)?;
    let mine = token_user_buffer(GetCurrentProcess())?;
    let their_sid: PSID = (*(theirs.as_ptr() as *const TOKEN_USER)).User.Sid;
    let my_sid: PSID = (*(mine.as_ptr() as *const TOKEN_USER)).User.Sid;
    Some(EqualSid(their_sid, my_sid).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

    const T0: u64 = 133_000_000_000_000_000;

    fn good() -> (PeerSnapshot, PeerExpectation) {
        (
            PeerSnapshot {
                pid: 4242,
                pid_stable_after_handle_open: true,
                exited: false,
                pipe_connected: true,
                creation_filetime: T0 - 10_000_000,
                same_user: Some(true),
                session_id: Some(1),
                image_path: Some(r"\\?\c:\apps\dask.daemon.exe".into()),
            },
            PeerExpectation {
                session_id: 1,
                allowed_images: vec![r"\\?\c:\apps\dask.daemon.exe".into()],
                connect_started_filetime: T0,
            },
        )
    }

    #[test]
    fn policy_accepts_fully_matching_server() {
        let (s, e) = good();
        assert!(evaluate(&s, &e).is_ok());
    }

    #[test]
    fn policy_accepts_server_created_exactly_at_connect_start() {
        let (mut s, e) = good();
        s.creation_filetime = e.connect_started_filetime;
        assert!(evaluate(&s, &e).is_ok());
    }

    #[test]
    fn policy_rejects_every_identity_failure() {
        type Mutate = fn(&mut PeerSnapshot, &mut PeerExpectation);
        let cases: Vec<(&str, Mutate, &str)> = vec![
            ("empty allowlist", |_, e| e.allowed_images.clear(), "fail closed"),
            ("zero pid", |s, _| s.pid = 0, "unavailable"),
            ("pid unstable", |s, _| s.pid_stable_after_handle_open = false, "race"),
            ("exited", |s, _| s.exited = true, "exited"),
            ("pipe broken", |s, _| s.pipe_connected = false, "no longer connected"),
            ("no creation time", |s, _| s.creation_filetime = 0, "creation time"),
            ("created after connect (PID reuse)", |s, e| s.creation_filetime = e.connect_started_filetime + 1, "PID reuse"),
            ("different user", |s, _| s.same_user = Some(false), "different user"),
            ("unknown user", |s, _| s.same_user = None, "user could not"),
            ("different session", |s, _| s.session_id = Some(2), "different logon session"),
            ("unknown session", |s, _| s.session_id = None, "session could not"),
            ("no image", |s, _| s.image_path = None, "image path unavailable"),
            ("wrong image", |s, _| s.image_path = Some(r"\\?\c:\evil\dask.daemon.exe".into()), "not in the allowed"),
        ];
        for (label, mutate, fragment) in cases {
            let (mut s, mut e) = good();
            mutate(&mut s, &mut e);
            let err = evaluate(&s, &e).expect_err(label);
            assert!(err.contains(fragment), "{label}: got '{err}', wanted '{fragment}'");
        }
    }

    #[test]
    fn production_policy_resolves_repo_layout_paths_only() {
        let paths = default_allowed_daemon_paths();
        assert_eq!(paths.len(), 2, "expected Debug and Release candidates, got {paths:?}");
        for p in paths {
            assert!(p.ends_with("net8.0\\DAsk.Daemon.exe"), "{p:?}");
        }
    }

    async fn live_pair(name: &str) -> (tokio::net::windows::named_pipe::NamedPipeServer, tokio::net::windows::named_pipe::NamedPipeClient) {
        let server = ServerOptions::new().first_pipe_instance(true).create(name).expect("create server");
        let client = ClientOptions::new().open(name).expect("open client");
        server.connect().await.expect("server accept");
        (server, client)
    }

    fn unique_name() -> String {
        format!(r"\\.\pipe\dask-peer-test-{}", uuid::Uuid::new_v4().simple())
    }

    #[tokio::test]
    async fn live_verify_accepts_this_process_when_allowed_and_pins_pid() {
        let name = unique_name();
        let started = now_filetime();
        let (_server, client) = live_pair(&name).await;
        let me = std::env::current_exe().unwrap();
        let ok = verify_server(&client, started, &ServerPolicy::allow_only(vec![me])).expect("should verify");
        assert_eq!(ok.pid, std::process::id());
    }

    #[tokio::test]
    async fn live_verify_rejects_wrong_image_empty_and_unresolvable_allowlists() {
        let name = unique_name();
        let started = now_filetime();
        let (_server, client) = live_pair(&name).await;

        let cmd = PathBuf::from(r"C:\Windows\System32\cmd.exe");
        let err = verify_server(&client, started, &ServerPolicy::allow_only(vec![cmd])).unwrap_err();
        assert!(err.contains("not in the allowed"), "{err}");

        let err = verify_server(&client, started, &ServerPolicy::allow_only(vec![])).unwrap_err();
        assert!(err.contains("fail closed"), "{err}");

        let err = verify_server(&client, started, &ServerPolicy::allow_only(vec![PathBuf::from(r"C:\nope\DAsk.Daemon.exe")])).unwrap_err();
        assert!(err.contains("fail closed"), "{err}");
    }

    #[tokio::test]
    async fn live_verify_applies_pid_reuse_rule() {
        let name = unique_name();
        let (_server, client) = live_pair(&name).await;
        let me = std::env::current_exe().unwrap();
        // Pretend the connection attempt began before this process even existed.
        let err = verify_server(&client, 1, &ServerPolicy::allow_only(vec![me])).unwrap_err();
        assert!(err.contains("PID reuse"), "{err}");
    }

    #[tokio::test]
    async fn live_verify_fails_closed_when_server_is_gone() {
        let name = unique_name();
        let started = now_filetime();
        let (server, client) = live_pair(&name).await;
        let me = std::env::current_exe().unwrap();
        let policy = ServerPolicy::allow_only(vec![me]);
        assert!(verify_server(&client, started, &policy).is_ok(), "control: connected server must verify");

        drop(server);
        // tokio closes the dropped handle asynchronously; once it is closed the pipe is broken and
        // verification must refuse, never accept.
        let mut refused = false;
        for _ in 0..40 {
            if let Err(e) = verify_server(&client, started, &policy) {
                assert!(e.contains("no longer connected") || e.contains("failed"), "{e}");
                refused = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(refused, "a broken pipe was still accepted as a verified server");
    }
}
