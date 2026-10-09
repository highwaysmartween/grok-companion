//! Offline Windows speech via System.Speech (PowerShell, hidden window).
//!
//! Wake word design (v1.1.1):
//! * Grammar is only the wake phrase ("hey", "hey <name>") — the old free-dictation
//!   backup grammar matched almost any speech and caused false triggers.
//! * No "hey <dictation>" grammar: it out-scored the wake grammar on every real
//!   utterance and the result was rejected, so the wake word never fired.
//! * Confidence: engine rejection threshold raised (20 → 45) and the script also
//!   requires the wake word confidence ≥ `min_confidence` (default 0.45).
//! * After a bare "hey" the SAME warm engine switches to dictation immediately
//!   (no new PowerShell / engine spin-up), so the first words aren't lost. The
//!   script prints `WAKE` the moment it hears the wake word; Rust forwards that
//!   as the `stt-wake` event so the UI can show "go ahead" / play an ack.
//! * Every PowerShell PID is tracked so wake + manual listening are cancelable.

use crate::proc;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
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
    /// 0 = untested, 1 = Whisper works, 2 = Whisper unavailable (use System.Speech).
    pub whisper: AtomicU8,
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

// --- Whisper (preferred) ------------------------------------------------------
//
// The System.Speech desktop recogniser is a 2006-era engine: on this kind of
// laptop mic it turns "hey Nova, what's the weather" into "if to have it has"
// and rejects the bare wake word. When Python + faster-whisper are installed we
// run `whisper_stt.py` instead (fully offline, same READY/WAKE/TEXT protocol)
// and only fall back to System.Speech if it is unavailable (exit 3).

const WHISPER_PY: &str = include_str!("whisper_stt.py");
const WHISPER_UNAVAILABLE: i32 = 3;

fn python_candidates() -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let base = std::path::PathBuf::from(local)
            .join("Programs")
            .join("Python");
        if let Ok(rd) = std::fs::read_dir(&base) {
            let mut dirs: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            dirs.sort();
            dirs.reverse(); // newest PythonNNN first
            for d in dirs {
                let exe = d.join("python.exe");
                if exe.is_file() {
                    out.push(vec![exe.to_string_lossy().to_string()]);
                }
            }
        }
    }
    out.push(vec!["py".into(), "-3".into()]);
    out.push(vec!["python".into()]);
    out
}

