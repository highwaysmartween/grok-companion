//! Grok brain: xAI Chat Completions API and/or local `grok` CLI (OAuth).
//! API keys never leave the Rust side.

use crate::memory;
use crate::settings;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

pub const XAI_CHAT_URL: &str = "https://api.x.ai/v1/chat/completions";
pub const XAI_MODELS_URL: &str = "https://api.x.ai/v1/models";
pub const DEFAULT_MODEL: &str = "grok-4.6";

pub struct GrokState {
    pub cancel: AtomicBool,
}

impl GrokState {
    pub fn new() -> Self {
        Self {
            cancel: AtomicBool::new(false),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum ChatStreamEvent {
    Started { request_id: String, model: String },
    Delta { request_id: String, text: String },
    Done { request_id: String, full_text: String },
    Error { request_id: String, message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub connected: bool,
    pub has_api_key: bool,
    pub message: String,
    pub models: Vec<String>,
}

fn personality_flavor(personality: &str) -> &'static str {
    match personality {
        "witty" => "Lean into dry humor and clever asides, but stay kind.",
        "calm" => "Be calm, grounding, and unhurried. Short soft sentences.",
        "coach" => "Be an encouraging coach: clear, practical, a little spark.",
        "scientist" => "Be a curious space scientist: precise, wondrous, never stuffy.",
        "firstdate" => "Soft first-date energy — use only if user picks it.",
        "chill" => "You are 18, East Asian, speak natural English. Chill and low-key — not cutesy, not bubbly, no baby talk or constant giggles. Dry humor ok. Keep it real.",
        _ => "Be a cosmic companion: playful, loyal, a little starlight in your voice.",
    }
}

fn build_system_prompt(app: &AppHandle) -> String {
    let s = settings::load_settings(app);
    let memories = memory::format_for_prompt(app);
    format!(
        "You are {name}, an 18-year-old East Asian girl companion who speaks English.\n\
Personality: {flavor}\n\
Vibe: chill teen, not girly or bubbly. Natural English. Short replies.\n\
{user_prompt}\n\
{memories}",
        name = s.companion_name,
        flavor = personality_flavor(&s.personality),
        user_prompt = s.system_prompt,
        memories = memories
    )
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("GrokCompanion/0.1")
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("Could not build HTTP client: {e}"))
}

fn resolve_grok_cli() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("GROK_CLI_PATH") {
        let pb = PathBuf::from(p.trim());
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let candidate = PathBuf::from(&home).join(".grok").join("bin").join("grok.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
        let candidate2 = PathBuf::from(&home).join(".grok").join("bin").join("grok");
        if candidate2.is_file() {
            return Some(candidate2);
        }
    }
    // PATH lookup
    let which = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = Command::new(which).arg("grok").output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = text.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn provider_choice(app: &AppHandle) -> String {
    let s = settings::load_settings(app);
    let p = s.brain_provider.trim().to_lowercase();
    if p == "auto" {
        if resolve_grok_cli().is_some() {
            "grok-cli".into()
        } else if settings::load_api_key(app).is_some() {
            "xai-api".into()
        } else {
            "grok-cli".into()
        }
    } else if p == "xai-api" || p == "api" {
        "xai-api".into()
    } else {
        "grok-cli".into()
    }
}

#[tauri::command]
pub fn cancel_chat(state: State<Arc<GrokState>>) -> Result<(), String> {
    state.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn check_connection(app: AppHandle) -> Result<ConnectionStatus, String> {
    let provider = provider_choice(&app);
    if provider == "grok-cli" {
        return match resolve_grok_cli() {
            Some(path) => Ok(ConnectionStatus {
                connected: true,
                has_api_key: true,
                message: format!("Using Grok CLI ({})", path.display()),
                models: fallback_models(),
            }),
            None => Ok(ConnectionStatus {
                connected: false,
                has_api_key: false,
                message: "Grok CLI not found. Install the Grok CLI or switch brain to xAI API in Settings.".into(),
                models: fallback_models(),
            }),
        };
    }

    let Some(api_key) = settings::load_api_key(&app) else {
        return Ok(ConnectionStatus {
            connected: false,
            has_api_key: false,
            message: "No API key saved. Open Settings and paste your xAI key (or use Grok CLI brain).".into(),
            models: fallback_models(),
        });
    };

    let client = http_client()?;
    let res = client
        .get(XAI_MODELS_URL)
        .bearer_auth(&api_key)
        .send()
        .await;

    match res {
        Ok(resp) if resp.status().is_success() => {
            let models = parse_model_ids(resp.json::<Value>().await.unwrap_or(json!({})));
            Ok(ConnectionStatus {
                connected: true,
                has_api_key: true,
                message: "Connected to xAI API".into(),
                models: if models.is_empty() {
                    fallback_models()
                } else {
                    models
                },
            })
        }
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            Ok(ConnectionStatus {
                connected: false,
                has_api_key: true,
                message: parse_api_error(status.as_u16(), &body),
                models: fallback_models(),
            })
        }
        Err(e) => Ok(ConnectionStatus {
            connected: false,
            has_api_key: true,
            message: format!("Network error: {e}"),
            models: fallback_models(),
        }),
    }
}

#[tauri::command]
pub async fn list_models(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(check_connection(app).await?.models)
}

fn fallback_models() -> Vec<String> {
    vec![
        "grok-4.6".into(),
        "grok-4.5".into(),
        "grok-4.3".into(),
        "grok-4".into(),
        "grok-3".into(),
        "grok-3-mini".into(),
    ]
}

fn parse_model_ids(v: Value) -> Vec<String> {
    let mut ids: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(|s| s.to_string()))
                .filter(|id| id.starts_with("grok-"))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    if let Some(pos) = ids.iter().position(|m| m == DEFAULT_MODEL) {
        ids.swap(0, pos);
    }
    ids
}

fn truncate(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(n).collect::<String>())
    }
}

