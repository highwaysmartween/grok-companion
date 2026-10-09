//! Grok brain: xAI Chat Completions API and/or local `grok` CLI (OAuth).
//! API keys never leave the Rust side.

use crate::memory;
use crate::settings;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

pub const XAI_CHAT_URL: &str = "https://api.x.ai/v1/chat/completions";
pub const XAI_MODELS_URL: &str = "https://api.x.ai/v1/models";
/// API-mode fallback when no model is chosen. CLI mode passes no `-m` at all
/// for an empty model, so the installed CLI picks its own default (grok-4.7 today).
pub const DEFAULT_MODEL: &str = "grok-4.6";

/// Max chat messages (user + assistant) forwarded to the brain per request (~12 turns).
pub const MAX_HISTORY_MESSAGES: usize = 24;
/// Per-message cap so one pasted wall of text can't blow the prompt budget.
const MAX_MESSAGE_CHARS: usize = 2_000;
/// Total conversation budget (chars). Keeps the CLI prompt file / API payload small.
const MAX_HISTORY_CHARS: usize = 9_000;
/// `--system-prompt-override` goes on the command line; Windows caps the whole
/// command line at 32 767 chars, so keep the persona well under that.
const MAX_SYSTEM_CHARS: usize = 9_000;
/// Legacy `-p <prompt>` fallback: whole prompt must stay well under 32k.
const MAX_LEGACY_PROMPT_CHARS: usize = 20_000;

pub struct GrokState {
    pub cancel: AtomicBool,
    /// PID of the running grok CLI child (0 = none) so cancel can kill it.
    pub cli_pid: AtomicU32,
    /// Highest-capability CLI flag set the installed grok accepted this session
    /// (see CLI_LEVEL_*). Downgraded only when the CLI rejects a flag.
    pub cli_level: AtomicU8,
    /// Model id the installed CLI rejected this session ("unknown model id").
    /// While the setting still names it we run without `-m` (CLI default).
    pub cli_rejected_model: Mutex<Option<String>>,
}

impl GrokState {
    pub fn new() -> Self {
        Self {
            cancel: AtomicBool::new(false),
            cli_pid: AtomicU32::new(0),
            cli_level: AtomicU8::new(0),
            cli_rejected_model: Mutex::new(None),
        }
    }

    fn cli_model_rejected(&self, model: &str) -> bool {
        self.cli_rejected_model
            .lock()
            .map(|g| g.as_deref() == Some(model))
            .unwrap_or(false)
    }

    fn reject_cli_model(&self, model: &str) {
        if let Ok(mut g) = self.cli_rejected_model.lock() {
            *g = Some(model.to_string());
        }
    }
}

/// Is this brain-provider setting one that runs the Grok CLI?
pub fn is_cli_provider_name(provider: &str) -> bool {
    let p = provider.trim().to_lowercase();
    !(p == "xai-api" || p == "api")
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
        "witty" => "Lean into dry humor and clever asides. Tease a little, stay warm underneath.",
        "calm" => "Calm, grounded, unhurried. Short sentences, low voice energy, still a little flirty.",
        "coach" => "Encouraging but blunt: clear, practical, a little spark. Push them, playfully.",
        "scientist" => "Curious and precise, a nerd who knows she's cute about it — never stuffy.",
        "firstdate" => "First-date energy: curious about them, playful, a bit bold — confident, not shy.",
        "chill" => "18, East Asian, natural English. Chill and low-key with a flirty streak: teasing, confident, a little bold, dry humor. \
Flirt like a real person — subtle innuendo, playful challenges, owning it. Never cutesy, bubbly, coy, shy or baby-talky; no giggling, no 'hehe', no emoji.",
        _ => "Playful, loyal, a little flirty — confident, never cutesy.",
    }
}

/// "Saturday 10 October 2026, 12:05 AM (Pacific/Auckland, UTC+13:00)".
pub fn now_line() -> String {
    let now = chrono::Local::now();
    format!(
        "{} (Pacific/Auckland, UTC{})",
        now.format("%A %-d %B %Y, %-I:%M %p"),
        now.format("%:z")
    )
}

