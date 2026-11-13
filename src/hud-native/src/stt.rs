//! Offline speech-to-text: the Windows SAPI desktop recognizer (installed with Windows, en-US here; no network, no model
//! download). The HUD captures 16 kHz mono PCM WAV and POSTs it to dask://…/api/stt; this module transcribes that file
//! on its own COM thread, bounded in time. Engine-neutral contract (`transcribe_wav`): a higher-accuracy local engine
//! (whisper.cpp) can replace it once its binary and model are provisioned.

use std::path::Path;
use std::time::{Duration, Instant};

pub const MAX_WAV_BYTES: usize = 2 * 1024 * 1024; // ~60 s at 16 kHz mono 16-bit
pub const MAX_TRANSCRIBE: Duration = Duration::from_secs(20);

/// Minimal validation of a PCM WAV upload: RIFF/WAVE, PCM, 1–2 channels, 8–48 kHz, 16-bit, bounded size.
pub fn validate_wav(bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.len() > MAX_WAV_BYTES { return Err("audio too long"); }
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" || &bytes[12..16] != b"fmt " { return Err("not a WAV file"); }
    let fmt = u16::from_le_bytes([bytes[20], bytes[21]]);
    let ch = u16::from_le_bytes([bytes[22], bytes[23]]);
    let rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
    let bits = u16::from_le_bytes([bytes[34], bytes[35]]);
    if fmt != 1 || !(1..=2).contains(&ch) || !(8000..=48000).contains(&rate) || bits != 16 { return Err("unsupported WAV format (16-bit PCM expected)"); }
    Ok(())
}

/// Engine-neutral entry point: whisper.cpp when it is installed, verified and allowed, and the audio is 16 kHz mono;
/// otherwise (or if whisper fails) the Windows SAPI recognizer. Returns the text and the engine that produced it.
pub fn transcribe(root: &Path, path: &Path, wav: &[u8]) -> Result<(String, &'static str), String> {
    if crate::whisper::whisper_allowed() && crate::whisper::wav_is_whisper_ready(wav) {
        match crate::whisper::locate(root) {
            Ok(engine) => match engine.transcribe(path, MAX_TRANSCRIBE) {
                Ok(text) => return Ok((normalize_quotes(&text), "whisper-local")),
                Err(e) => tracing::warn!("[STT] whisper failed ({e}); using the Windows recognizer"),
            },
            Err(why) => tracing::debug!("[STT] whisper not available ({why}); using the Windows recognizer"),
        }
    }
    transcribe_wav(path).map(|t| (normalize_quotes(&t), "sapi-local"))
}

/// Dictated quotation marks, for both engines. Quoted text is what the input grammar types EXACTLY (always shown on the
/// approval card first), so quotes must come from the speaker:
///   - spoken markers become quotes: "quote … unquote", "open quote … close quote", "quote … end quote";
///   - whisper's leftovers around quotes it already wrote are removed: `open "x" close quote` -> `"x"`;
///   - an odd number of quotes is ambiguous: every quote is dropped (nothing is typed from an ambiguous span).
pub fn normalize_quotes(text: &str) -> String {
    let bare = |w: &str| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    let toks: Vec<&str> = text.split_whitespace().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let w = bare(toks[i]);
        // Opening marker: "quote" or "open quote" (not inside a word like "quoted").
        let open_len = if w == "quote" { 1 } else if w == "open" && toks.get(i + 1).map(|t| bare(t)) == Some("quote".into()) { 2 } else { 0 };
        if open_len > 0 {
            // Find the closing marker.
            let mut j = i + open_len;
            let mut close: Option<(usize, usize)> = None;
            while j < toks.len() {
                let a = bare(toks[j]);
                let b = toks.get(j + 1).map(|t| bare(t)).unwrap_or_default();
                if a == "unquote" { close = Some((j, 1)); break; }
                if (a == "close" || a == "end") && b == "quote" { close = Some((j, 2)); break; }
                j += 1;
            }
            if let Some((c, clen)) = close {
                if c > i + open_len {
                    let inner = toks[i + open_len..c].join(" ");
                    let inner = inner.trim_matches(|ch: char| ch == ',' || ch == '"' || ch.is_whitespace());
                    // Punctuation spoken after the marker ("unquote.") stays outside the quotes.
                    let last = toks[c + clen - 1];
                    let tail: String = last.chars().rev().take_while(|ch| !ch.is_alphanumeric()).collect::<Vec<_>>().into_iter().rev().filter(|ch| *ch != '"').collect();
                    out.push(format!("\"{inner}\"{tail}"));
                    i = c + clen;
                    continue;
                }
            }
        }
        out.push(toks[i].to_string());
        i += 1;
    }
    let mut s = out.join(" ");
    // Leftover marker words around quotes whisper already wrote.
    for (from, to) in [("open \"", "\""), ("Open \"", "\""), ("\" close quote", "\""), ("\" end quote", "\""), ("\" unquote", "\""), ("\", close quote", "\""), ("\", unquote", "\"")] {
        s = s.replace(from, to);
    }
    if s.matches('"').count() % 2 == 1 { s = s.replace('"', ""); }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Transcribes a WAV file with the SAPI in-process recognizer (dictation). Runs on a fresh COM thread.
