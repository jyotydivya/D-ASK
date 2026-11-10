//! Optional offline speech-to-text with whisper.cpp (`whisper-cli.exe`, CPU build) and a small English model.
//!
//! Provisioned only by `node scripts/inference/fetch-whisper.mjs` (pinned in agent/runtime/inference/whisper-artifacts.json).
//! The HUD uses it only when EVERY pinned runtime file and the model hash exactly as pinned (Windows CNG SHA-256, cached
//! per file size + modification time); anything missing or different means "not available" and the caller falls back to
//! the Windows SAPI recognizer. whisper-cli is a local process: no network, no console window, bounded in time, killed on
//! timeout. `DASK_STT_ENGINE=sapi` turns it off.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

pub const MANIFEST_REL: &str = "agent/runtime/inference/whisper-artifacts.json";

#[derive(Debug, Clone)]
pub struct WhisperEngine {
    pub exe: PathBuf,
    pub dir: PathBuf,
    pub model: PathBuf,
    pub model_id: String,
}

/// Engine choice from the environment: "sapi" disables whisper; anything else (default) prefers whisper when verified.
pub fn whisper_allowed() -> bool {
    !matches!(std::env::var("DASK_STT_ENGINE").ok().as_deref(), Some("sapi"))
}

/// The verified engine, or why it is not available (never an error the user sees: the caller falls back to SAPI).
pub fn locate(root: &Path) -> Result<WhisperEngine, String> {
    let text = std::fs::read_to_string(root.join(MANIFEST_REL)).map_err(|_| "no whisper manifest".to_string())?;
    let m: serde_json::Value = serde_json::from_str(&text).map_err(|_| "invalid whisper manifest".to_string())?;
    let s = |v: &serde_json::Value| v.as_str().map(str::to_string);
    let dir = root.join(s(&m["runtime"]["installDir"]).ok_or("manifest: installDir")?);
    let exe_name = s(&m["runtime"]["executable"]).ok_or("manifest: executable")?;
    let files = m["runtime"]["files"].as_object().ok_or("manifest: files")?;
    if files.is_empty() { return Err("whisper.cpp is not installed (no pinned files)".into()); }
    if !files.contains_key(&exe_name) { return Err("manifest does not pin the executable".into()); }
    for (rel, want) in files {
        if rel.contains("..") || Path::new(rel).is_absolute() { return Err("manifest: unsafe path".into()); }
        let want = want.as_str().ok_or("manifest: hash")?;
        verify(&dir.join(rel), want)?;
    }
    let model = root.join(s(&m["model"]["installDir"]).ok_or("manifest: model dir")?).join(s(&m["model"]["file"]).ok_or("manifest: model file")?);
    verify(&model, m["model"]["sha256"].as_str().ok_or("manifest: model hash")?)?;
    Ok(WhisperEngine { exe: dir.join(&exe_name), dir, model, model_id: s(&m["model"]["id"]).unwrap_or_default() })
}

/// Whisper wants 16 kHz mono 16-bit PCM (what the HUD recorder produces). Anything else goes to SAPI.
pub fn wav_is_whisper_ready(bytes: &[u8]) -> bool {
    bytes.len() >= 44 && u16::from_le_bytes([bytes[22], bytes[23]]) == 1 && u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]) == 16000
}

impl WhisperEngine {
    /// Transcribes a 16 kHz mono WAV. Bounded by `limit`; the process is killed on timeout.
    pub fn transcribe(&self, wav: &Path, limit: Duration) -> Result<String, String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let threads = std::thread::available_parallelism().map(|n| n.get().clamp(1, 4)).unwrap_or(2);
        let mut child = Command::new(&self.exe)
            .current_dir(&self.dir)
            .args(["-m"]).arg(&self.model)
            .args(["-f"]).arg(wav)
            .args(["-l", "en", "-nt", "-np", "-t", &threads.to_string()])
            .args(["--prompt", "open quote close quote quotation marks"])
            .arg("--carry-initial-prompt")
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn().map_err(|e| format!("whisper-cli did not start: {e}"))?;
        let mut stdout = child.stdout.take().ok_or("no stdout")?;
        let reader = std::thread::spawn(move || { let mut s = String::new(); let _ = std::io::Read::read_to_string(&mut stdout, &mut s); s });
        let deadline = Instant::now() + limit;
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
                _ => { let _ = child.kill(); let _ = child.wait(); return Err("whisper timed out".into()); }
            }
        };
        let out = reader.join().unwrap_or_default();
        if !status.success() { return Err(format!("whisper-cli exited with {status}")); }
        Ok(clean_transcript(&out))
    }
}