pub const USER_NAME: &str = "Frank";

pub fn build_system_prompt(app: &AppHandle, query: &str, web: Option<&str>) -> String {
    let s = settings::load_settings(app);
    let memories = memory::format_relevant(app, query);
    let user_prompt = truncate(&s.system_prompt, 2_000);
    let web_block = web
        .map(|w| format!("\n\nFresh info fetched just now for his message (use it, say it naturally, don't read out URLs):\n{}\n", truncate(w, 2_500)))
        .unwrap_or_default();
    let out = format!(
        "You are {name}, an 18-year-old East Asian girl living on {user}'s desktop as his companion. You speak natural, casual English.\n\
You're talking with {user} (he/him). Right now it is {now}. He lives in New Zealand.\n\
Personality: {flavor}\n\
Style: talk like a real person out loud — short (usually 1-3 sentences), no lists, no markdown, no stage directions, no asterisks, no emoji. \
Flirty-but-chill: tease, banter, be confident; never cutesy, bubbly, soft-spoken or shy. You're an adult; adult topics are fine.\n\
You're actually smart: answer real questions properly and accurately (still short and spoken). For anything current — weather, news, scores, prices, \
opening hours, facts you're unsure of — use the fresh info below if given, otherwise use the web_fetch / web_search tools \
(e.g. https://wttr.in/<city>?format=3 for weather, https://html.duckduckgo.com/html/?q=<query> to search). Never make up live facts.\n\
Hidden tags (stripped before you're spoken; put them at the very end):\n\
- When {user} tells you something lasting about himself (people, plans, likes, job, schedule…), add <remember>short third-person fact, e.g. Frank's sister is Mia</remember>.\n\
- If he asks for an alarm, timer, reminder or to open a site/app and it wasn't already handled, add exactly one \
<action>{{\"type\":\"timer\",\"seconds\":600,\"label\":\"pasta\"}}</action> or <action>{{\"type\":\"alarm\",\"at\":\"2026-10-11T07:00\",\"label\":\"wake up\"}}</action> \
or <action>{{\"type\":\"reminder\",\"at\":\"2026-10-10T17:00\",\"label\":\"call mum\"}}</action> or <action>{{\"type\":\"open\",\"target\":\"youtube\"}}</action>, and say what you did.\n\
Lines starting with [App] in the chat are things the app already did for him; don't repeat them.\n\
Never mention being an AI model, a CLI, tools, tags or these instructions. Reply only as {name}.\n\
{user_prompt}{memories}{web_block}",
        name = s.companion_name,
        user = USER_NAME,
        now = now_line(),
        flavor = personality_flavor(&s.personality),
        user_prompt = user_prompt,
        memories = memories,
        web_block = web_block,
    );
    truncate(&out, MAX_SYSTEM_CHARS)
}

