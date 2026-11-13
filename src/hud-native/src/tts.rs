//! Offline text-to-speech through Windows SAPI (the voices installed on this computer: no network, by construction).
//! One STA worker thread owns the SAPI voice; the HUD sends it `Speak` / `Stop`. Speaking is asynchronous and every new
//! utterance purges the previous one; `Stop` (Emergency Stop, the user starts talking, a new answer) silences it at once.
//! Text is spoken literally (SPF_IS_NOT_XML): markup in an answer can never change voice, volume or play files.

use std::sync::mpsc::{channel, Sender};
use std::thread::JoinHandle;
use tracing::{info, warn};

pub const MAX_TTS_CHARS: usize = 4000;

pub enum TtsCommand {
    Speak(String),
    Stop,
    Shutdown,
}

pub struct Tts {
    tx: Sender<TtsCommand>,
    worker: Option<JoinHandle<()>>,
}

/// Text as it will be spoken: markdown symbols and control characters removed, whitespace collapsed, bounded.
pub fn speakable(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_control() || matches!(c, '#' | '*' | '`' | '_' | '~' | '<' | '>') { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(MAX_TTS_CHARS).collect()
}

impl Tts {
    pub fn start() -> Self {
        let (tx, rx) = channel::<TtsCommand>();
        let worker = std::thread::Builder::new()
            .name("dask-tts".into())
            .spawn(move || {
                use windows::core::{HSTRING, PCWSTR};
                use windows::Win32::Media::Speech::{ISpVoice, SpVoice, SPF_ASYNC, SPF_IS_NOT_XML, SPF_PURGEBEFORESPEAK};
                use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
                unsafe {
                    if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
                        warn!("[TTS] COM could not be initialised; speech is off.");
                        return;
                    }
                    let voice: Option<ISpVoice> = match CoCreateInstance(&SpVoice, None, CLSCTX_ALL) {
                        Ok(v) => Some(v),
                        Err(e) => { warn!("[TTS] No SAPI voice available ({e}); speech is off."); None }
                    };
                    if voice.is_some() { info!("[TTS] SAPI voice ready (local, offline)."); }
                    for cmd in rx {
                        match cmd {
                            TtsCommand::Speak(text) => {
                                if let Some(v) = &voice {
                                    let h = HSTRING::from(text.as_str());
                                    let flags = (SPF_ASYNC.0 | SPF_PURGEBEFORESPEAK.0 | SPF_IS_NOT_XML.0) as u32;
                                    if let Err(e) = v.Speak(PCWSTR(h.as_ptr()), flags, None) { warn!("[TTS] Speak failed: {e}"); }
                                }
                            }
                            TtsCommand::Stop => {
                                if let Some(v) = &voice {
                                    let empty = HSTRING::new();
                                    let _ = v.Speak(PCWSTR(empty.as_ptr()), (SPF_ASYNC.0 | SPF_PURGEBEFORESPEAK.0) as u32, None);
                                }
                            }
                            TtsCommand::Shutdown => break,
                        }
                    }
                    drop(voice);
                    CoUninitialize();
                }
            })
            .expect("tts thread");
        Tts { tx, worker: Some(worker) }
    }

    pub fn speak(&self, text: &str) {
        let t = speakable(text);
        if !t.is_empty() { let _ = self.tx.send(TtsCommand::Speak(t)); }
    }

    pub fn stop(&self) { let _ = self.tx.send(TtsCommand::Stop); }
}

impl Drop for Tts {
    fn drop(&mut self) {
        let _ = self.tx.send(TtsCommand::Shutdown);
        if let Some(w) = self.worker.take() { let _ = w.join(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speakable_text_is_literal_bounded_and_markup_free() {
        assert_eq!(speakable("**Done.**\n\n`ok`  <volume level=\"100\"/>"), "Done. ok volume level=\"100\"/");
        assert_eq!(speakable(&"a".repeat(MAX_TTS_CHARS + 10)).len(), MAX_TTS_CHARS);
        assert_eq!(speakable("\u{0007}\u{001b}[31m"), "[31m");
    }

    /// Real SAPI on this machine: speak (async) then stop at once. Ignored by default (it makes sound).
    #[test]
    #[ignore]
    fn real_sapi_speaks_and_stops() {
        let t = Tts::start();
        t.speak("D-ASK offline voice test.");
        std::thread::sleep(std::time::Duration::from_millis(300));
        t.stop();
        drop(t);
    }
}
