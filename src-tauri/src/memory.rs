//! Simple local memory. Facts are stored as JSON in the Tauri store
//! (app data). The frontend only mutates this when the user asks to
//! remember, list, or forget something.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

const STORE_FILE: &str = "memory.json";
const KEY_FACTS: &str = "facts";

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

#[tauri::command]
pub fn memory_list(app: AppHandle) -> Result<Vec<MemoryFact>, String> {
    load_facts(&app)
}

#[tauri::command]
pub fn memory_remember(app: AppHandle, fact: String) -> Result<MemoryFact, String> {
    let fact = fact.trim().to_string();
    if fact.is_empty() {
        return Err("Nothing to remember".into());
    }
    let mut facts = load_facts(&app)?;
    // De-dupe exact matches (case-insensitive).
    if let Some(existing) = facts.iter().find(|f| f.fact.eq_ignore_ascii_case(&fact)) {
        return Ok(existing.clone());
    }
    let entry = MemoryFact {
        id: Uuid::new_v4().to_string(),
        fact,
        created_at: now_secs(),
    };
    facts.push(entry.clone());
    save_facts(&app, &facts)?;
    Ok(entry)
}

#[tauri::command]
pub fn memory_delete(app: AppHandle, id: String) -> Result<Vec<MemoryFact>, String> {
    let mut facts = load_facts(&app)?;
    let before = facts.len();
    facts.retain(|f| f.id != id);
    if facts.len() == before {
        // Also allow deleting by substring of the fact text.
        let needle = id.to_lowercase();
        facts.retain(|f| !f.fact.to_lowercase().contains(&needle));
    }
    save_facts(&app, &facts)?;
    Ok(facts)
}

#[tauri::command]
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
    let mut out = String::from(
        "\n\nThings you remember about this user (only mention when relevant; do not dump the list unless asked):\n",
    );
    for (i, f) in facts.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", i + 1, f.fact));
    }
    out
}