fn whisper_command(args: &[String]) -> Option<(std::process::Command, proc::TempFile)> {
    let path = proc::temp_file("whisper", "py");
    std::fs::write(&path, WHISPER_PY).ok()?;
    let guard = proc::TempFile(path.clone());
    // First launcher that exists on disk / resolves; failures surface as exit codes.
    let launcher = python_candidates().into_iter().find(|c| {
        let p = std::path::Path::new(&c[0]);
        p.is_absolute() && p.is_file() || !p.is_absolute()
    })?;
    let mut cmd = proc::command(&launcher[0]);
    cmd.args(&launcher[1..])
        .arg("-u")
        .arg(&path)
        .args(args)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .env("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
        .env("HF_HUB_DISABLE_PROGRESS_BARS", "1");
    Some((cmd, guard))
}

fn whisper_allowed(st: &SttState) -> bool {
    cfg!(windows) && st.whisper.load(Ordering::SeqCst) != 2
}

fn note_whisper(st: &SttState, code: i32, stderr: &str) {
    if code == WHISPER_UNAVAILABLE {
        eprintln!("[stt] whisper unavailable, using System.Speech: {stderr}");
        st.whisper.store(2, Ordering::SeqCst);
    } else if code == 0 || code == 1 {
        st.whisper.store(1, Ordering::SeqCst);
    }
}

/// Last `TEXT:` line of the helper's stdout.
fn text_line(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .find_map(|l| l.trim().strip_prefix("TEXT:").map(|t| t.trim().to_string()))
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
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(&path);
    let output = proc::run_tracked_checked(cmd, slot, still_wanted)
        .map_err(|e| format!("Could not start Windows speech: {e}"))?;
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
        if whisper_allowed(&st2) {
            if let Some((cmd, _guard)) =
                whisper_command(&["listen".into(), "--secs".into(), secs.to_string()])
            {
                match proc::run_tracked_checked(cmd, &st2.listen_pid, &wanted) {
                    Ok(o) => {
                        let code = o.status.code().unwrap_or(-1);
                        let out = String::from_utf8_lossy(&o.stdout).to_string();
                        let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                        note_whisper(&st2, code, &err);
                        if code != WHISPER_UNAVAILABLE {
                            let text = if code == 0 {
                                text_line(&out).unwrap_or_default()
                            } else {
                                String::new()
                            };
                            return Ok((code, text, err));
                        }
                    }
                    Err(e) => {
                        eprintln!("[stt] could not start whisper: {e}");
                        st2.whisper.store(2, Ordering::SeqCst);
                    }
                }
                if !wanted() {
                    return Ok((0, String::new(), String::new()));
                }
            }
        }
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
            "Speech recognition failed: {detail}. Check mic privacy (Settings → Privacy → Microphone)."
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
    let list = phrases
        .iter()
        .map(|p| ps_quote(p))
        .collect::<Vec<_>>()
        .join(",");
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

  # No "hey <dictation>" grammar: on real mics it out-scored the wake grammar on
  # every utterance ("hey have an", conf 0.00) and got rejected, so "hey nova"
  # never fired. Bare wake grammar → dictation on the same warm engine instead.

  $eng.BabbleTimeout = [TimeSpan]::FromSeconds(4)
  $eng.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.6)
  # Continuous async recognition. The old one-shot Recognize(6s) loop never
  # returned the wake phrase on the Conexant laptop mic (its noise floor keeps
  # the engine "in speech" until the timeout); RecognizeAsync(Multiple) hears it.
  $global:wq = [Collections.Queue]::Synchronized((New-Object Collections.Queue))
  $null = Register-ObjectEvent -InputObject $eng -EventName SpeechRecognized -SourceIdentifier 'wk' -Action {{ $global:wq.Enqueue($EventArgs.Result) }}
  $eng.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  [Console]::Out.WriteLine('READY'); [Console]::Out.Flush()

  $minConf = {min_conf}
  $deadline = (Get-Date).AddMinutes(8)
  $woke = $false
  while ((Get-Date) -lt $deadline) {{
    if ($global:wq.Count -eq 0) {{ Start-Sleep -Milliseconds 100; continue }}
    $r = $global:wq.Dequeue()
    if ($null -eq $r -or $r.Words.Count -eq 0) {{ continue }}
    [Console]::Out.WriteLine('HEARD:' + $r.Text + ' conf=' + [Math]::Round($r.Confidence, 2)); [Console]::Out.Flush()
    if ($r.Words[0].Text.ToLowerInvariant() -ne '{head}') {{ continue }}
    if ($r.Confidence -lt $minConf) {{ continue }}
    $woke = $true
    break
  }}
  $eng.RecognizeAsyncCancel()
  Unregister-Event -SourceIdentifier 'wk' -ErrorAction SilentlyContinue
  if (-not $woke) {{ exit 1 }}
  [Console]::Out.WriteLine('WAKE'); [Console]::Out.Flush()
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ([string]$eng.AudioState -ne 'Stopped' -and $sw.ElapsedMilliseconds -lt 1500) {{ Start-Sleep -Milliseconds 20 }}
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
    // Measured on the Conexant laptop mic: real "hey nova" scores 0.56–0.79,
    // so 0.6 dropped about half of them. Engine rejection (45) still filters noise.
    let min_conf = min_confidence.unwrap_or(0.45).clamp(0.3, 0.95);
    let script = wake_script(&phrases, &head.replace('\'', "''"), min_conf, 10);

    let st2 = Arc::clone(&st);
    let app2 = app.clone();
    let whisper_args: Vec<String> = vec![
        "wake".into(),
        "--secs".into(),
        "480".into(),
        "--command-secs".into(),
        "10".into(),
        "--name".into(),
        name.clone(),
    ];
    let (code, text, heard, stderr) = tauri::async_runtime::spawn_blocking(move || {
        if whisper_allowed(&st2) {
            if let Some((cmd, _guard)) = whisper_command(&whisper_args) {
                match run_wake_child(cmd, &st2, gen, &app2) {
                    Ok(r) => {
                        note_whisper(&st2, r.0, &r.3);
                        if r.0 != WHISPER_UNAVAILABLE || r.2 {
                            return Ok(r);
                        }
                    }
                    Err(e) => {
                        eprintln!("[stt] could not start whisper wake: {e}");
                        st2.whisper.store(2, Ordering::SeqCst);
                    }
                }
                if st2.wake_gen.load(Ordering::SeqCst) != gen {
                    return Ok((0, String::new(), false, String::new()));
                }
            }
        }
        let path = proc::temp_file("wake", "ps1");
        std::fs::write(&path, &script).map_err(|e| format!("Could not write wake script: {e}"))?;
        let _guard = proc::TempFile(path.clone());
        let mut cmd = proc::command("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&path);
        run_wake_child(cmd, &st2, gen, &app2)
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

/// Spawn a wake listener (Whisper or System.Speech), forward READY/WAKE as
/// events, and return (exit code, command text, heard wake word, stderr).
fn run_wake_child(
    mut cmd: std::process::Command,
    st2: &SttState,
    gen: u64,
    app2: &AppHandle,
) -> Result<(i32, String, bool, String), String> {
    let mut child = cmd
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
    Ok((code, text, heard, stderr.trim().to_string()))
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
