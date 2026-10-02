//! Natural TTS via Microsoft Edge neural voices (edge-tts), played with a
//! hidden PowerShell MediaPlayer. Falls back with a clear error so the frontend
//! can use Web Speech instead.
//!
//! Windows install if missing:
//!   py -3 -m pip install --user edge-tts
//!
//! Commands are async (run on a blocking worker, never the main thread) and
//! every child (synth + playback) registers its PID so `tts_stop` can kill it
//! immediately for barge-in.

use crate::proc;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct TtsState {
    /// Bumped by every speak + stop; a speak whose generation is stale exits quietly.
    pub gen: AtomicU64,
    pub synth_pid: AtomicU32,
    pub play_pid: AtomicU32,
    /// Cached working edge-tts launcher (program + prefix args) so we don't
    /// probe five candidates on every utterance.
    launcher: Mutex<Option<Vec<String>>>,
}

impl Default for TtsState {
    fn default() -> Self {
        Self {
            gen: AtomicU64::new(0),
            synth_pid: AtomicU32::new(0),
            play_pid: AtomicU32::new(0),
            launcher: Mutex::new(None),
        }
    }
}

impl TtsState {
    fn is_current(&self, gen: u64) -> bool {
        self.gen.load(Ordering::SeqCst) == gen
    }
}

fn launcher_candidates() -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = vec![vec!["edge-tts".into()]];
    let mut scripts: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        if let Ok(rd) = std::fs::read_dir(PathBuf::from(appdata).join("Python")) {
            for ent in rd.flatten() {
                scripts.push(ent.path().join("Scripts").join("edge-tts.exe"));
            }
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(local).join("Programs").join("Python");
        if let Ok(rd) = std::fs::read_dir(&base) {
            for ent in rd.flatten() {
                scripts.push(ent.path().join("Scripts").join("edge-tts.exe"));
            }
        }
    }
    for p in scripts.into_iter().filter(|p| p.is_file()) {
        out.push(vec![p.to_string_lossy().to_string()]);
    }
    out.push(vec!["py".into(), "-3".into(), "-m".into(), "edge_tts".into()]);
    out.push(vec!["python".into(), "-m".into(), "edge_tts".into()]);
    out.push(vec!["python3".into(), "-m".into(), "edge_tts".into()]);
    out
}

enum Synth {
    Ok,
    Cancelled,
    Failed(String),
}

fn synth_with(state: &TtsState, gen: u64, launcher: &[String], voice: &str, text: &str, out: &str) -> Synth {
    let Some((prog, prefix)) = launcher.split_first() else {
        return Synth::Failed("empty launcher".into());
    };
    let mut cmd = proc::command(prog);
    cmd.args(prefix)
        .arg("--voice")
        .arg(voice)
        // `--text=` form so text starting with '-' isn't parsed as a flag.
        .arg(format!("--text={text}"))
        .arg("--write-media")
        .arg(out);
    let res = proc::run_tracked_checked(cmd, &state.synth_pid, &|| state.is_current(gen));
    if !state.is_current(gen) {
        return Synth::Cancelled;
    }
    match res {
        Ok(o) if o.status.success()
            && std::fs::metadata(out).map(|m| m.len() > 0).unwrap_or(false) =>
        {
            Synth::Ok
        }
        Ok(o) => Synth::Failed(String::from_utf8_lossy(&o.stderr).trim().chars().take(200).collect()),
        Err(e) => Synth::Failed(e),
    }
}

fn synthesize(state: &TtsState, gen: u64, voice: &str, text: &str, out: &str) -> Synth {
    let cached = state.launcher.lock().ok().and_then(|g| g.clone());
    if let Some(l) = cached {
        // Launcher known-good: a failure now is most likely network — don't
        // burn seconds probing other launchers before the Web Speech fallback.
        return synth_with(state, gen, &l, voice, text, out);
    }
    let mut last = String::from("edge-tts not found");
    for cand in launcher_candidates() {
        match synth_with(state, gen, &cand, voice, text, out) {
            Synth::Ok => {
                if let Ok(mut g) = state.launcher.lock() {
                    *g = Some(cand);
                }
                return Synth::Ok;
            }
            Synth::Cancelled => return Synth::Cancelled,
            Synth::Failed(e) => last = e,
        }
    }
    Synth::Failed(last)
}

