//! Offline Windows speech via System.Speech (PowerShell, hidden window).
//!
//! Wake word design (v1.1.1):
//! * Grammar is only the wake phrase ("hey", "hey <name>") — the old free-dictation
//!   backup grammar matched almost any speech and caused false triggers.
//! * A second grammar "hey <dictation>" lets "hey what's up" arrive in one breath:
//!   the wake word's own word-confidence is checked, the rest is the command.
//! * Confidence: engine rejection threshold raised (20 → 45) and the script also
//!   requires the wake word confidence ≥ `min_confidence` (default 0.6).
//! * After a bare "hey" the SAME warm engine switches to dictation immediately
//!   (no new PowerShell / engine spin-up), so the first words aren't lost. The
//!   script prints `WAKE` the moment it hears the wake word; Rust forwards that
//!   as the `stt-wake` event so the UI can show "go ahead" / play an ack.
//! * Every PowerShell PID is tracked so wake + manual listening are cancelable.

use crate::proc;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct SttState {
    /// PID of the active wake-word PowerShell (0 = none).
    pub wake_pid: AtomicU32,
    pub wake_gen: AtomicU64,
    /// PID of the active manual (tap-to-talk) PowerShell (0 = none).
    pub listen_pid: AtomicU32,
    pub listen_gen: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeOutcome {
    /// "wake" | "timeout" | "cancelled"
    pub status: String,
    /// Command spoken after the wake word (may be empty).
    pub text: String,
}

fn not_windows() -> Result<(), String> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err("Offline Windows speech is only available on Windows.".into())
    }
}

/// Keep wake words to plain letters/spaces so they are safe inside a PS string.
fn sanitize_phrase(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphabetic() || *c == ' ' || *c == '\'')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .chars()
        .take(32)
        .collect()
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

const ENGINE_PRELUDE: &str = r#"
Add-Type -AssemblyName System.Speech
$ErrorActionPreference = 'Stop'
function New-Engine {
  try {
    $c = [Globalization.CultureInfo]::GetCultureInfo('en-US')
    $e = New-Object System.Speech.Recognition.SpeechRecognitionEngine $c
  } catch {
    $e = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  }
  $e.SetInputToDefaultAudioDevice()
  return $e
}
"#;

fn listen_script(secs: u32) -> String {
    format!(
        r#"{ENGINE_PRELUDE}
try {{
  $eng = New-Engine
  $dictation = New-Object System.Speech.Recognition.DictationGrammar
  $eng.LoadGrammar($dictation)
  $eng.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
  $eng.BabbleTimeout = [TimeSpan]::FromSeconds(8)
  $eng.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.2)
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
    )
}

fn run_ps_file_tracked(
    script: &str,
    slot: &AtomicU32,
    still_wanted: &dyn Fn() -> bool,
) -> Result<(i32, String, String), String> {
    let path = proc::temp_file("stt", "ps1");
    std::fs::write(&path, script).map_err(|e| format!("Could not write STT script: {e}"))?;
    let _guard = proc::TempFile(path.clone());
    let mut cmd = proc::command("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&path);
    let output = proc::run_tracked_checked(cmd, slot, still_wanted).map_err(|e| format!("Could not start Windows speech: {e}"))?;
    Ok((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    ))
}

/// Tap-to-talk offline dictation. Cancel with `stt_cancel_listen`.
#[tauri::command]
pub async fn stt_listen_windows(
    timeout_secs: Option<u32>,
    state: State<'_, Arc<SttState>>,
) -> Result<String, String> {
    not_windows()?;
    let secs = timeout_secs.unwrap_or(12).clamp(5, 30);
    let st = Arc::clone(&*state);
    // A new manual listen replaces any previous one.
    proc::kill_slot(&st.listen_pid);
    let gen = st.listen_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let st2 = Arc::clone(&st);
    let (code, stdout, stderr) = tauri::async_runtime::spawn_blocking(move || {
        let wanted = || st2.listen_gen.load(Ordering::SeqCst) == gen;
        run_ps_file_tracked(&listen_script(secs), &st2.listen_pid, &wanted)
    })
    .await
    .map_err(|e| format!("STT task failed: {e}"))??;

    if st.listen_gen.load(Ordering::SeqCst) != gen {
        return Err("cancelled".into());
    }
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
        Err("Didn't catch that — tap again and talk after it says Listening.".into())
    } else {
        Ok(stdout)
    }
}

#[tauri::command]
pub async fn stt_cancel_listen(state: State<'_, Arc<SttState>>) -> Result<(), String> {
    let st = Arc::clone(&*state);
    st.listen_gen.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || proc::kill_slot(&st.listen_pid))
        .await
        .map_err(|e| format!("cancel failed: {e}"))
}