pub fn transcribe_wav(path: &Path) -> Result<String, String> {
    let p = path.to_path_buf();
    let worker = std::thread::spawn(move || unsafe { transcribe_inner(&p) });
    worker.join().map_err(|_| "the recognizer crashed".to_string())?
}

unsafe fn transcribe_inner(path: &Path) -> Result<String, String> {
    use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Media::Speech::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

    if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() { return Err("COM could not be initialised".into()); }
    let result = (|| -> Result<String, String> {
        let e = |what: &str| { let w = what.to_string(); move |err: windows::core::Error| format!("{w}: {err}") };
        let reco: ISpRecognizer = CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL).map_err(e("no SAPI recognizer"))?;
        let stream: ISpStream = CoCreateInstance(&SpStream, None, CLSCTX_ALL).map_err(e("no SAPI stream"))?;
        let file = HSTRING::from(path.as_os_str());
        stream.BindToFile(PCWSTR(file.as_ptr()), SPFM_OPEN_READONLY, None, None, 0).map_err(e("cannot open the audio"))?;
        reco.SetInput(&stream, false).map_err(e("cannot use the audio"))?;
        let ctx = reco.CreateRecoContext().map_err(e("no recognition context"))?;
        ctx.SetNotifyWin32Event().map_err(e("no notification"))?;
        let flag = |ev: SPEVENTENUM| 1u64 << ev.0;
        let check = flag(SPEI_RESERVED1) | flag(SPEI_RESERVED2);
        let interest = flag(SPEI_RECOGNITION) | flag(SPEI_END_SR_STREAM) | flag(SPEI_FALSE_RECOGNITION) | check;
        ctx.SetInterest(interest, interest).map_err(e("cannot subscribe"))?;
        let grammar = ctx.CreateGrammar(0).map_err(e("no grammar"))?;
        grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC).map_err(e("dictation unavailable"))?;
        grammar.SetDictationState(SPRS_ACTIVE).map_err(e("cannot start dictation"))?;

        let deadline = Instant::now() + MAX_TRANSCRIBE;
        let mut parts: Vec<String> = Vec::new();
        let mut ended = false;
        while !ended && Instant::now() < deadline {
            let _ = ctx.WaitForNotifyEvent(250);
            loop {
                let mut ev = SPEVENT::default();
                let mut fetched = 0u32;
                if ctx.GetEvents(1, &mut ev, &mut fetched).is_err() || fetched == 0 { break; }
                let id = ev._bitfield & 0xFFFF;
                let ptype = (ev._bitfield >> 16) & 0xFFFF;
                // An object in lParam is owned by us now: take it (released on drop).
                let obj = if ptype == 2 && ev.lParam.0 != 0 { Some(windows::core::IUnknown::from_raw(ev.lParam.0 as *mut _)) } else { None };
                if id == SPEI_RECOGNITION.0 {
                    if let Some(r) = obj.as_ref().and_then(|o| o.cast::<ISpRecoResult>().ok()) {
                        // SP_GETWHOLEPHRASE (= -1): the whole phrase.
                        let mut text = PWSTR::null();
                        if r.GetText(u32::MAX, u32::MAX, true, &mut text, None).is_ok() && !text.is_null() {
                            parts.push(text.to_string().unwrap_or_default());
                            CoTaskMemFree(Some(text.0 as *const _));
                        }
                    }
                } else if id == SPEI_END_SR_STREAM.0 {
                    ended = true;
                }
                drop(obj);
            }
        }
        let _ = grammar.SetDictationState(SPRS_INACTIVE);
        if !ended && parts.is_empty() { return Err("transcription timed out".into()); }
        Ok(parts.join(" ").split_whitespace().collect::<Vec<_>>().join(" "))
    })();
    CoUninitialize();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(rate: u32, bits: u16, fmt: u16) -> Vec<u8> {
        let mut v = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        v.extend(16u32.to_le_bytes()); v.extend(fmt.to_le_bytes()); v.extend(1u16.to_le_bytes()); v.extend(rate.to_le_bytes());
        v.extend((rate * 2).to_le_bytes()); v.extend(2u16.to_le_bytes()); v.extend(bits.to_le_bytes()); v.extend(b"data"); v.extend(0u32.to_le_bytes());
        v
    }

    #[test]
    fn only_bounded_16_bit_pcm_wav_is_accepted() {
        assert!(validate_wav(&wav(16000, 16, 1)).is_ok());
        assert!(validate_wav(&wav(16000, 8, 1)).is_err());
        assert!(validate_wav(&wav(16000, 16, 3)).is_err(), "float");
        assert!(validate_wav(&wav(96000, 16, 1)).is_err());
        assert!(validate_wav(b"OggS....").is_err());
        assert!(validate_wav(&vec![0u8; MAX_WAV_BYTES + 1]).is_err());
    }

    #[test]
    fn dictated_quotes_are_preserved_and_spoken_markers_become_quotes() {
        // whisper already wrote the quotes for "quote hello world unquote" (observed with b5454 base.en).
        assert_eq!(normalize_quotes("Type \"Hello World\" into the notes field."), "Type \"Hello World\" into the notes field.");
        // whisper leftovers for "open quote good morning close quote" (observed).
        assert_eq!(normalize_quotes("Type open \"good morning\" close quote into the notes field."), "Type \"good morning\" into the notes field.");
        // spoken markers (SAPI writes the words).
        assert_eq!(normalize_quotes("type quote hello world unquote into the notes field"), "type \"hello world\" into the notes field");
        assert_eq!(normalize_quotes("type open quote good morning close quote into the notes field"), "type \"good morning\" into the notes field");
        assert_eq!(normalize_quotes("he said quote I will be late end quote."), "he said \"I will be late\".");
        // no closing marker: left as words, nothing quoted.
        assert_eq!(normalize_quotes("please quote me on that"), "please quote me on that");
        // unbalanced (observed: "He said, \"I will be late end.") -> no quotes at all (fail closed).
        assert_eq!(normalize_quotes("He said, \"I will be late end."), "He said, I will be late end.");
        assert_eq!(normalize_quotes("What is the weather like today?"), "What is the weather like today?");
    }

    /// The HUD's real path (`transcribe`: whisper when installed + verified, else SAPI) on a fixture WAV. DASK_STT_ROOT is the
    /// repository root; DASK_STT_EXPECT_ENGINE (optional) asserts which engine answered.
    #[test]
    #[ignore]
    fn real_engine_transcribes_a_local_fixture() {
        let p = std::env::var("DASK_STT_FIXTURE").expect("DASK_STT_FIXTURE");
        let root = std::env::var("DASK_STT_ROOT").expect("DASK_STT_ROOT");
        let expect = std::env::var("DASK_STT_EXPECT").unwrap_or_default().to_lowercase();
        let bytes = std::fs::read(&p).unwrap();
        let t0 = Instant::now();
        let (text, engine) = transcribe(Path::new(&root), Path::new(&p), &bytes).expect("transcription");
        println!("TRANSCRIPT [{} ms] [{}]: {}", t0.elapsed().as_millis(), engine, text);
        if let Ok(want) = std::env::var("DASK_STT_EXPECT_ENGINE") { assert_eq!(engine, want); }
        let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>();
        let got = norm(&text);
        let hits = expect.split_whitespace().filter(|w| got.split_whitespace().any(|g| g == norm(w))).count();
        let total = expect.split_whitespace().count().max(1);
        assert!(hits * 10 >= total * 7, "expected most of '{expect}', got '{text}'");
    }

    /// Real SAPI round trip: DASK_STT_FIXTURE points to a WAV spoken by the local SAPI voice (see tests/hud-agent/stt-roundtrip.ps1).
    #[test]
    #[ignore]
    fn real_sapi_transcribes_a_local_fixture() {
        let p = std::env::var("DASK_STT_FIXTURE").expect("DASK_STT_FIXTURE");
        let expect = std::env::var("DASK_STT_EXPECT").unwrap_or_default().to_lowercase();
        let t0 = Instant::now();
        let text = transcribe_wav(Path::new(&p)).expect("transcription");
        println!("TRANSCRIPT [{} ms]: {}", t0.elapsed().as_millis(), text);
        let got = text.to_lowercase();
        let hits = expect.split_whitespace().filter(|w| got.contains(w)).count();
        let total = expect.split_whitespace().count().max(1);
        assert!(hits * 10 >= total * 7, "expected most of '{expect}', got '{text}'");
    }
}
