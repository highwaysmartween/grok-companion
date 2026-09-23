//! Offline Windows speech via System.Speech. Scripts run from a temp .ps1 file
//! (more reliable than powershell -Command with long strings).
//!
//! Wake word root cause (why "hey" didn't fire):
//! 1) Default CFGConfidenceRejectionThreshold (~90) rejects short keywords like "hey".
//! 2) A single long Recognize() held the mic exclusively and competed with tap-to-talk.
//! Fix: lower rejection threshold, expand aliases, short Recognize windows, dictation
//! backup, and stt_cancel_wake so tap-to-talk can free the device.

use std::fs;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

pub struct SttState {
    /// PID of the active wake-word PowerShell (0 = none).
    pub wake_pid: Arc<AtomicU32>,
    pub wake_script: Mutex<Option<std::path::PathBuf>>,
}

impl Default for SttState {
    fn default() -> Self {
        Self {
            wake_pid: Arc::new(AtomicU32::new(0)),
            wake_script: Mutex::new(None),
        }
    }
}

fn kill_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn run_ps_file(script: &str) -> Result<(i32, String, String), String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("grok-stt-{stamp}.ps1"));
    fs::write(&path, script).map_err(|e| format!("Could not write STT script: {e}"))?;

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.to_str().ok_or("bad STT script path")?,
        ])
        .output()
        .map_err(|e| format!("Could not start Windows speech: {e}"))?;

    let _ = fs::remove_file(&path);
    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok((code, stdout, stderr))
}

#[tauri::command]
pub async fn stt_listen_windows(timeout_secs: Option<u32>) -> Result<String, String> {
    let secs = timeout_secs.unwrap_or(12).clamp(5, 30);
    let script = format!(
        r#"
Add-Type -AssemblyName System.Speech
$ErrorActionPreference = 'Stop'
try {{
  $culture = [Globalization.CultureInfo]::GetCultureInfo('en-US')
  try {{
    $eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine $culture
  }} catch {{
    $eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  }}
  $eng.SetInputToDefaultAudioDevice()
  $dictation = New-Object System.Speech.Recognition.DictationGrammar
  $eng.LoadGrammar($dictation)
  $eng.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
  $eng.BabbleTimeout = [TimeSpan]::FromSeconds(5)
  $eng.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.8)
  $result = $eng.Recognize([TimeSpan]::FromSeconds({secs}))
  if ($null -eq $result -or [string]::IsNullOrWhiteSpace($result.Text)) {{
    Write-Output ''
  }} else {{
    Write-Output $result.Text.Trim()
  }}
}} catch {{
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}}
"#
    );

    let (code, stdout, stderr) = tauri::async_runtime::spawn_blocking(move || run_ps_file(&script))
        .await
        .map_err(|e| format!("STT task failed: {e}"))??;

    if code != 0 {
        let detail = if stderr.is_empty() {
            "engine error (no details)".into()
        } else {
            stderr
        };
        return Err(format!(
            "Windows speech failed: {detail}. Check mic privacy (Settings → Privacy → Microphone) and that English speech is installed."
        ));
    }
    if stdout.is_empty() {
        Err("Didn't catch speech — tap again, speak clearly after Listening appears.".into())
    } else {
        Ok(stdout)
    }
}