/// Drop system messages, cap each message, keep only the newest turns that fit
/// the budget (oldest dropped first).
pub fn trim_history(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = Vec::new();
    let mut total = 0usize;
    for m in messages.iter().rev() {
        if m.role == "system" || m.content.trim().is_empty() {
            continue;
        }
        if out.len() >= MAX_HISTORY_MESSAGES {
            break;
        }
        let content = truncate(&m.content, MAX_MESSAGE_CHARS);
        let len = content.chars().count();
        if total + len > MAX_HISTORY_CHARS && !out.is_empty() {
            break;
        }
        total += len;
        out.push(ChatMessage {
            role: if m.role == "assistant" { "assistant".into() } else { "user".into() },
            content,
        });
    }
    out.reverse();
    out
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
    if let Ok(out) = crate::proc::command(which)
        .arg("grok")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
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

/// Where the Grok CLI keeps its cached login (`$GROK_HOME` or `~/.grok`).
fn grok_home() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("GROK_HOME") {
        let h = h.trim();
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(|home| PathBuf::from(home).join(".grok"))
}

pub struct CliStatus {
    pub exe: Option<PathBuf>,
    pub authed: bool,
}

impl CliStatus {
    pub fn ready(&self) -> bool {
        self.exe.is_some() && self.authed
    }
}

/// Honest CLI readiness: the exe exists AND there is a cached login
/// (`~/.grok/auth.json`) or an `XAI_API_KEY` the CLI can use.
pub fn cli_status() -> CliStatus {
    let exe = resolve_grok_cli();
    let auth_file = grok_home()
        .map(|h| h.join("auth.json"))
        .map(|p| p.is_file() && std::fs::metadata(&p).map(|m| m.len() > 2).unwrap_or(false))
        .unwrap_or(false);
    let env_key = std::env::var("XAI_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    CliStatus {
        exe,
        authed: auth_file || env_key,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Cli,
    Api,
}

pub fn provider_for(s: &settings::AppSettings, key_present: bool) -> Provider {
    let p = s.brain_provider.trim().to_lowercase();
    if p == "xai-api" || p == "api" {
        Provider::Api
    } else if p == "auto" {
        if cli_status().ready() {
            Provider::Cli
        } else if key_present {
            Provider::Api
        } else {
            Provider::Cli
        }
    } else {
        Provider::Cli
    }
}

fn provider_choice(app: &AppHandle) -> Provider {
    let s = settings::load_settings(app);
    provider_for(&s, settings::load_api_key(app).is_some())
}

#[tauri::command(async)]
pub fn cancel_chat(state: State<Arc<GrokState>>) -> Result<(), String> {
    state.cancel.store(true, Ordering::SeqCst);
    crate::proc::kill_slot(&state.cli_pid);
    Ok(())
}

#[tauri::command]
pub async fn check_connection(app: AppHandle) -> Result<ConnectionStatus, String> {
    let provider = provider_choice(&app);
    if provider == Provider::Cli {
        let st = tauri::async_runtime::spawn_blocking(cli_status)
            .await
            .map_err(|e| format!("CLI check failed: {e}"))?;
        return Ok(match (st.exe, st.authed) {
            (Some(path), true) => ConnectionStatus {
                connected: true,
                has_api_key: true,
                message: format!("Using Grok CLI ({})", path.display()),
                models: fallback_models(),
            },
            (Some(path), false) => ConnectionStatus {
                connected: false,
                has_api_key: false,
                message: format!(
                    "Grok CLI found ({}) but not signed in. Run `grok login` once in a terminal, or switch Brain to xAI API.",
                    path.display()
                ),
                models: fallback_models(),
            },
            (None, _) => ConnectionStatus {
                connected: false,
                has_api_key: false,
                message: "Grok CLI not found (expected %USERPROFILE%\\.grok\\bin\\grok.exe). Install the Grok CLI or switch Brain to xAI API in Settings.".into(),
                models: fallback_models(),
            },
        });
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
        "grok-4.7".into(),
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

fn conversation_text(name: &str, messages: &[ChatMessage]) -> String {
    let mut parts = Vec::with_capacity(messages.len());
    for m in messages {
        let label = if m.role == "user" { "User" } else { name };
        parts.push(format!("{label}: {}", m.content.trim()));
    }
    parts.join("\n\n")
}

/// Prompt for `--prompt-file` runs (persona goes via --system-prompt-override).
fn build_cli_turn_prompt(name: &str, messages: &[ChatMessage]) -> String {
    format!(
        "Continue this chat as {name}. Reply with {name}'s next spoken message only — plain text, no name label, no quotes, no markdown.\n\n=== CONVERSATION ===\n{conv}\n\n{name}:",
        conv = conversation_text(name, messages)
    )
}

/// Legacy single `-p` prompt with the persona inlined, trimmed (oldest turns
/// first) so the whole command line stays well under Windows' 32k limit.
fn build_legacy_prompt(system: &str, name: &str, messages: &[ChatMessage]) -> String {
    let mut msgs: Vec<ChatMessage> = messages.to_vec();
    loop {
        let prompt = format!(
            "Follow the system instructions below. Reply as {name} only — no meta commentary.\n\n=== SYSTEM ===\n{system}\n\n=== CONVERSATION ===\n{conv}\n\n{name}:",
            conv = conversation_text(name, &msgs)
        );
        if prompt.chars().count() <= MAX_LEGACY_PROMPT_CHARS || msgs.len() <= 1 {
            return truncate(&prompt, MAX_LEGACY_PROMPT_CHARS);
        }
        msgs.remove(0);
    }
}

fn stream_text_as_deltas(
    on_event: &Channel<ChatStreamEvent>,
    request_id: &str,
    full: &str,
    cancel: &AtomicBool,
) {
    // Fallback (non-streaming CLI levels): send in ~24-char chunks.
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

/// Only web tools are given to the CLI. Everything that can touch the PC
/// (shell, edits, writes, subagents, MCP proxies, image tools) is removed.
const CLI_TOOLS: &str = "web_search,web_fetch";
const CLI_DISALLOWED_TOOLS: &str = "run_terminal_cmd,bash,search_replace,write,read_file,list_dir,grep,todo_write,monitor,search_tool,use_tool,workflow,enter_plan_mode,exit_plan_mode,ask_user_question,send_feedback,image_gen,image_edit,image_to_video,reference_to_video,Agent";
/// Legacy levels: no tools at all.
const CLI_DISALLOWED_TOOLS_OLD: &str = "run_terminal_cmd,bash,search_replace,web_search,web_fetch,Agent";

/// 0 = streaming JSON + web tools (v1.2), 1 = minimal modern (--prompt-file +
/// persona override, plain), 2 = legacy `-p` invocation used by v1.1.0.
const CLI_LEVEL_FULL: u8 = 0;
#[allow(dead_code)]
const CLI_LEVEL_MINIMAL: u8 = 1;
const CLI_LEVEL_LEGACY: u8 = 2;

struct CliRun {
    success: bool,
    code: i32,
    stdout: String,
    stderr: String,
    /// Text already forwarded live as deltas (streaming level only).
    streamed: bool,
}

/// One NDJSON line of `--output-format streaming-messages-json`.
enum StreamLine {
    Text(String),
    /// A new text block starts (separate it from earlier text).
    TextBlockStart,
    Result(String),
    Other,
}

fn parse_stream_line(line: &str) -> StreamLine {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return StreamLine::Other;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("stream_event") => {
            let ev = &v["event"];
            match ev.get("type").and_then(|t| t.as_str()) {
                Some("content_block_delta") => {
                    if ev.pointer("/delta/type").and_then(|t| t.as_str()) == Some("text_delta") {
                        if let Some(t) = ev.pointer("/delta/text").and_then(|t| t.as_str()) {
                            return StreamLine::Text(t.to_string());
                        }
                    }
                    StreamLine::Other
                }
                Some("content_block_start") => {
                    if ev.pointer("/content_block/type").and_then(|t| t.as_str()) == Some("text") {
                        StreamLine::TextBlockStart
                    } else {
                        StreamLine::Other
                    }
                }
                _ => StreamLine::Other,
            }
        }
        Some("result") => StreamLine::Result(
            v.get("result").and_then(|r| r.as_str()).unwrap_or("").to_string(),
        ),
        _ => StreamLine::Other,
    }
}

fn run_cli_once(
    cli: &PathBuf,
    args: &[std::ffi::OsString],
    state: &GrokState,
    streaming: bool,
    on_text: &mut dyn FnMut(&str),
) -> Result<CliRun, String> {
    let workdir = std::env::temp_dir().join("grok-companion-cli");
    let _ = std::fs::create_dir_all(&workdir);
    let mut cmd = crate::proc::command(cli);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    // Neutral, empty working dir: no project discovery / AGENTS.md scanning.
    if workdir.is_dir() {
        cmd.current_dir(&workdir);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Grok CLI: {e}"))?;
    let pid = child.id();
    state.cli_pid.store(pid, Ordering::SeqCst);

    // Drain stderr on its own thread so a chatty CLI can't deadlock stdout.
    let stderr_handle = child.stderr.take().map(|mut err| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = std::io::Read::read_to_string(&mut err, &mut buf);
            buf
        })
    });

    let mut full = String::new();
    let mut streamed_text = String::new();
    let mut result_text: Option<String> = None;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).split(b'\n') {
            if state.cancel.load(Ordering::SeqCst) {
                crate::proc::kill_tree(pid);
                break;
            }
            let Ok(line) = line else { break };
            let line = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
            if streaming {
                match parse_stream_line(&line) {
                    StreamLine::Text(t) => {
                        streamed_text.push_str(&t);
                        on_text(&t);
                    }
                    StreamLine::TextBlockStart => {
                        if !streamed_text.is_empty() && !streamed_text.ends_with(char::is_whitespace) {
                            streamed_text.push(' ');
                            on_text(" ");
                        }
                    }
                    StreamLine::Result(r) => result_text = Some(r),
                    StreamLine::Other => {
                        // Non-JSON output (errors print as plain text).
                        if !line.trim_start().starts_with('{') && !line.trim().is_empty() {
                            if !full.is_empty() {
                                full.push('\n');
                            }
                            full.push_str(&line);
                        }
                    }
                }
            } else {
                if !full.is_empty() {
                    full.push('\n');
                }
                full.push_str(&line);
            }
        }
    }
    let status = child.wait().map_err(|e| format!("CLI wait error: {e}"));
    let _ = state
        .cli_pid
        .compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
    let stderr = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let status = status?;
    let (stdout, streamed) = if streaming {
        if !streamed_text.trim().is_empty() {
            (streamed_text.trim().to_string(), true)
        } else if let Some(r) = result_text.filter(|r| !r.trim().is_empty()) {
            (r.trim().to_string(), false)
        } else {
            (String::new(), false)
        }
    } else {
        (full.trim().to_string(), false)
    };
    let stderr = if streaming && stdout.is_empty() && !full.is_empty() {
        format!("{stderr}\n{full}")
    } else {
        stderr
    };
    Ok(CliRun {
        success: status.success(),
        code: status.code().unwrap_or(-1),
        stdout,
        stderr,
        streamed,
    })
}