fn play_script(path: &str) -> String {
    let path = path.replace('\'', "''");
    format!(
        r#"
Add-Type -AssemblyName presentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([Uri]'{path}')
$sw = [Diagnostics.Stopwatch]::StartNew()
while (-not $p.NaturalDuration.HasTimeSpan) {{
  Start-Sleep -Milliseconds 30
  if ($sw.ElapsedMilliseconds -gt 6000) {{ break }}
}}
$p.Volume = 1
$p.Play()
$dur = if ($p.NaturalDuration.HasTimeSpan) {{ $p.NaturalDuration.TimeSpan.TotalMilliseconds }} else {{ 15000 }}
$sw.Restart()
while ($sw.ElapsedMilliseconds -lt ($dur + 150)) {{
  Start-Sleep -Milliseconds 60
}}
$p.Stop()
$p.Close()
"#
    )
}

/// "done" when playback finished, "stopped" when cancelled by tts_stop or a newer utterance.
fn speak_blocking(state: &TtsState, text: String, voice: Option<String>) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("Natural voice playback is only implemented on Windows; using Web Speech.".into());
    }
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Ok("done".into());
    }
    let trimmed = if trimmed.chars().count() > 800 {
        trimmed.chars().take(800).collect::<String>() + "…"
    } else {
        trimmed
    };
    // Default: en-HK-YanNeural (East Asian young woman speaking English).
    let voice = voice
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| crate::settings::DEFAULT_VOICE.to_string());

    let gen = state.gen.fetch_add(1, Ordering::SeqCst) + 1;
    let out = proc::TempFile(proc::temp_file("tts", "mp3"));
    let out_str = out.0.to_string_lossy().to_string();

    match synthesize(state, gen, &voice, &trimmed, &out_str) {
        Synth::Ok => {}
        Synth::Cancelled => return Ok("stopped".into()),
        Synth::Failed(detail) => {
            return Err(format!(
                "Could not synthesize natural voice ({detail}). Install: py -3 -m pip install --user edge-tts (needs network). Falling back to Web Speech."
            ))
        }
    }
    if !state.is_current(gen) {
        return Ok("stopped".into());
    }

    let path = out.0.canonicalize().unwrap_or(out.0.clone());
    let mut cmd = proc::command("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &play_script(&path.to_string_lossy()),
    ]);
    let res = proc::run_tracked_checked(cmd, &state.play_pid, &|| state.is_current(gen));
    if !state.is_current(gen) {
        return Ok("stopped".into());
    }
    match res {
        Ok(o) if o.status.success() => Ok("done".into()),
        Ok(_) => Err("Playback ended unexpectedly.".into()),
        Err(e) => Err(format!("Could not play voice: {e}")),
    }
}

#[tauri::command]
pub async fn tts_speak_natural(
    text: String,
    voice: Option<String>,
    state: State<'_, Arc<TtsState>>,
) -> Result<String, String> {
    let st = Arc::clone(&*state);
    tauri::async_runtime::spawn_blocking(move || speak_blocking(&st, text, voice))
        .await
        .map_err(|e| format!("TTS task failed: {e}"))?
}

/// Stop synth + playback right now (barge-in). Safe to call when idle.
#[tauri::command]
pub async fn tts_stop(state: State<'_, Arc<TtsState>>) -> Result<(), String> {
    let st = Arc::clone(&*state);
    st.gen.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        proc::kill_slot(&st.synth_pid);
        proc::kill_slot(&st.play_pid);
    })
    .await
    .map_err(|e| format!("TTS stop failed: {e}"))
}

#[tauri::command]
pub fn tts_default_voice() -> String {
    crate::settings::DEFAULT_VOICE.into()
}