fn wake_script(phrases: &[String], head: &str, min_conf: f32, command_secs: u32) -> String {
    let list = phrases.iter().map(|p| ps_quote(p)).collect::<Vec<_>>().join(",");
    format!(
        r#"{ENGINE_PRELUDE}
try {{
  $eng = New-Engine
  $culture = $eng.RecognizerInfo.Culture
  # Default rejection (~90) drops short words; 20 (old) let noise through.
  try {{ $eng.UpdateRecognizerSetting('CFGConfidenceRejectionThreshold', 45) }} catch {{}}

  $choices = New-Object System.Speech.Recognition.Choices
  foreach ($w in @({list})) {{ $choices.Add($w) }}

  $gbWake = New-Object System.Speech.Recognition.GrammarBuilder
  $gbWake.Culture = $culture
  $gbWake.Append($choices)
  $gWake = New-Object System.Speech.Recognition.Grammar($gbWake)
  $gWake.Name = 'wake'
  $eng.LoadGrammar($gWake)

  $gbCmd = New-Object System.Speech.Recognition.GrammarBuilder
  $gbCmd.Culture = $culture
  $gbCmd.Append($choices)
  $gbCmd.AppendDictation()
  $gCmd = New-Object System.Speech.Recognition.Grammar($gbCmd)
  $gCmd.Name = 'wakecmd'
  $eng.LoadGrammar($gCmd)

  $eng.InitialSilenceTimeout = [TimeSpan]::FromSeconds(4)
  $eng.BabbleTimeout = [TimeSpan]::FromSeconds(4)
  $eng.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.6)
  [Console]::Out.WriteLine('READY'); [Console]::Out.Flush()

  $minConf = {min_conf}
  $deadline = (Get-Date).AddMinutes(8)
  while ((Get-Date) -lt $deadline) {{
    $r = $eng.Recognize([TimeSpan]::FromSeconds(6))
    if ($null -eq $r -or $r.Words.Count -eq 0) {{ continue }}
    $first = $r.Words[0]
    if ($first.Text.ToLowerInvariant() -ne '{head}') {{ continue }}
    if ($r.Grammar.Name -eq 'wake') {{
      if ($r.Confidence -lt $minConf) {{ continue }}
      [Console]::Out.WriteLine('WAKE'); [Console]::Out.Flush()
      # Same warm engine → dictation right away so the first words aren't lost.
      $eng.UnloadAllGrammars()
      $eng.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
      $eng.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
      $eng.BabbleTimeout = [TimeSpan]::FromSeconds(8)
      $eng.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.1)
      $c = $eng.Recognize([TimeSpan]::FromSeconds({command_secs}))
      if ($null -ne $c -and -not [string]::IsNullOrWhiteSpace($c.Text)) {{
        [Console]::Out.WriteLine('TEXT:' + $c.Text.Trim())
      }} else {{
        [Console]::Out.WriteLine('TEXT:')
      }}
      [Console]::Out.Flush()
      exit 0
    }}
    # "hey <dictation>": judge the wake word itself, not the free text after it.
    if ($first.Confidence -lt $minConf -or $r.Words.Count -lt 2) {{ continue }}
    [Console]::Out.WriteLine('WAKE')
    [Console]::Out.WriteLine('TEXT:' + $r.Text.Trim())
    [Console]::Out.Flush()
    exit 0
  }}
  exit 1
}} catch {{
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}}
"#
    )
}