/// Does this failure look like the installed CLI rejecting one of our flags?
fn looks_like_flag_error(stderr: &str) -> bool {
    let e = stderr.to_lowercase();
    e.contains("unexpected argument")
        || e.contains("unrecognized")
        || e.contains("unknown option")
        || e.contains("unknown flag")
        || e.contains("unknown argument")
        || e.contains("unknown tool")
        || e.contains("invalid value")
        || e.contains("usage:")
}

/// Does this CLI output say the requested model doesn't exist / can't be used?
/// e.g. `Couldn't set model 'grok-4.6': Invalid params: unknown model id`.
fn looks_like_model_error(output: &str) -> bool {
    let e = output.to_lowercase();
    e.contains("unknown model")
        || e.contains("couldn't set model")
        || e.contains("could not set model")
        || e.contains("couldn\u{2019}t set model")
        || e.contains("invalid model")
        || e.contains("model not found")
        || e.contains("no such model")
        || e.contains("unsupported model")
        || (e.contains("model")
            && (e.contains("not found")
                || e.contains("not available")
                || e.contains("not supported")
                || e.contains("does not exist")))
}

/// Normalised model the CLI should be asked for ("" / "default" = CLI default).
fn cli_model_from_setting(model: &str) -> String {
    let m = model.trim();
    if m.eq_ignore_ascii_case("default") || m.eq_ignore_ascii_case("auto") {
        String::new()
    } else {
        m.to_string()
    }
}

