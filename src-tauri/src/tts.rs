//! Natural TTS via Microsoft Edge neural voices (edge-tts). Falls back with a clear error.
//!
//! Windows install if missing:
//!   py -3 -m pip install --user edge-tts
//!   (or) pip install --user edge-tts
//! Then ensure `%APPDATA%\Python\Python3*\Scripts` or user Scripts is on PATH,
//! or we will try `py -3 -m edge_tts` / `python -m edge_tts` automatically.
//! Frontend falls back to Web Speech if this command errors.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

pub struct TtsState {
    pub cancel: AtomicBool,
    pub gen: AtomicU64,
    pub play_pid: Mutex<Option<u32>>,
}

impl Default for TtsState {
    fn default() -> Self {
        Self {
            cancel: AtomicBool::new(false),
            gen: AtomicU64::new(0),
            play_pid: Mutex::new(None),
        }
    }
}

fn try_edge_tts(voice: &str, text: &str, out: &str) -> bool {
    // 1) edge-tts on PATH
    if let Ok(s) = Command::new("edge-tts")
        .args(["--voice", voice, "--text", text, "--write-media", out])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        if s.success() && PathBuf::from(out).exists() {
            return true;
        }
    }

    // 2) Common Windows user-local Scripts shims
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        if let Ok(rd) = std::fs::read_dir(PathBuf::from(appdata).join("Python")) {
            for ent in rd.flatten() {
                candidates.push(ent.path().join("Scripts").join("edge-tts.exe"));
                candidates.push(ent.path().join("Scripts").join("edge-tts"));
            }
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local)
                .join("Programs")
                .join("Python")
                .join("Scripts")
                .join("edge-tts.exe"),
        );
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        candidates.push(
            PathBuf::from(profile)
                .join("AppData")
                .join("Roaming")
                .join("Python"),
        );
    }
    for c in &candidates {
        if !c.exists() {
            continue;
        }
        if let Ok(s) = Command::new(c)
            .args(["--voice", voice, "--text", text, "--write-media", out])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            if s.success() && PathBuf::from(out).exists() {
                return true;
            }
        }
    }

    // 3) python -m edge_tts / py -3 -m edge_tts
    for (bin, prefix) in [
        ("py", vec!["-3", "-m", "edge_tts"]),
        ("python", vec!["-m", "edge_tts"]),
        ("python3", vec!["-m", "edge_tts"]),
    ] {
        let mut args: Vec<&str> = prefix;
        args.extend(["--voice", voice, "--text", text, "--write-media", out]);
        if let Ok(s) = Command::new(bin)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            if s.success() && PathBuf::from(out).exists() {
                return true;
            }
        }
    }
    false
}

#[tauri::command]
pub fn tts_speak_natural(
    text: String,
    voice: Option<String>,
    state: State<'_, TtsState>,
) -> Result<(), String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Ok(());
    }
    let trimmed = if trimmed.chars().count() > 800 {
        trimmed.chars().take(800).collect::<String>() + "…"
    } else {
        trimmed
    };

    // Default: en-HK-YanNeural (East Asian teen/young woman speaking English).
    let voice = voice
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "en-HK-YanNeural".to_string());

    let gen = state.gen.fetch_add(1, Ordering::SeqCst) + 1;
    state.cancel.store(false, Ordering::SeqCst);

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out: PathBuf = std::env::temp_dir().join(format!("grok-companion-tts-{stamp}.mp3"));
    let out_str = out.to_str().ok_or("bad temp path")?.to_string();

    let ok = try_edge_tts(&voice, &trimmed, &out_str);

    if !ok {
        let _ = std::fs::remove_file(&out);
        return Err(
            "Could not synthesize natural voice. Install: py -3 -m pip install --user edge-tts (needs network). App will fall back to Web Speech."
                .into(),
        );
    }

    if state.cancel.load(Ordering::SeqCst) || state.gen.load(Ordering::SeqCst) != gen {
        let _ = std::fs::remove_file(&out);
        return Ok(());
    }

    let path = out
        .canonicalize()
        .unwrap_or(out.clone())
        .to_string_lossy()
        .replace('\'', "''");

    let ps = format!(
        r#"
Add-Type -AssemblyName presentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([Uri]'{path}')
$sw = [Diagnostics.Stopwatch]::StartNew()
while (-not $p.NaturalDuration.HasTimeSpan) {{
  Start-Sleep -Milliseconds 50
  if ($sw.ElapsedMilliseconds -gt 8000) {{ break }}
}}
$p.Volume = 1
$p.Play()
$dur = if ($p.NaturalDuration.HasTimeSpan) {{ $p.NaturalDuration.TimeSpan.TotalMilliseconds }} else {{ 15000 }}
$sw.Restart()
while ($sw.ElapsedMilliseconds -lt ($dur + 200)) {{
  Start-Sleep -Milliseconds 120
}}
$p.Stop()
$p.Close()
"#
    );

    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not play voice: {e}"))?;

    if let Ok(mut slot) = state.play_pid.lock() {
        *slot = Some(child.id());
    }

    let status = child.wait().map_err(|e| format!("Playback failed: {e}"))?;
    if let Ok(mut slot) = state.play_pid.lock() {
        *slot = None;
    }
    let _ = std::fs::remove_file(&out);

    if !status.success() && state.gen.load(Ordering::SeqCst) == gen {
        return Err("Playback ended unexpectedly.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn tts_stop(state: State<'_, TtsState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::SeqCst);
    state.gen.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut slot) = state.play_pid.lock() {
        if let Some(pid) = slot.take() {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn tts_default_voice() -> String {
    "en-HK-YanNeural".into()
}