/// Joins whisper's lines and drops non-speech annotations such as "[BLANK_AUDIO]" or "(music)". Quotation marks are KEPT
/// (curly ones become straight): whisper writes a dictated "quote … unquote" as real quotes. Spoken markers and
/// unbalanced quotes are then handled by `stt::normalize_quotes` (both engines).
pub fn clean_transcript(raw: &str) -> String {
    let mut out = String::new();
    let mut depth = 0i32;
    for c in raw.chars() {
        match c {
            '[' | '(' => depth += 1,
            ']' | ')' => depth = (depth - 1).max(0),
            '\u{201C}' | '\u{201D}' if depth == 0 => out.push('"'),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── SHA-256 via Windows CNG, cached by (path, size, mtime) ───────────────────

static VERIFIED: Mutex<Option<HashMap<PathBuf, (u64, SystemTime, String)>>> = Mutex::new(None);

fn verify(path: &Path, want: &str) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|_| format!("missing: {}", path.display()))?;
    let key = (meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH));
    {
        let g = VERIFIED.lock().unwrap();
        if let Some((len, mt, h)) = g.as_ref().and_then(|m| m.get(path)) {
            if (*len, *mt) == key { return if h.eq_ignore_ascii_case(want) { Ok(()) } else { Err(format!("hash mismatch: {}", path.display())) }; }
        }
    }
    let bytes = std::fs::read(path).map_err(|_| format!("unreadable: {}", path.display()))?;
    let got = sha256_hex(&bytes)?;
    VERIFIED.lock().unwrap().get_or_insert_with(HashMap::new).insert(path.to_path_buf(), (key.0, key.1, got.clone()));
    if got.eq_ignore_ascii_case(want) { Ok(()) } else { Err(format!("hash mismatch: {}", path.display())) }
}

pub fn sha256_hex(data: &[u8]) -> Result<String, String> {
    use windows::Win32::Security::Cryptography::{BCryptHash, BCRYPT_SHA256_ALG_HANDLE};
    let mut out = [0u8; 32];
    let st = unsafe { BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, data, &mut out) };
    if st.0 != 0 { return Err(format!("SHA-256 failed: 0x{:08x}", st.0)); }
    Ok(out.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(sha256_hex(b"").unwrap(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc").unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn transcript_cleanup_drops_annotations() {
        assert_eq!(clean_transcript(" [BLANK_AUDIO]\n"), "");
        assert_eq!(clean_transcript(" Open the notes window.\n (music) Then type hello.\n"), "Open the notes window. Then type hello.");
        assert_eq!(clean_transcript(" Type \u{201C}Hello World\u{201D} into the notes field.\n"), "Type \"Hello World\" into the notes field.", "dictated quotes are kept");
    }

    #[test]
    fn missing_or_tampered_install_is_not_available() {
        let root = std::env::temp_dir().join(format!("dask-whisper-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("agent/runtime/inference")).unwrap();
        assert!(locate(&root).is_err(), "no manifest");
        std::fs::create_dir_all(root.join("w/models")).unwrap();
        std::fs::write(root.join("w/whisper-cli.exe"), b"exe").unwrap();
        std::fs::write(root.join("w/models/m.bin"), b"model").unwrap();
        let manifest = |exe_hash: &str, model_hash: &str| serde_json::json!({
            "runtime": { "installDir": "w", "executable": "whisper-cli.exe", "files": { "whisper-cli.exe": exe_hash } },
            "model": { "id": "m", "installDir": "w/models", "file": "m.bin", "sha256": model_hash } }).to_string();
        let good_exe = sha256_hex(b"exe").unwrap();
        let good_model = sha256_hex(b"model").unwrap();
        std::fs::write(root.join(MANIFEST_REL), manifest(&good_exe, &good_model)).unwrap();
        assert!(locate(&root).is_ok(), "verified install is available");
        std::fs::write(root.join(MANIFEST_REL), manifest(&good_exe, &"0".repeat(64))).unwrap();
        assert!(locate(&root).is_err(), "model hash mismatch -> not available");
        std::fs::write(root.join(MANIFEST_REL), manifest(&"0".repeat(64), &good_model)).unwrap();
        assert!(locate(&root).is_err(), "runtime hash mismatch -> not available");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_16k_mono_goes_to_whisper() {
        let mut h = vec![0u8; 44];
        h[22] = 1; h[24..28].copy_from_slice(&16000u32.to_le_bytes());
        assert!(wav_is_whisper_ready(&h));
        h[24..28].copy_from_slice(&48000u32.to_le_bytes());
        assert!(!wav_is_whisper_ready(&h));
    }
}