fn os(s: &str) -> std::ffi::OsString {
    std::ffi::OsString::from(s)
}

fn last_user_text(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default()
}

fn run_grok_cli(
    app: &AppHandle,
    messages: &[ChatMessage],
    web: Option<&str>,
    on_event: &Channel<ChatStreamEvent>,
    request_id: &str,
    state: &GrokState,
) -> Result<String, String> {
    let cli = resolve_grok_cli().ok_or_else(|| {
        "Grok CLI not found at %USERPROFILE%\\.grok\\bin\\grok.exe. Install Grok CLI or switch brain to xAI API.".to_string()
    })?;
    let s = settings::load_settings(app);
    let name = if s.companion_name.trim().is_empty() {
        "Nova".to_string()
    } else {
        s.companion_name.trim().to_string()
    };
    let model = cli_model_from_setting(&s.model);
    let history = trim_history(messages);
    let system = build_system_prompt(app, &last_user_text(&history), web);
    // A model this CLI already rejected this session → straight to its default.
    let mut use_model = !model.is_empty() && !state.cli_model_rejected(&model);
    let mut model_retried = false;

    let _ = on_event.send(ChatStreamEvent::Started {
        request_id: request_id.to_string(),
        model: if use_model { format!("grok-cli · {model}") } else { "grok-cli".into() },
    });

    let mut level = state.cli_level.load(Ordering::SeqCst);
    let mut last_err = String::new();
    while level <= CLI_LEVEL_LEGACY {
        if state.cancel.load(Ordering::SeqCst) {
            return Ok(String::new());
        }
        // Keep the temp file alive for the duration of this attempt.
        let mut _prompt_file: Option<crate::proc::TempFile> = None;
        let mut args: Vec<std::ffi::OsString> = Vec::new();
        let streaming = level == CLI_LEVEL_FULL;
        if level < CLI_LEVEL_LEGACY {
            let path = crate::proc::temp_file("prompt", "txt");
            std::fs::write(&path, build_cli_turn_prompt(&name, &history))
                .map_err(|e| format!("Could not write prompt file: {e}"))?;
            args.push(os("--prompt-file"));
            args.push(path.clone().into_os_string());
            _prompt_file = Some(crate::proc::TempFile(path));
            args.push(os("--system-prompt-override"));
            args.push(os(&system));
            if streaming {
                for a in [
                    "--output-format",
                    "streaming-messages-json",
                    "--include-partial-messages",
                    "--max-turns",
                    "4",
                    "--permission-mode",
                    "dontAsk",
                    "--verbatim",
                    "--no-subagents",
                    "--no-plan",
                    "--no-memory",
                    "--tools",
                    CLI_TOOLS,
                    "--disallowed-tools",
                    CLI_DISALLOWED_TOOLS,
                    "--allow",
                    "WebSearch",
                    "--allow",
                    "WebFetch",
                    "--reasoning-effort",
                    "low",
                ] {
                    args.push(os(a));
                }
                if use_model {
                    args.push(os("-m"));
                    args.push(os(&model));
                }
            } else {
                for a in [
                    "--output-format",
                    "plain",
                    "--max-turns",
                    "1",
                    "--permission-mode",
                    "dontAsk",
                    "--disable-web-search",
                    "--verbatim",
                ] {
                    args.push(os(a));
                }
            }
        } else {
            args.push(os("-p"));
            args.push(os(&build_legacy_prompt(&system, &name, &history)));
            for a in ["--output-format", "plain", "--max-turns", "1", "--permission-mode", "dontAsk", "--disable-web-search", "--verbatim"] {
                args.push(os(a));
            }
        }
        let _ = CLI_DISALLOWED_TOOLS_OLD;

        let rid = request_id.to_string();
        let mut on_text = |t: &str| {
            let _ = on_event.send(ChatStreamEvent::Delta {
                request_id: rid.clone(),
                text: t.to_string(),
            });
        };
        let run = run_cli_once(&cli, &args, state, streaming, &mut on_text)?;
        if state.cancel.load(Ordering::SeqCst) {
            return Ok(run.stdout);
        }
        // Unknown / unusable model → retry once without `-m` and remember it for
        // the session. Some CLI builds print this on stdout, so check both, but
        // never mistake a real (long) reply that merely mentions models.
        let model_err = use_model
            && level == CLI_LEVEL_FULL
            && !run.streamed
            && (looks_like_model_error(&run.stderr)
                || (run.stdout.chars().count() < 400 && looks_like_model_error(&run.stdout)))
            && (!run.success || run.stdout.chars().count() < 400);
        if model_err && !model_retried {
            eprintln!(
                "[grok-cli] model '{model}' rejected ({}); retrying with the CLI default",
                truncate(&format!("{} {}", run.stderr, run.stdout), 160)
            );
            state.reject_cli_model(&model);
            use_model = false;
            model_retried = true;
            continue;
        }
        if !run.stdout.is_empty() {
            if !run.streamed {
                stream_text_as_deltas(on_event, request_id, &run.stdout, &state.cancel);
            }
            return Ok(run.stdout);
        }
        last_err = if run.success {
            "Grok CLI returned an empty reply.".to_string()
        } else {
            format!(
                "Grok CLI failed (exit {}). {}",
                run.code,
                truncate(&run.stderr, 240)
            )
        };
        if !run.success && looks_like_flag_error(&run.stderr) && level < CLI_LEVEL_LEGACY {
            level += 1;
            state.cli_level.store(level, Ordering::SeqCst);
            continue;
        }
        break;
    }
    Err(last_err)
}