fn build_cli_prompt(app: &AppHandle, messages: &[ChatMessage]) -> String {
    let system = build_system_prompt(app);
    let mut parts = vec![
        "Follow the system instructions below. Reply as the companion only — no meta commentary.".to_string(),
        format!("=== SYSTEM ===\n{system}"),
        "=== CONVERSATION ===".to_string(),
    ];
    for m in messages {
        if m.role == "system" {
            continue;
        }
        let label = if m.role == "user" { "User" } else { "Assistant" };
        parts.push(format!("{label}: {}", m.content.trim()));
    }
    parts.push("Assistant:".into());
    parts.join("\n\n")
}

fn stream_text_as_deltas(
    on_event: &Channel<ChatStreamEvent>,
    request_id: &str,
    full: &str,
    cancel: &AtomicBool,
) {
    // Fake-stream in ~24-char chunks so the UI animates.
    let chars: Vec<char> = full.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let end = (i + 24).min(chars.len());
        let chunk: String = chars[i..end].iter().collect();
        let _ = on_event.send(ChatStreamEvent::Delta {
            request_id: request_id.to_string(),
            text: chunk,
        });
        i = end;
    }
}

fn run_grok_cli(
    app: &AppHandle,
    messages: &[ChatMessage],
    on_event: &Channel<ChatStreamEvent>,
    request_id: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let cli = resolve_grok_cli().ok_or_else(|| {
        "Grok CLI not found at %USERPROFILE%\\.grok\\bin\\grok.exe. Install Grok CLI or switch brain to xAI API.".to_string()
    })?;
    let prompt = build_cli_prompt(app, messages);
    let _ = on_event.send(ChatStreamEvent::Started {
        request_id: request_id.to_string(),
        model: "grok-cli".into(),
    });

    let mut child = Command::new(&cli)
        .arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("plain")
        .arg("--max-turns")
        .arg("1")
        .arg("--permission-mode")
        .arg("dontAsk")
        .arg("--disable-web-search")
        .arg("--verbatim")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start Grok CLI: {e}"))?;

    let stdout = child.stdout.take().ok_or("No stdout from Grok CLI")?;
    let reader = BufReader::new(stdout);
    let mut full = String::new();
    for line in reader.lines() {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            break;
        }
        let line = line.map_err(|e| format!("CLI read error: {e}"))?;
        if !full.is_empty() {
            full.push('\n');
        }
        full.push_str(&line);
    }
    let mut err_buf = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = std::io::Read::read_to_string(&mut stderr, &mut err_buf);
    }
    let status = child.wait().map_err(|e| format!("CLI wait error: {e}"))?;
    let full = full.trim().to_string();
    if full.is_empty() && !status.success() {
        return Err(format!(
            "Grok CLI failed (exit {}). {}",
            status.code().unwrap_or(-1),
            truncate(&err_buf, 240)
        ));
    }
    if full.is_empty() {
        return Err("Grok CLI returned an empty reply.".into());
    }
    stream_text_as_deltas(on_event, request_id, &full, cancel);
    Ok(full)
}

#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    state: State<'_, Arc<GrokState>>,
    messages: Vec<ChatMessage>,
    on_event: Channel<ChatStreamEvent>,
) -> Result<(), String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    state.cancel.store(false, Ordering::SeqCst);

    let provider = provider_choice(&app);
    if provider == "grok-cli" {
        let cancel_flag = Arc::clone(&*state);
        let app2 = app.clone();
        let on2 = on_event.clone();
        let rid = request_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            run_grok_cli(&app2, &messages, &on2, &rid, &cancel_flag.cancel)
        })
        .await
        .map_err(|e| format!("CLI task join error: {e}"))?;

        match result {
            Ok(full_text) => {
                let _ = on_event.send(ChatStreamEvent::Done {
                    request_id,
                    full_text,
                });
                Ok(())
            }
            Err(message) => {
                let _ = on_event.send(ChatStreamEvent::Error {
                    request_id,
                    message: message.clone(),
                });
                Err(message)
            }
        }
    } else {
        chat_stream_api(app, state, messages, on_event, request_id).await
    }
}

