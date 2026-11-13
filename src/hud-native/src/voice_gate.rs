//! Acceptance-only VOICE GATE (scripts\hud\approval-live-voice-chain.ps1). Inactive unless DASK_VOICE_GATE_DIR names an
//! existing folder; normal use never sets it, and then nothing here runs.
//!
//! Why it exists (results/offline-voice-chain/20261113T214254): once the microphone is ARMED the page submits EVERY
//! utterance as a task, so "can you hear me" became the acceptance task for "What is seven times eight?". With the gate
//! active, a transcript reaches the page (and so the daemon) only when the harness released it for the open test step:
//!
//!   harness  -> open.json            {step, nonce, expected}   one step is open (written only AFTER the person acknowledged
//!                                                              the prompt and the HUD showed ARMED)
//!   HUD      -> <stem>.held.json     {stem, step, nonce, transcript, engine, wavBytes, wavSha256}
//!               (open.json is renamed to <stem>.open.json first: ONE recording per opening; a second one finds the gate closed)
//!   harness  -> <stem>.verdict.json  {stem, nonce, transcriptSha256, release}   after comparing with the expected utterance
//!   HUD      -> <stem>.released.json or <stem>.withheld.json; the page gets the text only when released, otherwise ""
//!               (an empty transcript is never submitted by the page).
//!
//! Submit boundary: once the harness creates `enforce` (after its typed setup request), an agent task is forwarded only if
//! its objective is EXACTLY the one transcript released last (one-shot). Anything else (unrelated speech, a transcript
//! the page altered, a typed request) is refused before the daemon and recorded as blocked-*.json.
//! Fail-closed everywhere: no open step, a missing/late/invalid verdict, or a nonce/stem/hash mismatch all withhold.
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const ENV: &str = "DASK_VOICE_GATE_DIR";
pub const VERDICT_TIMEOUT: Duration = Duration::from_secs(60);

/// The single transcript released for submission (one-shot), shared by the STT worker thread and the event loop.
static RELEASED: Mutex<Option<String>> = Mutex::new(None);

pub fn gate_dir() -> Option<PathBuf> {
    std::env::var_os(ENV).map(PathBuf::from).filter(|d| d.is_dir())
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Released(String),
    Withheld(String),
}

fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }

/// Windows PowerShell 5.1 writes UTF-8 with a byte-order mark unless told otherwise; serde_json rejects it, so strip it.
fn read_json(path: &Path) -> Option<serde_json::Value> {
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(s.trim_start_matches('\u{feff}')).ok()
}

fn write_json(path: &Path, v: &serde_json::Value) {
    // Write then rename, so the harness never reads a half-written record.
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, v.to_string()).is_ok() { let _ = std::fs::rename(&tmp, path); }
}

/// Pure decision over the held record and the harness verdict.
pub fn decide(stem: &str, nonce: &str, transcript_sha: &str, verdict: &serde_json::Value) -> Result<(), String> {
    if verdict["stem"].as_str() != Some(stem) { return Err("verdict for another recording".into()); }
    if verdict["nonce"].as_str() != Some(nonce) { return Err("verdict for another step (nonce mismatch)".into()); }
    if !verdict["transcriptSha256"].as_str().is_some_and(|h| h.eq_ignore_ascii_case(transcript_sha)) {
        return Err("verdict for another transcript (hash mismatch)".into());
    }
    match verdict["release"].as_bool() {
        Some(true) => Ok(()),
        Some(false) => Err(verdict["reason"].as_str().unwrap_or("rejected by the harness").to_string()),
        None => Err("verdict has no release decision".into()),
    }
}

/// Seconds of audio in a PCM WAV (byte rate from the header; the page's recorder writes a 44-byte header).
pub fn wav_seconds(wav: &[u8]) -> f64 {
    if wav.len() < 44 { return 0.0; }
    let rate = u32::from_le_bytes([wav[28], wav[29], wav[30], wav[31]]) as f64;
    if rate <= 0.0 { 0.0 } else { (wav.len() - 44) as f64 / rate }
}