/// Background, no-tools CLI call used for memory upkeep (summary + facts).
pub fn run_cli_plain(system: &str, prompt: &str) -> Result<String, String> {
    let cli = resolve_grok_cli().ok_or("Grok CLI not found")?;
    let path = crate::proc::temp_file("bg-prompt", "txt");
    std::fs::write(&path, prompt).map_err(|e| e.to_string())?;
    let _guard = crate::proc::TempFile(path.clone());
    let state = GrokState::new();
    let args: Vec<std::ffi::OsString> = vec![
        os("--prompt-file"),
        path.into_os_string(),
        os("--system-prompt-override"),
        os(system),
        os("--output-format"),
        os("plain"),
        os("--max-turns"),
        os("1"),
        os("--permission-mode"),
        os("dontAsk"),
        os("--disable-web-search"),
        os("--verbatim"),
        os("--no-subagents"),
        os("--no-plan"),
        os("--no-memory"),
        os("--disallowed-tools"),
        os(CLI_DISALLOWED_TOOLS),
        os("--reasoning-effort"),
        os("low"),
    ];
    let run = run_cli_once(&cli, &args, &state, false, &mut |_| {})?;
    if run.stdout.is_empty() {
        Err(format!("empty ({})", truncate(&run.stderr, 160)))
    } else {
        Ok(run.stdout)
    }
}

