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
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;

const TTS_SERVER_PY: &str = include_str!("tts_server.py");
type Pending = Arc<Mutex<HashMap<String, Sender<Result<(), String>>>>>;

pub struct TtsState {
    /// Bumped by every speak + stop; a speak whose generation is stale exits quietly.
    pub gen: AtomicU64,
    pub synth_pid: AtomicU32,
    pub play_pid: AtomicU32,
    /// Cached working edge-tts launcher (program + prefix args) so we don't
    /// probe five candidates on every utterance.
    launcher: Mutex<Option<Vec<String>>>,
    /// Warm edge-tts helper (v1.2): 0 = untried, 1 = running ok, 2 = unavailable.
    server_ok: AtomicU8,
    pub server_pid: AtomicU32,
    server_stdin: Mutex<Option<ChildStdin>>,
    pending: Pending,
    server_script: Mutex<Option<proc::TempFile>>,
}

impl Default for TtsState {
    fn default() -> Self {
        Self {
            gen: AtomicU64::new(0),
            synth_pid: AtomicU32::new(0),
            play_pid: AtomicU32::new(0),
            launcher: Mutex::new(None),
            server_ok: AtomicU8::new(0),
            server_pid: AtomicU32::new(0),
            server_stdin: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            server_script: Mutex::new(None),
        }
    }
}

fn server_reset(state: &TtsState) {
    if let Ok(mut g) = state.server_stdin.lock() {
        *g = None;
    }
    proc::kill_slot(&state.server_pid);
    if let Ok(mut p) = state.pending.lock() {
        for (_, tx) in p.drain() {
            let _ = tx.send(Err("tts helper restarted".into()));
        }
    }
}

pub fn shutdown(state: &TtsState) {
    server_reset(state);
}

fn ensure_server(state: &TtsState) -> Result<(), String> {
    if state.server_ok.load(Ordering::SeqCst) == 2 {
        return Err("edge-tts helper unavailable".into());
    }
    if state.server_pid.load(Ordering::SeqCst) != 0
        && state.server_stdin.lock().map(|g| g.is_some()).unwrap_or(false)
    {
        return Ok(());
    }
    server_reset(state);
    let path = proc::temp_file("tts-serve", "py");
    std::fs::write(&path, TTS_SERVER_PY).map_err(|e| e.to_string())?;
    let mut last = String::from("no python");
    for launcher in crate::stt::python_candidates() {
        let mut cmd = proc::command(&launcher[0]);
        cmd.args(&launcher[1..])
            .arg("-u")
            .arg(&path)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let Ok(mut child) = cmd.spawn() else { continue };
        let pid = child.id();
        let stdin = child.stdin.take();
        let Some(stdout) = child.stdout.take() else { continue };
        let mut reader = BufReader::new(stdout);
        let mut first = String::new();
        let _ = reader.read_line(&mut first);
        if first.trim() != "LOADED" {
            let _ = child.wait();
            last = format!("helper did not start ({})", launcher.join(" "));
            continue;
        }
        let pending = Arc::clone(&state.pending);
        std::thread::spawn(move || {
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let mut it = line.trim().splitn(3, ' ');
                let (Some(kind), Some(id)) = (it.next(), it.next()) else { continue };
                let msg = it.next().unwrap_or("").to_string();
                if let Some(tx) = pending.lock().ok().and_then(|mut p| p.remove(id)) {
                    let _ = tx.send(if kind == "OK" { Ok(()) } else { Err(msg) });
                }
            }
            let _ = child.wait();
            if let Ok(mut p) = pending.lock() {
                for (_, tx) in p.drain() {
                    let _ = tx.send(Err("tts helper exited".into()));
                }
            }
        });
        state.server_pid.store(pid, Ordering::SeqCst);
        if let Ok(mut g) = state.server_stdin.lock() {
            *g = stdin;
        }
        if let Ok(mut g) = state.server_script.lock() {
            *g = Some(proc::TempFile(path));
        }
        state.server_ok.store(1, Ordering::SeqCst);
        return Ok(());
    }
    state.server_ok.store(2, Ordering::SeqCst);
    Err(last)
}