#[tauri::command]
pub async fn stt_wait_wake_word(
    word: Option<String>,
    state: State<'_, SttState>,
) -> Result<String, String> {
    let wake = word.unwrap_or_else(|| "hey".into());
    let wake_esc = wake.replace('\'', "''");

    // Kill any prior wake listener so we never stack exclusive mic holders.
    kill_pid(state.wake_pid.swap(0, Ordering::SeqCst));
    if let Ok(mut slot) = state.wake_script.lock() {
        if let Some(path) = slot.take() {
            let _ = fs::remove_file(path);
        }
    }

    let script = format!(
        r#"
Add-Type -AssemblyName System.Speech
$ErrorActionPreference = 'Stop'
try {{
  $culture = [Globalization.CultureInfo]::GetCultureInfo('en-US')
  try {{
    $eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine $culture
  }} catch {{
    $eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  }}
  $eng.SetInputToDefaultAudioDevice()
  # Root cause fix: default CFGConfidenceRejectionThreshold (~90) drops short
  # wake words like "hey". Lower it so a clear "hey" actually fires.
  try {{ $eng.UpdateRecognizerSetting('CFGConfidenceRejectionThreshold', 20) }} catch {{}}
  try {{ $eng.UpdateRecognizerSetting('CFG_Confidence_Rejection_Threshold', 20) }} catch {{}}

  $gb = New-Object System.Speech.Recognition.GrammarBuilder
  $gb.Culture = $culture
  $choices = New-Object System.Speech.Recognition.Choices
  foreach ($w in @('{wake}','hay','hey','hi','hey nova','hey there','hi nova','okay hey','hi there')) {{
    $choices.Add($w)
  }}
  $gb.Append($choices)
  $kw = New-Object System.Speech.Recognition.Grammar($gb)
  $kw.Name = 'wake'
  $eng.LoadGrammar($kw)

  # Light dictation backup — catches "hey …" when keyword grammar misses.
  $dict = New-Object System.Speech.Recognition.DictationGrammar
  $dict.Name = 'dict'
  try {{ $dict.Weight = 0.35 }} catch {{}}
  $eng.LoadGrammar($dict)

  $eng.InitialSilenceTimeout = [TimeSpan]::FromSeconds(2.5)
  $eng.BabbleTimeout = [TimeSpan]::FromSeconds(1.5)
  $eng.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.45)

  $deadline = (Get-Date).AddMinutes(8)
  while ((Get-Date) -lt $deadline) {{
    $result = $eng.Recognize([TimeSpan]::FromSeconds(4))
    if ($null -eq $result) {{ continue }}
    $t = $result.Text.Trim().ToLowerInvariant()
    if (
      $t -match '\bhey\b' -or
      $t -match '\bhay\b' -or
      $t -match '\bhi\b' -or
      $t -eq '{wake}' -or
      $t.StartsWith('hey') -or
      $t.StartsWith('hay') -or
      $t.StartsWith('hi')
    ) {{
      Write-Output 'hey'
      exit 0
    }}
  }}
  Write-Output ''
  exit 1
}} catch {{
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}}
"#,
        wake = wake_esc
    );

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("grok-wake-{stamp}.ps1"));
    fs::write(&path, &script).map_err(|e| format!("Could not write wake script: {e}"))?;
    if let Ok(mut slot) = state.wake_script.lock() {
        *slot = Some(path.clone());
    }

    let path_str = path.to_string_lossy().to_string();
    let wake_pid = Arc::clone(&state.wake_pid);

    let (code, stdout, stderr) = tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &path_str,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start wake listener: {e}"))?;

        wake_pid.store(child.id(), Ordering::SeqCst);
        let output = child
            .wait_with_output()
            .map_err(|e| format!("Wake listener failed: {e}"))?;
        wake_pid.store(0, Ordering::SeqCst);

        let _ = fs::remove_file(&path_str);
        let code = output.status.code().unwrap_or(-1);
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok::<_, String>((code, stdout, stderr))
    })
    .await
    .map_err(|e| format!("Wake-word task failed: {e}"))??;

    if let Ok(mut slot) = state.wake_script.lock() {
        *slot = None;
    }

    if code == 2 {
        return Err(format!(
            "Wake word failed: {}",
            if stderr.is_empty() {
                "unknown"
            } else {
                &stderr
            }
        ));
    }
    if stdout == "hey" {
        Ok("hey".into())
    } else {
        Err("Wake-word listen timed out.".into())
    }
}

#[tauri::command]
pub fn stt_cancel_wake(state: State<'_, SttState>) -> Result<(), String> {
    kill_pid(state.wake_pid.swap(0, Ordering::SeqCst));
    if let Ok(mut slot) = state.wake_script.lock() {
        if let Some(path) = slot.take() {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}
