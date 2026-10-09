//! Everyday tools (v1.2): alarms / timers / reminders, opening allow-listed
//! sites + apps, and quick web look-ups for current info. All local and safe:
//! nothing here runs an arbitrary shell command.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

const ALARM_STORE: &str = "alarms.json";
const KEY_ALARMS: &str = "alarms";
/// An alarm missed while the app was closed still fires if it is at most this late.
const MISSED_GRACE_MS: i64 = 6 * 3600 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub id: String,
    /// "alarm" | "timer" | "reminder"
    pub kind: String,
    /// Unix epoch milliseconds.
    pub due_ms: i64,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub created_ms: i64,
}

#[derive(Default)]
pub struct ToolsState {
    lock: Mutex<()>,
    started: AtomicBool,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn load_alarms(app: &AppHandle) -> Vec<Alarm> {
    app.store(ALARM_STORE)
        .ok()
        .and_then(|s| s.get(KEY_ALARMS))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn save_alarms(app: &AppHandle, list: &[Alarm]) -> Result<(), String> {
    let store = app.store(ALARM_STORE).map_err(|e| e.to_string())?;
    store.set(KEY_ALARMS, serde_json::to_value(list).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn alarm_add(
    app: AppHandle,
    state: tauri::State<Arc<ToolsState>>,
    kind: String,
    due_ms: i64,
    label: Option<String>,
) -> Result<Alarm, String> {
    let kind = match kind.as_str() {
        "timer" | "reminder" => kind,
        _ => "alarm".to_string(),
    };
    if due_ms <= now_ms() - 1000 {
        return Err("That time has already passed.".into());
    }
    let _g = state.lock.lock().map_err(|_| "lock")?;
    let mut list = load_alarms(&app);
    let a = Alarm {
        id: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
        kind,
        due_ms,
        label: label.unwrap_or_default().trim().chars().take(120).collect(),
        created_ms: now_ms(),
    };
    list.push(a.clone());
    list.sort_by_key(|a| a.due_ms);
    save_alarms(&app, &list)?;
    Ok(a)
}

#[tauri::command(async)]
pub fn alarm_list(app: AppHandle) -> Vec<Alarm> {
    let mut l = load_alarms(&app);
    l.sort_by_key(|a| a.due_ms);
    l
}

/// Cancel by id, or every alarm of a kind ("alarm" / "timer" / "reminder"), or "all".
#[tauri::command(async)]
pub fn alarm_cancel(
    app: AppHandle,
    state: tauri::State<Arc<ToolsState>>,
    target: String,
) -> Result<Vec<Alarm>, String> {
    let _g = state.lock.lock().map_err(|_| "lock")?;
    let list = load_alarms(&app);
    let t = target.trim().to_lowercase();
    let (gone, keep): (Vec<Alarm>, Vec<Alarm>) = list
        .into_iter()
        .partition(|a| t == "all" || a.id == t || a.kind == t);
    save_alarms(&app, &keep)?;
    Ok(gone)
}

fn fire(app: &AppHandle, a: &Alarm) {
    // Wake her up visibly (no focus steal), then let the frontend chime + speak.
    if let Some(w) = app.get_webview_window("main") {
        if !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
            let _ = w.show();
        }
    }
    let title = match a.kind.as_str() {
        "timer" => "Timer done",
        "reminder" => "Reminder",
        _ => "Alarm",
    };
    let body = if a.label.is_empty() { "Time's up.".to_string() } else { a.label.clone() };
    let _ = app.notification().builder().title(title).body(&body).show();
    let _ = app.emit("alarm-due", a.clone());
}

/// Background scheduler: checks once a second, survives restarts via alarms.json.
pub fn start_scheduler(app: AppHandle, state: Arc<ToolsState>) {
    if state.started.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        // Give the webview a moment to register its listener after launch.
        std::thread::sleep(std::time::Duration::from_secs(4));
        loop {
            let now = now_ms();
            let due: Vec<Alarm> = {
                let Ok(_g) = state.lock.lock() else { break };
                let list = load_alarms(&app);
                if list.iter().any(|a| a.due_ms <= now) {
                    let (due, keep): (Vec<Alarm>, Vec<Alarm>) =
                        list.into_iter().partition(|a| a.due_ms <= now);
                    let _ = save_alarms(&app, &keep);
                    due.into_iter().filter(|a| now - a.due_ms <= MISSED_GRACE_MS).collect()
                } else {
                    Vec::new()
                }
            };
            for a in &due {
                fire(&app, a);
            }
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }
    });
}

// --- open sites / apps -------------------------------------------------------

/// Well-known sites (spoken name → URL).
const SITES: &[(&str, &str)] = &[
    ("youtube", "https://www.youtube.com"),
    ("google", "https://www.google.com"),
    ("gmail", "https://mail.google.com"),
    ("netflix", "https://www.netflix.com"),
    ("facebook", "https://www.facebook.com"),
    ("instagram", "https://www.instagram.com"),
    ("twitter", "https://x.com"),
    ("x", "https://x.com"),
    ("reddit", "https://www.reddit.com"),
    ("twitch", "https://www.twitch.tv"),
    ("github", "https://github.com"),
    ("google maps", "https://maps.google.com"),
    ("maps", "https://maps.google.com"),
    ("grok", "https://grok.com"),
    ("amazon", "https://www.amazon.com"),
    ("trade me", "https://www.trademe.co.nz"),
    ("trademe", "https://www.trademe.co.nz"),
    ("weather", "https://www.metservice.com"),
    ("metservice", "https://www.metservice.com"),
    ("news", "https://www.rnz.co.nz/news"),
    ("stuff", "https://www.stuff.co.nz"),
    ("plex", "https://app.plex.tv"),
    ("tiktok", "https://www.tiktok.com"),
    ("spotify web", "https://open.spotify.com"),
    ("discord web", "https://discord.com/app"),
    ("whatsapp", "https://web.whatsapp.com"),
    ("outlook", "https://outlook.live.com"),
    ("chatgpt", "https://chatgpt.com"),
];

/// Installed apps by name → launch target (URI scheme or a fixed system exe).
const APPS: &[(&str, &str)] = &[
    ("spotify", "uri:spotify:"),
    ("discord", "uri:discord://"),
    ("steam", "uri:steam://open/main"),
    ("epic games", "uri:com.epicgames.launcher://"),
    ("epic", "uri:com.epicgames.launcher://"),
    ("settings", "uri:ms-settings:"),
    ("calculator", "exe:calc.exe"),
    ("calc", "exe:calc.exe"),
    ("notepad", "exe:notepad.exe"),
    ("paint", "exe:mspaint.exe"),
    ("file explorer", "exe:explorer.exe"),
    ("explorer", "exe:explorer.exe"),
    ("files", "exe:explorer.exe"),
    ("task manager", "exe:taskmgr.exe"),
    ("edge", "uri:microsoft-edge:https://www.google.com"),
    ("chrome", "chrome"),
    ("google chrome", "chrome"),
    ("store", "uri:ms-windows-store:"),
    ("microsoft store", "uri:ms-windows-store:"),
    ("mail", "uri:mailto:"),
    ("camera", "uri:microsoft.windows.camera:"),
    ("clock", "uri:ms-clock:"),
    ("photos", "uri:ms-photos:"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    /// "opened" | "confirm" | "unknown"
    pub status: String,
    /// What was opened / would be opened.
    pub target: String,
    pub label: String,
}

fn norm_name(s: &str) -> String {
    s.to_lowercase()
        .replace(['.', ',', '!', '?', '\''], " ")
        .split_whitespace()
        .filter(|w| !matches!(*w, "the" | "app" | "website" | "site" | "my" | "up" | "please" | "for" | "me"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn launch(target: &str) -> Result<(), String> {
    if let Some(uri) = target.strip_prefix("uri:") {
        return tauri_plugin_opener::open_url(uri, None::<&str>).map_err(|e| e.to_string());
    }
    if let Some(exe) = target.strip_prefix("exe:") {
        return crate::proc::command(exe)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    if target == "chrome" {
        // Fixed args only: `start "" chrome` resolves Chrome via App Paths.
        return crate::proc::command("cmd")
            .args(["/C", "start", "", "chrome"])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    if target.starts_with("https://") || target.starts_with("http://") {
        return tauri_plugin_opener::open_url(target, None::<&str>).map_err(|e| e.to_string());
    }
    Err("not allowed".into())
}

fn domain_like(s: &str) -> Option<String> {
    let t = s.trim().trim_end_matches(['.', '!', '?']).to_lowercase().replace(" dot ", ".");
    let t = t.trim_start_matches("https://").trim_start_matches("http://");
    let ok = t.contains('.')
        && !t.contains(' ')
        && t.len() <= 80
        && t.chars().all(|c| c.is_ascii_alphanumeric() || "-./_?=&%#".contains(c));
    ok.then(|| format!("https://{t}"))
}

/// Open a named site / app from the allow-list. Anything else that looks like a
/// web address comes back as "confirm" so she asks first; never a shell command.
#[tauri::command(async)]
pub fn open_target(name: String, confirmed: Option<bool>) -> Result<OpenResult, String> {
    let raw = name.trim().to_string();
    let n = norm_name(&raw);
    if let Some((label, t)) = APPS.iter().find(|(k, _)| *k == n) {
        launch(t)?;
        return Ok(OpenResult { status: "opened".into(), target: t.to_string(), label: label.to_string() });
    }
    if let Some((label, url)) = SITES.iter().find(|(k, _)| *k == n) {
        launch(url)?;
        return Ok(OpenResult { status: "opened".into(), target: url.to_string(), label: label.to_string() });
    }
    if let Some(url) = domain_like(&raw) {
        if confirmed == Some(true) {
            launch(&url)?;
            return Ok(OpenResult { status: "opened".into(), target: url.clone(), label: url });
        }
        return Ok(OpenResult { status: "confirm".into(), target: url.clone(), label: url });
    }
    Ok(OpenResult { status: "unknown".into(), target: String::new(), label: raw })
}

// --- web look-ups --------------------------------------------------------------

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) GrokCompanion/1.2")
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse DuckDuckGo's HTML results page into "title — snippet" lines.
pub fn parse_ddg(html: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    for chunk in html.split("class=\"result__a\"").skip(1) {
        let title = chunk
            .split_once('>')
            .and_then(|(_, rest)| rest.split_once("</a>"))
            .map(|(t, _)| strip_tags(t))
            .unwrap_or_default();
        let snippet = chunk
            .split_once("class=\"result__snippet\"")
            .and_then(|(_, rest)| rest.split_once('>'))
            .and_then(|(_, rest)| rest.split_once("</a>"))
            .map(|(t, _)| strip_tags(t))
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        out.push(if snippet.is_empty() { title } else { format!("{title} — {snippet}") });
        if out.len() >= max {
            break;
        }
    }
    out
}

pub async fn web_search_text(query: &str) -> Result<String, String> {
    let client = http()?;
    let resp = client
        .post("https://html.duckduckgo.com/html/")
        .form(&[("q", query), ("kl", "nz-en")])
        .send()
        .await
        .map_err(|e| format!("search failed: {e}"))?;
    let html = resp.text().await.map_err(|e| e.to_string())?;
    let lines = parse_ddg(&html, 6);
    if lines.is_empty() {
        return Err("no results".into());
    }
    Ok(lines
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{}. {}", i + 1, l.chars().take(300).collect::<String>()))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Free weather (no key): wttr.in one-liner + today's range.
pub async fn weather_text(place: &str) -> Result<String, String> {
    let client = http()?;
    let p: String = place
        .trim()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-')
        .collect::<String>()
        .replace(' ', "+");
    let url = format!("https://wttr.in/{p}?format=%l:+%C,+%t+(feels+%f),+wind+%w,+rain+%p&m");
    let now = client.get(&url).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    let mut out = format!("Now: {}", now.trim());
    if let Ok(r) = client.get(format!("https://wttr.in/{p}?format=j1")).send().await {
        if let Ok(v) = r.json::<serde_json::Value>().await {
            if let Some(d) = v.pointer("/weather/0") {
                let g = |k: &str| d.get(k).and_then(|x| x.as_str()).unwrap_or("?").to_string();
                let desc = d
                    .pointer("/hourly/4/weatherDesc/0/value")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                out.push_str(&format!(
                    "\nToday: high {}°C, low {}°C, midday {}",
                    g("maxtempC"),
                    g("mintempC"),
                    desc.trim()
                ));
            }
        }
    }
    Ok(out)
}

/// Does this message need fresh info? Returns a ready-made context block.
pub async fn web_context(user_text: &str) -> Option<String> {
    let t = user_text.to_lowercase();
    if let Some(i) = t.find("weather") {
        let after = &t[i..];
        let place = after
            .split_once(" in ")
            .or_else(|| after.split_once(" for "))
            .or_else(|| after.split_once(" at "))
            .map(|(_, p)| {
                p.split(|c: char| c == '?' || c == ',' || c == '.')
                    .next()
                    .unwrap_or("")
                    .replace(" today", "")
                    .replace(" tomorrow", "")
                    .replace(" right now", "")
                    .replace(" now", "")
                    .trim()
                    .to_string()
            })
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "Christchurch".to_string());
        return tokio_timeout(weather_text(&place)).await.map(|w| format!("Live weather for {place} (wttr.in):\n{w}"));
    }
    let needs = [
        "news", "latest", "score", "who won", "price of", "stock price", "release date", "search", "look up",
        "google", "what's on", "when is", "when does", "how much is", "exchange rate", "what happened",
        "update on", "results",
    ];
    if !needs.iter().any(|k| t.contains(k)) || t.split_whitespace().count() < 3 {
        return None;
    }
    let q = t
        .trim_start_matches("hey ")
        .replace("can you ", "")
        .replace("search for ", "")
        .replace("look up ", "")
        .replace("google ", "");
    tokio_timeout(web_search_text(q.trim())).await.map(|r| format!("Web search results for \"{}\" (DuckDuckGo):\n{r}", q.trim()))
}

async fn tokio_timeout(f: impl std::future::Future<Output = Result<String, String>>) -> Option<String> {
    match tokio::time::timeout(std::time::Duration::from_millis(4500), f).await {
        Ok(Ok(s)) => Some(s),
        Ok(Err(e)) => {
            eprintln!("[tools] web lookup failed: {e}");
            None
        }
        Err(_) => None,
    }
}

#[tauri::command]
pub async fn web_search(query: String) -> Result<String, String> {
    web_search_text(&query).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ddg_parse() {
        let html = r#"<a rel="nofollow" class="result__a" href="x">Christchurch <b>weather</b></a>
        <a class="result__snippet" href="x">Cloudy, 12&#x27;C today</a>
        <a rel="nofollow" class="result__a" href="y">Second</a>"#;
        let r = parse_ddg(html, 5);
        assert_eq!(r[0], "Christchurch weather — Cloudy, 12'C today");
        assert_eq!(r[1], "Second");
    }

    #[test]
    fn domains() {
        assert_eq!(domain_like("example.com").as_deref(), Some("https://example.com"));
        assert_eq!(domain_like("rm -rf"), None);
        assert_eq!(domain_like("calc & del"), None);
    }

    #[test]
    fn open_unknown_app_is_refused() {
        let r = open_target("some random thing".into(), None).unwrap();
        assert_eq!(r.status, "unknown");
    }
}

/// Append one turn's latency marks to %APPDATA%\com.grok.desktopcompanion\latency.log.
#[tauri::command(async)]
pub fn log_latency(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("latency.log");
    // Keep it small.
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", line.chars().take(1000).collect::<String>()).map_err(|e| e.to_string())
}