/// Synthesize via the warm helper. Err → caller falls back to the CLI path.
fn synth_server(state: &TtsState, voice: &str, text: &str, out: &str) -> Result<(), String> {
    ensure_server(state)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    state.pending.lock().map_err(|_| "lock")?.insert(id.clone(), tx);
    let req = serde_json::json!({ "id": id, "text": text, "voice": voice, "out": out }).to_string();
    let sent = state
        .server_stdin
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().map(|w| writeln!(w, "{req}").and_then(|_| w.flush()).is_ok()))
        .unwrap_or(false);
    if !sent {
        server_reset(state);
        return Err("tts helper stdin closed".into());
    }
    match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(r) => r,
        Err(_) => {
            if let Ok(mut p) = state.pending.lock() {
                p.remove(&id);
            }
            Err("tts helper timed out".into())
        }
    }
}

fn clean_voice(voice: Option<String>) -> String {
    voice
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| crate::settings::DEFAULT_VOICE.to_string())
}

/// Synthesize one sentence to mp3 bytes (played by the webview; no PowerShell
/// start-up per sentence). Prefers the warm helper, then the edge-tts CLI.
fn synth_bytes(state: &TtsState, text: &str, voice: &str) -> Result<Vec<u8>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("empty".into());
    }
    let out = proc::TempFile(proc::temp_file("tts", "mp3"));
    let out_str = out.0.to_string_lossy().to_string();
    let via_server = synth_server(state, voice, text, &out_str);
    if let Err(e) = &via_server {
        eprintln!("[tts] helper failed ({e}); using edge-tts CLI");
        let gen = state.gen.load(Ordering::SeqCst);
        match synthesize(state, gen, voice, text, &out_str) {
            Synth::Ok => {}
            Synth::Cancelled => return Err("stopped".into()),
            Synth::Failed(d) => return Err(format!("Could not synthesize natural voice ({d})")),
        }
    }
    let bytes = std::fs::read(&out.0).map_err(|e| format!("read voice file: {e}"))?;
    if bytes.is_empty() {
        return Err("empty voice file".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn tts_synth(
    text: String,
    voice: Option<String>,
    state: State<'_, Arc<TtsState>>,
) -> Result<tauri::ipc::Response, String> {
    let st = Arc::clone(&*state);
    let voice = clean_voice(voice);
    let bytes = tauri::async_runtime::spawn_blocking(move || synth_bytes(&st, &text, &voice))
        .await
        .map_err(|e| format!("TTS task failed: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Warm the helper at startup so the first reply isn't paying Python start-up.
pub fn prewarm(state: Arc<TtsState>) {
    std::thread::spawn(move || {
        if cfg!(windows) {
            let _ = ensure_server(&state);
        }
    });
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
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName presentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([Uri]::new('{path}'))
$sw = [Diagnostics.Stopwatch]::StartNew()
while (-not $p.NaturalDuration.HasTimeSpan) {{
  Start-Sleep -Milliseconds 30
  if ($sw.ElapsedMilliseconds -gt 6000) {{ break }}
}}
if (-not $p.NaturalDuration.HasTimeSpan) {{
  [Console]::Error.WriteLine('MediaPlayer could not open the voice file')
  exit 3
}}
$p.Volume = 1
$p.Play()
$dur = $p.NaturalDuration.TimeSpan.TotalMilliseconds
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

    // NOT canonicalize(): on Windows that returns `\\?\C:\...`, which [Uri] rejects
    // ("hostname could not be parsed") so MediaPlayer never opens and she is silent.
    // temp_dir() is already absolute.
    let path = out.0.clone();
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
        Ok(o) => Err(format!(
            "Playback failed: {}",
            String::from_utf8_lossy(&o.stderr).trim().chars().take(200).collect::<String>()
        )),
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