/// A recording counts for a step only if it BEGAN after the step opened (with this much tolerance): the end of a segment that
/// started earlier (the HUD's own arming sound, speech before the prompt) never claims the opening.
const START_TOLERANCE_MS: i64 = 250;

/// Called by /api/stt after a successful transcription. `received` is when the recording reached the HUD (the end of the segment).
/// Blocks this worker thread (never the UI) until the harness answers.
pub fn hold(dir: &Path, stem: &str, transcript: &str, engine: &str, wav: &[u8], received: chrono::DateTime<chrono::Utc>, timeout: Duration) -> Outcome {
    hold_with(&RELEASED, dir, stem, transcript, engine, wav, received, timeout)
}

#[allow(clippy::too_many_arguments)]
fn hold_with(slot: &Mutex<Option<String>>, dir: &Path, stem: &str, transcript: &str, engine: &str, wav: &[u8], received: chrono::DateTime<chrono::Utc>, timeout: Duration) -> Outcome {
    let text = transcript.trim().to_string();
    let wav_sha = crate::whisper::sha256_hex(wav).unwrap_or_default();
    let text_sha = crate::whisper::sha256_hex(text.as_bytes()).unwrap_or_default();
    let started = received - chrono::Duration::milliseconds((wav_seconds(wav) * 1000.0) as i64);
    let base = serde_json::json!({ "stem": stem, "transcript": text, "transcriptSha256": text_sha, "engine": engine,
        "wavBytes": wav.len(), "wavSha256": wav_sha, "recordingStartedUtc": started.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "receivedUtc": received.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "utc": now() });
    let withheld = |reason: &str, extra: serde_json::Value| {
        let mut rec = base.clone();
        rec["reason"] = reason.into();
        if let (Some(r), Some(e)) = (rec.as_object_mut(), extra.as_object()) { for (k, v) in e { r.insert(k.clone(), v.clone()); } }
        write_json(&dir.join(format!("{stem}.withheld.json")), &rec);
        tracing::info!("[VOICE GATE] withheld a transcript ({} chars): {}", text.chars().count(), reason);
        Outcome::Withheld(reason.to_string())
    };
    // Recordings that cannot be this step's utterance are withheld WITHOUT using up the opening.
    if text.is_empty() {
        return withheld("empty transcript (no speech recognised)", serde_json::json!({}));
    }
    if let Some(opened) = read_json(&dir.join("open.json")).and_then(|o| o["openedUtc"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())) {
        if started < opened.with_timezone(&chrono::Utc) - chrono::Duration::milliseconds(START_TOLERANCE_MS) {
            return withheld("recording began before the step opened", serde_json::json!({ "openedUtc": opened.to_rfc3339() }));
        }
    }
    // Claim the open step atomically: exactly one recording per opening.
    let claimed = dir.join(format!("{stem}.open.json"));
    if std::fs::rename(dir.join("open.json"), &claimed).is_err() {
        return withheld("gate-closed: no acknowledged test step is open", serde_json::json!({}));
    }
    *slot.lock().unwrap() = None;   // a new opening voids any earlier, unused release
    let open: serde_json::Value = read_json(&claimed).unwrap_or_default();
    let (Some(step), Some(nonce)) = (open["step"].as_str(), open["nonce"].as_str()) else {
        return withheld("invalid open step record", serde_json::json!({}));
    };
    // Fail closed: an opening without a readable time cannot prove the recording is fresh.
    let Some(opened) = open["openedUtc"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) else {
        return withheld("open step record without openedUtc", serde_json::json!({ "step": step, "nonce": nonce }));
    };
    if started < opened.with_timezone(&chrono::Utc) - chrono::Duration::milliseconds(START_TOLERANCE_MS) {
        return withheld("recording began before the step opened", serde_json::json!({ "step": step, "nonce": nonce }));
    }
    let mut held = base.clone();
    held["step"] = step.into();
    held["nonce"] = nonce.into();
    write_json(&dir.join(format!("{stem}.held.json")), &held);
    tracing::info!("[VOICE GATE] holding transcript for step {} ({} chars, wav {} bytes)", step, text.chars().count(), wav.len());
    let verdict_path = dir.join(format!("{stem}.verdict.json"));
    let t0 = Instant::now();
    let verdict = loop {
        if let Some(v) = read_json(&verdict_path) { break Some(v); }
        if t0.elapsed() >= timeout { break None; }
        std::thread::sleep(Duration::from_millis(100));
    };
    let extra = serde_json::json!({ "step": step, "nonce": nonce });
    let Some(verdict) = verdict else { return withheld("no verdict in time", extra); };
    match decide(stem, nonce, &text_sha, &verdict) {
        Ok(()) => {
            *slot.lock().unwrap() = Some(text.clone());
            let mut rec = held.clone();
            rec["releasedUtc"] = now().into();
            write_json(&dir.join(format!("{stem}.released.json")), &rec);
            tracing::info!("[VOICE GATE] released the transcript for step {} (sha256 {})", step, &text_sha[..12.min(text_sha.len())]);
            Outcome::Released(text)
        }
        Err(why) => withheld(&format!("rejected: {why}"), extra),
    }
}

