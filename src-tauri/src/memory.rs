//! Simple local memory. Facts are stored as JSON in the Tauri store
//! (app data). The frontend only mutates this when the user asks to
//! remember, list, or forget something.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

const STORE_FILE: &str = "memory.json";
const KEY_FACTS: &str = "facts";
/// Hard cap on stored facts (oldest dropped first).
const MAX_FACTS: usize = 200;
/// Facts injected into the system prompt (newest first wins).
const PROMPT_FACTS: usize = 40;
const PROMPT_FACTS_CHARS: usize = 2_500;
const MAX_FACT_CHARS: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFact {
    pub id: String,
    pub fact: String,
    pub created_at: u64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn store(
    app: &AppHandle,
) -> Result<std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>, String> {
    app.store(STORE_FILE)
        .map_err(|e| format!("Could not open memory store: {e}"))
}

fn load_facts(app: &AppHandle) -> Result<Vec<MemoryFact>, String> {
    let store = store(app)?;
    match store.get(KEY_FACTS) {
        Some(v) => serde_json::from_value(v).map_err(|e| format!("Corrupt memory store: {e}")),
        None => Ok(Vec::new()),
    }
}

fn save_facts(app: &AppHandle, facts: &[MemoryFact]) -> Result<(), String> {
    let store = store(app)?;
    let value = serde_json::to_value(facts).map_err(|e| e.to_string())?;
    store.set(KEY_FACTS, value);
    store.save().map_err(|e| format!("Could not save memory: {e}"))
}

fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

#[tauri::command(async)]
pub fn memory_list(app: AppHandle) -> Result<Vec<MemoryFact>, String> {
    load_facts(&app)
}

/// Remember a fact. `replace_prefix` (case-insensitive) first removes older facts
/// starting with that prefix — e.g. "User's name is" so a new name replaces the old.
#[tauri::command(async)]
pub fn memory_remember(
    app: AppHandle,
    fact: String,
    replace_prefix: Option<String>,
) -> Result<MemoryFact, String> {
    let fact: String = fact.trim().chars().take(MAX_FACT_CHARS).collect();
    if fact.is_empty() {
        return Err("Nothing to remember".into());
    }
    let mut facts = load_facts(&app)?;
    // De-dupe exact matches (case/whitespace-insensitive).
    let key = norm(&fact);
    if let Some(existing) = facts.iter().find(|f| norm(&f.fact) == key) {
        return Ok(existing.clone());
    }
    if let Some(prefix) = replace_prefix.map(|p| norm(&p)).filter(|p| !p.is_empty()) {
        facts.retain(|f| !norm(&f.fact).starts_with(&prefix));
    }
    let entry = MemoryFact {
        id: Uuid::new_v4().to_string(),
        fact,
        created_at: now_secs(),
    };
    facts.push(entry.clone());
    if facts.len() > MAX_FACTS {
        let excess = facts.len() - MAX_FACTS;
        facts.drain(..excess);
    }
    save_facts(&app, &facts)?;
    Ok(entry)
}

/// Delete exactly one fact: by id, or by an exact (case/whitespace-insensitive)
/// fact text match. Never a substring wipe.
#[tauri::command(async)]
pub fn memory_delete(app: AppHandle, id: String) -> Result<Vec<MemoryFact>, String> {
    let mut facts = load_facts(&app)?;
    let pos = facts
        .iter()
        .position(|f| f.id == id)
        .or_else(|| {
            let key = norm(&id);
            facts.iter().position(|f| norm(&f.fact) == key)
        });
    if let Some(i) = pos {
        facts.remove(i);
        save_facts(&app, &facts)?;
    }
    Ok(facts)
}

#[tauri::command(async)]
pub fn memory_clear(app: AppHandle) -> Result<(), String> {
    save_facts(&app, &[])
}

/// Format facts as a block the Grok client can inject into the system prompt.
pub fn format_for_prompt(app: &AppHandle) -> String {
    let Ok(facts) = load_facts(app) else {
        return String::new();
    };
    if facts.is_empty() {
        return String::new();
    }
    // Newest facts are most relevant; keep a bounded block.
    let mut picked: Vec<&MemoryFact> = Vec::new();
    let mut total = 0usize;
    for f in facts.iter().rev().take(PROMPT_FACTS) {
        let len = f.fact.chars().count();
        if total + len > PROMPT_FACTS_CHARS {
            break;
        }
        total += len;
        picked.push(f);
    }
    picked.reverse();
    let mut out = String::from(
        "\n\nThings you remember about this user (only mention when relevant; do not dump the list unless asked):\n",
    );
    for (i, f) in picked.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", i + 1, f.fact));
    }
    out
}