/// Arms the offline wake listener. Resolves with `status: "wake"` (+ the command
/// text heard right after it), `"timeout"` after ~8 min of silence, or
/// `"cancelled"` when `stt_cancel_wake` / a newer call replaced it.
/// Engine / mic failures are returned as `Err` so the caller can back off.
#[tauri::command]
pub async fn stt_wait_wake_word(
    app: AppHandle,
    word: Option<String>,
    name: Option<String>,
    min_confidence: Option<f32>,
    state: State<'_, Arc<SttState>>,
) -> Result<WakeOutcome, String> {
    not_windows()?;
    let st = Arc::clone(&*state);
    // Never stack exclusive mic holders.
    proc::kill_slot(&st.wake_pid);
    let gen = st.wake_gen.fetch_add(1, Ordering::SeqCst) + 1;

    let mut wake = sanitize_phrase(word.as_deref().unwrap_or("hey"));
    if wake.is_empty() {
        wake = "hey".into();
    }
    let head = wake.split(' ').next().unwrap_or("hey").to_string();
    let mut phrases = vec![wake.clone()];
    let name = sanitize_phrase(name.as_deref().unwrap_or(""));
    if !name.is_empty() && !wake.ends_with(&name) {
        phrases.push(format!("{wake} {name}"));
    }
    let min_conf = min_confidence.unwrap_or(0.6).clamp(0.3, 0.95);
    let script = wake_script(&phrases, &head.replace('\'', "''"), min_conf, 10);

    let st2 = Arc::clone(&st);
    let app2 = app.clone();
    let (code, text, heard, stderr) = tauri::async_runtime::spawn_blocking(move || {
        let path = proc::temp_file("wake", "ps1");
        std::fs::write(&path, &script).map_err(|e| format!("Could not write wake script: {e}"))?;
        let _guard = proc::TempFile(path.clone());
        let mut child = proc::command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start wake listener: {e}"))?;
        let pid = child.id();
        st2.wake_pid.store(pid, Ordering::SeqCst);
        if st2.wake_gen.load(Ordering::SeqCst) != gen {
            // stt_cancel_wake raced the spawn (e.g. TTS started) — don't hold the mic.
            proc::kill_tree(pid);
        }

        let err_handle = child.stderr.take().map(|mut e| {
            std::thread::spawn(move || {
                let mut b = String::new();
                let _ = std::io::Read::read_to_string(&mut e, &mut b);
                b
            })
        });
        let mut heard = false;
        let mut text = String::new();
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines() {
                let Ok(line) = line else { break };
                let line = line.trim();
                if line == "READY" {
                    let _ = app2.emit("stt-wake-ready", ());
                } else if line == "WAKE" {
                    heard = true;
                    let _ = app2.emit("stt-wake", ());
                } else if let Some(rest) = line.strip_prefix("TEXT:") {
                    text = rest.trim().to_string();
                }
            }
        }
        let status = child.wait();
        let _ = st2
            .wake_pid
            .compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
        let stderr = err_handle.and_then(|h| h.join().ok()).unwrap_or_default();
        let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
        Ok::<_, String>((code, text, heard, stderr.trim().to_string()))
    })
    .await
    .map_err(|e| format!("Wake-word task failed: {e}"))??;

    if st.wake_gen.load(Ordering::SeqCst) != gen {
        return Ok(WakeOutcome {
            status: "cancelled".into(),
            text: String::new(),
        });
    }
    if heard {
        return Ok(WakeOutcome {
            status: "wake".into(),
            text,
        });
    }
    if code == 1 {
        return Ok(WakeOutcome {
            status: "timeout".into(),
            text: String::new(),
        });
    }
    Err(format!(
        "Wake word listener failed: {}",
        if stderr.is_empty() {
            format!("exit {code}")
        } else {
            stderr.chars().take(240).collect()
        }
    ))
}

#[tauri::command]
pub async fn stt_cancel_wake(state: State<'_, Arc<SttState>>) -> Result<(), String> {
    let st = Arc::clone(&*state);
    st.wake_gen.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || proc::kill_slot(&st.wake_pid))
        .await
        .map_err(|e| format!("cancel failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::sanitize_phrase;

    #[test]
    fn sanitizes_wake_words() {
        assert_eq!(sanitize_phrase("  Hey   NOVA!! "), "hey nova");
        assert_eq!(sanitize_phrase("hey'; rm"), "hey' rm");
    }
}