/// Called for every agent task submission while the gate folder exists. Ok = forward to the daemon.
pub fn check_submit(dir: &Path, objective: &str) -> Result<(), String> {
    check_submit_with(&RELEASED, dir, objective)
}

fn check_submit_with(slot: &Mutex<Option<String>>, dir: &Path, objective: &str) -> Result<(), String> {
    if !dir.join("enforce").exists() { return Ok(()); }   // harness setup phase (typed index request), before anyone speaks
    let obj = objective.trim();
    let released = slot.lock().unwrap().take();   // one-shot, consumed by ANY submission attempt
    let obj_sha = crate::whisper::sha256_hex(obj.as_bytes()).unwrap_or_default();
    let stamp = chrono::Utc::now().format("%H%M%S%6f");
    let rec = serde_json::json!({ "objective": obj, "objectiveSha256": obj_sha, "chars": obj.chars().count(), "utc": now() });
    match released {
        Some(r) if r == obj => {
            write_json(&dir.join(format!("submitted-{stamp}.json")), &rec);
            tracing::info!("[VOICE GATE] submitting the released transcript (sha256 {})", &obj_sha[..12.min(obj_sha.len())]);
            Ok(())
        }
        other => {
            let reason = match other {
                None => "no released transcript (unvalidated speech or a typed request)".to_string(),
                Some(_) => "the objective differs from the released transcript (altered before submission)".to_string(),
            };
            let mut b = rec.clone();
            b["reason"] = reason.clone().into();
            write_json(&dir.join(format!("blocked-{stamp}.json")), &b);
            tracing::warn!("[VOICE GATE] blocked a task submission ({} chars): {}", obj.chars().count(), reason);
            Err(reason)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("dask-voice-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    /// Written as the harness does: PowerShell's round-trip time format (7 fractional digits), opened one second ago.
    fn open(dir: &Path, step: &str, nonce: &str) {
        let at = chrono::Utc::now() - chrono::Duration::seconds(1);
        let t = format!("{}.{:07}Z", at.format("%Y-%m-%dT%H:%M:%S"), chrono::Timelike::nanosecond(&at) / 100);
        std::fs::write(dir.join("open.json"), serde_json::json!({ "step": step, "nonce": nonce, "expected": "x", "openedUtc": t }).to_string()).unwrap();
    }
    fn read(p: PathBuf) -> serde_json::Value { serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap() }
    /// Plays the harness: waits for the held record and answers with the given decision (or a tampered one).
    fn answer(dir: PathBuf, stem: &'static str, release: bool, tamper: Option<&'static str>) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let held = dir.join(format!("{stem}.held.json"));
            let t0 = Instant::now();
            while !held.exists() { assert!(t0.elapsed() < Duration::from_secs(5)); std::thread::sleep(Duration::from_millis(20)); }
            let h = read(held);
            let mut v = serde_json::json!({ "stem": stem, "nonce": h["nonce"], "transcriptSha256": h["transcriptSha256"], "release": release, "reason": "mismatch" });
            match tamper { Some("nonce") => v["nonce"] = "other".into(), Some("sha") => v["transcriptSha256"] = "00".into(), Some("stem") => v["stem"] = "utt-x".into(), _ => {} }
            // With a byte-order mark, as Windows PowerShell 5.1 writes by default: must still be read.
            std::fs::write(dir.join(format!("{stem}.verdict.json")), format!("\u{feff}{v}")).unwrap();
        })
    }

    #[test]
    fn closed_gate_withholds_and_never_releases() {
        let (d, slot) = (tmp(), Mutex::new(None));
        let out = hold_with(&slot, &d, "utt-1", "can you hear me", "whisper-local", b"RIFFwav", chrono::Utc::now(), Duration::from_millis(200));
        assert!(matches!(out, Outcome::Withheld(ref r) if r.starts_with("gate-closed")));
        assert!(slot.lock().unwrap().is_none());
        assert!(d.join("utt-1.withheld.json").exists() && !d.join("utt-1.held.json").exists());
    }

    #[test]
    fn released_only_with_matching_verdict_and_one_recording_per_opening() {
        let (d, slot) = (tmp(), Mutex::new(None));
        open(&d, "s1", "n1");
        let h = answer(d.clone(), "utt-2", true, None);
        let out = hold_with(&slot, &d, "utt-2", " What is seven times eight? ", "whisper-local", b"RIFFa", chrono::Utc::now(), Duration::from_secs(5));
        h.join().unwrap();
        assert_eq!(out, Outcome::Released("What is seven times eight?".into()));
        let held = read(d.join("utt-2.held.json"));
        assert_eq!((held["step"].as_str(), held["nonce"].as_str()), (Some("s1"), Some("n1")));
        assert!(!d.join("open.json").exists(), "the opening is consumed");
        // A second recording in the same opening finds the gate closed.
        let second = hold_with(&slot, &d, "utt-3", "tell me a joke", "whisper-local", b"RIFFb", chrono::Utc::now(), Duration::from_millis(200));
        assert!(matches!(second, Outcome::Withheld(ref r) if r.starts_with("gate-closed")));
    }

    #[test]
    fn rejected_late_or_tampered_verdicts_withhold() {
        for (stem, release, tamper) in [("utt-4", false, None), ("utt-5", true, Some("nonce")), ("utt-6", true, Some("sha")), ("utt-7", true, Some("stem"))] {
            let (d, slot) = (tmp(), Mutex::new(None));
            open(&d, "s2", "n2");
            let h = answer(d.clone(), stem, release, tamper);
            let out = hold_with(&slot, &d, stem, "what is 25 multiplied by 4", "whisper-local", b"RIFFc", chrono::Utc::now(), Duration::from_millis(1500));
            h.join().unwrap();
            assert!(matches!(out, Outcome::Withheld(_)), "{stem}: {out:?}");
            assert!(slot.lock().unwrap().is_none(), "{stem}: nothing released");
        }
        let (d, slot) = (tmp(), Mutex::new(None));
        open(&d, "s3", "n3");
        let out = hold_with(&slot, &d, "utt-8", "x y", "whisper-local", b"RIFFd", chrono::Utc::now(), Duration::from_millis(300));
        assert_eq!(out, Outcome::Withheld("no verdict in time".into()));
    }

    #[test]
    fn submit_boundary_is_one_shot_and_exact() {
        let (d, slot) = (tmp(), Mutex::new(None));
        assert!(check_submit_with(&slot, &d, "Index \"lib\" as research").is_ok(), "setup phase: not enforced yet");
        std::fs::write(d.join("enforce"), b"").unwrap();
        assert!(check_submit_with(&slot, &d, "can you hear me").is_err(), "nothing released: blocked");
        *slot.lock().unwrap() = Some("What is seven times eight?".into());
        assert!(check_submit_with(&slot, &d, " What is seven times eight? ").is_ok());
        assert!(check_submit_with(&slot, &d, "What is seven times eight?").is_err(), "a release is used once");
        *slot.lock().unwrap() = Some("According to my research papers, when is the D-ASK evaluation deadline? Then remember it.".into());
        assert!(check_submit_with(&slot, &d, "evaluation deadline? Then remember it.").is_err(), "an altered transcript is blocked");
        assert!(slot.lock().unwrap().is_none(), "and the release is void");
        assert_eq!(std::fs::read_dir(&d).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("blocked-")).count(), 3);
    }

    /// A 16 kHz mono 16-bit WAV of the given length (byte rate 32000 at offset 28).
    fn wav(secs: f64) -> Vec<u8> {
        let mut h = vec![0u8; 44];
        h[28..32].copy_from_slice(&32000u32.to_le_bytes());
        h.extend(std::iter::repeat(1u8).take((secs * 32000.0) as usize));
        h
    }

    #[test]
    fn only_a_recording_that_began_after_the_opening_can_claim_it() {
        assert!((wav_seconds(&wav(3.0)) - 3.0).abs() < 0.001);
        let (d, slot) = (tmp(), Mutex::new(None));
        open(&d, "s1", "n1");   // opened 1 s ago
        // 3 s of audio that ended now began 2 s BEFORE the opening (e.g. the arming sound, or speech before the prompt).
        let early = hold_with(&slot, &d, "utt-a", "thank you", "whisper-local", &wav(3.0), chrono::Utc::now(), Duration::from_millis(200));
        assert_eq!(early, Outcome::Withheld("recording began before the step opened".into()));
        // Nothing recognised: withheld too.
        let empty = hold_with(&slot, &d, "utt-b", "   ", "whisper-local", &wav(0.5), chrono::Utc::now(), Duration::from_millis(200));
        assert!(matches!(empty, Outcome::Withheld(ref r) if r.starts_with("empty transcript")));
        // Neither used up the opening: the person's real utterance (0.5 s, begun after the opening) still claims it.
        assert!(d.join("open.json").exists());
        let h = answer(d.clone(), "utt-c", true, None);
        let ok = hold_with(&slot, &d, "utt-c", "What is seven times eight?", "whisper-local", &wav(0.5), chrono::Utc::now(), Duration::from_secs(5));
        h.join().unwrap();
        assert_eq!(ok, Outcome::Released("What is seven times eight?".into()));
        let held = read(d.join("utt-c.held.json"));
        assert!(held["recordingStartedUtc"].is_string() && held["receivedUtc"].is_string());
    }

    #[test]
    fn an_opening_without_a_time_fails_closed() {
        let (d, slot) = (tmp(), Mutex::new(None));
        std::fs::write(d.join("open.json"), serde_json::json!({ "step": "s1", "nonce": "n1" }).to_string()).unwrap();
        let out = hold_with(&slot, &d, "utt-t", "What is seven times eight?", "whisper-local", &wav(0.5), chrono::Utc::now(), Duration::from_millis(200));
        assert_eq!(out, Outcome::Withheld("open step record without openedUtc".into()));
        assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn a_new_opening_voids_an_unused_release() {
        let (d, slot) = (tmp(), Mutex::new(Some("stale".to_string())));
        open(&d, "s1", "n9");
        let _ = hold_with(&slot, &d, "utt-9", "anything", "whisper-local", b"RIFFe", chrono::Utc::now(), Duration::from_millis(200));
        assert!(slot.lock().unwrap().is_none());
    }
}