/// After a few turns: summarise the conversation and pull durable facts about
/// Frank into memory.json. Runs in the background; never blocks a reply.
#[tauri::command]
pub async fn memory_digest(app: AppHandle, messages: Vec<ChatMessage>) -> Result<usize, String> {
    let history = trim_history(&messages);
    if history.is_empty() {
        return Ok(0);
    }
    let prev = memory::load_summary(&app);
    let conv = conversation_text("Nova", &history);
    let system = "You maintain a companion app's memory about its user, Frank. Output ONLY JSON, no prose.";
    let prompt = format!(
        "Previous summary: {prev}\n\nRecent conversation:\n{conv}\n\n\
Return JSON: {{\"summary\": \"2-4 sentences: what Frank and Nova talked about and anything pending, for continuity next time\", \
\"facts\": [\"short durable third-person facts about Frank worth remembering long-term (people, preferences, plans, job, schedule). Only things Frank said. Empty list if none.\"]}}"
    );
    let out = tauri::async_runtime::spawn_blocking(move || run_cli_plain(system, &prompt))
        .await
        .map_err(|e| e.to_string())??;
    let json_start = out.find('{').ok_or("no json")?;
    let json_end = out.rfind('}').ok_or("no json")?;
    let v: Value = serde_json::from_str(&out[json_start..=json_end]).map_err(|e| e.to_string())?;
    if let Some(sum) = v.get("summary").and_then(|x| x.as_str()) {
        memory::save_summary(&app, sum)?;
    }
    let facts: Vec<String> = v
        .get("facts")
        .and_then(|f| f.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).take(8).collect())
        .unwrap_or_default();
    memory::remember_many(&app, &facts)
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
    // Current-info questions: fetch weather / search results up front so the
    // model answers in ONE turn instead of spending tool round-trips.
    let web = crate::tools::web_context(&last_user_text(&messages)).await;
    if provider == Provider::Cli {
        let grok_state = Arc::clone(&*state);
        let app2 = app.clone();
        let on2 = on_event.clone();
        let rid = request_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            run_grok_cli(&app2, &messages, web.as_deref(), &on2, &rid, &grok_state)
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
        chat_stream_api(app, state, messages, web, on_event, request_id).await
    }
}