async fn chat_stream_api(
    app: AppHandle,
    state: State<'_, Arc<GrokState>>,
    messages: Vec<ChatMessage>,
    on_event: Channel<ChatStreamEvent>,
    request_id: String,
) -> Result<(), String> {
    let Some(api_key) = settings::load_api_key(&app) else {
        let msg = "No API key saved. Open Settings and paste your xAI key, or switch Brain to Grok CLI.".to_string();
        let _ = on_event.send(ChatStreamEvent::Error {
            request_id: request_id.clone(),
            message: msg.clone(),
        });
        return Err(msg);
    };

    let settings = settings::load_settings(&app);
    let model = if settings.model.trim().is_empty() {
        DEFAULT_MODEL.to_string()
    } else {
        settings.model.clone()
    };

    let _ = on_event.send(ChatStreamEvent::Started {
        request_id: request_id.clone(),
        model: model.clone(),
    });

    let mut payload_messages = Vec::new();
    payload_messages.push(json!({
        "role": "system",
        "content": build_system_prompt(&app),
    }));
    for m in &messages {
        if m.role == "system" {
            continue;
        }
        payload_messages.push(json!({
            "role": m.role,
            "content": m.content,
        }));
    }

    let body = json!({
        "model": model,
        "messages": payload_messages,
        "stream": true,
        "temperature": settings.temperature,
        "max_tokens": settings.max_tokens,
    });

    let client = http_client()?;
    let response = client
        .post(XAI_CHAT_URL)
        .bearer_auth(&api_key)
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            let msg = format!("Could not reach xAI: {e}");
            let _ = on_event.send(ChatStreamEvent::Error {
                request_id: request_id.clone(),
                message: msg.clone(),
            });
            msg
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let err_body = response.text().await.unwrap_or_default();
        let message = parse_api_error(status.as_u16(), &err_body);
        let _ = on_event.send(ChatStreamEvent::Error {
            request_id: request_id.clone(),
            message: message.clone(),
        });
        return Err(message);
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut full_text = String::new();

    while let Some(chunk) = stream.next().await {
        if state.cancel.load(Ordering::SeqCst) {
            let _ = on_event.send(ChatStreamEvent::Done {
                request_id: request_id.clone(),
                full_text: full_text.clone(),
            });
            return Ok(());
        }

        let bytes = chunk.map_err(|e| {
            let msg = format!("Stream interrupted: {e}");
            let _ = on_event.send(ChatStreamEvent::Error {
                request_id: request_id.clone(),
                message: msg.clone(),
            });
            msg
        })?;

        buffer.push_str(&String::from_utf8_lossy(&bytes));

        loop {
            let sep = match buffer.find('\n') {
                Some(i) => i,
                None => break,
            };
            let mut line = buffer[..sep].to_string();
            buffer.drain(..=sep);
            if line.ends_with('\r') {
                line.pop();
            }
            let line = line.trim();
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                let _ = on_event.send(ChatStreamEvent::Done {
                    request_id: request_id.clone(),
                    full_text: full_text.clone(),
                });
                return Ok(());
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if let Some(err) = v.get("error") {
                    let message = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("xAI stream error")
                        .to_string();
                    let _ = on_event.send(ChatStreamEvent::Error {
                        request_id: request_id.clone(),
                        message: message.clone(),
                    });
                    return Err(message);
                }
                if let Some(text) = v
                    .pointer("/choices/0/delta/content")
                    .and_then(|c| c.as_str())
                {
                    if !text.is_empty() {
                        full_text.push_str(text);
                        let _ = on_event.send(ChatStreamEvent::Delta {
                            request_id: request_id.clone(),
                            text: text.to_string(),
                        });
                    }
                }
            }
        }
    }

    let _ = on_event.send(ChatStreamEvent::Done {
        request_id,
        full_text,
    });
    Ok(())
}

fn parse_api_error(status: u16, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = v.pointer("/error/message").and_then(|m| m.as_str()) {
            let lower = msg.to_lowercase();
            if status == 403
                || lower.contains("credit")
                || lower.contains("permission-denied")
                || lower.contains("license")
            {
                return format!(
                    "xAI {status}: {msg} — your team needs API credits at console.x.ai. Tip: switch Brain to Grok CLI in Settings to use your signed-in Grok account instead."
                );
            }
            return format!("xAI {status}: {msg}");
        }
        if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
            return format!("xAI {status}: {msg}");
        }
    }
    format!("xAI {status}: {}", truncate(body, 200))
}