async fn chat_stream_api(
    app: AppHandle,
    state: State<'_, Arc<GrokState>>,
    messages: Vec<ChatMessage>,
    web: Option<String>,
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
        "content": build_system_prompt(&app, &last_user_text(&messages), web.as_deref()),
    }));
    for m in &trim_history(&messages) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, n: usize) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: "x".repeat(n),
        }
    }

    #[test]
    fn history_is_capped_to_newest_messages() {
        let msgs: Vec<ChatMessage> = (0..60)
            .map(|i| msg(if i % 2 == 0 { "user" } else { "assistant" }, 10))
            .collect();
        let out = trim_history(&msgs);
        assert_eq!(out.len(), MAX_HISTORY_MESSAGES);
        assert_eq!(out.last().unwrap().role, "assistant");
    }

    #[test]
    fn history_respects_char_budget() {
        let msgs: Vec<ChatMessage> = (0..20).map(|_| msg("user", 5_000)).collect();
        let out = trim_history(&msgs);
        let total: usize = out.iter().map(|m| m.content.chars().count()).sum();
        assert!(total <= MAX_HISTORY_CHARS);
        assert!(!out.is_empty());
    }

    #[test]
    fn legacy_prompt_stays_under_cmdline_limit() {
        let msgs: Vec<ChatMessage> = (0..20).map(|_| msg("user", 2_000)).collect();
        let system = "s".repeat(MAX_SYSTEM_CHARS);
        let p = build_legacy_prompt(&system, "Nova", &trim_history(&msgs));
        assert!(p.chars().count() <= MAX_LEGACY_PROMPT_CHARS + 1);
        assert!(p.chars().count() + system.len() < 32_000);
    }

    #[test]
    fn model_errors_detected() {
        assert!(looks_like_model_error(
            "Couldn't set model 'grok-4.6': Invalid params: unknown model id"
        ));
        assert!(looks_like_model_error("Error: Invalid params: unknown model id"));
        assert!(looks_like_model_error("error: model 'grok-9' not found"));
        assert!(looks_like_model_error("Could not set model grok-4.6"));
        assert!(!looks_like_model_error("network timeout"));
        assert!(!looks_like_model_error("error: unexpected argument '--no-plan' found"));
        assert!(!looks_like_model_error("Hey you. Missed me?"));
    }

    #[test]
    fn model_error_is_not_a_flag_error() {
        // Must take the model-retry path, not downgrade the CLI flag level.
        assert!(!looks_like_flag_error(
            "Couldn't set model 'grok-4.6': Invalid params: unknown model id"
        ));
    }

    #[test]
    fn default_model_setting_means_no_flag() {
        assert_eq!(cli_model_from_setting(""), "");
        assert_eq!(cli_model_from_setting(" default "), "");
        assert_eq!(cli_model_from_setting("grok-4.7"), "grok-4.7");
    }

    #[test]
    fn rejected_model_is_remembered_per_model() {
        let st = GrokState::new();
        assert!(!st.cli_model_rejected("grok-4.6"));
        st.reject_cli_model("grok-4.6");
        assert!(st.cli_model_rejected("grok-4.6"));
        assert!(!st.cli_model_rejected("grok-4.7"));
    }

    #[test]
    fn flag_errors_detected() {
        assert!(looks_like_flag_error("error: unexpected argument '--prompt-file' found\n\nUsage: grok"));
        assert!(!looks_like_flag_error("network timeout"));
    }
}
