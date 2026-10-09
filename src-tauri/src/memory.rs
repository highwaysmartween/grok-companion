//! Simple local memory. Facts are stored as JSON in the Tauri store
//! (app data). The frontend only mutates this when the user asks to
//! remember, list, or forget something.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

const STORE_FILE: &str = "memory.json";
const KEY_FACTS: &str = "facts";
const KEY_SUMMARY: &str = "summary";
/// Facts picked by relevance to the current message (plus a few newest).
const RELEVANT_FACTS: usize = 12;
const NEWEST_FACTS: usize = 6;
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

fn words(s: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "the", "a", "an", "and", "or", "to", "of", "in", "on", "is", "are", "was", "it", "i", "you", "me", "my",
        "your", "user", "user's", "users", "frank", "frank's", "what", "do", "does", "that", "this", "with", "for",
        "at", "be", "have", "has", "can", "about", "hey", "nova", "just", "like", "so",
    ];
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| w.len() > 2 && !STOP.contains(w) && !STOP.contains(&w.trim_end_matches("'s")))
        .map(|w| {
            w.trim_end_matches("'s")
                .trim_end_matches('\'')
                .trim_end_matches('s')
                .to_string()
        })
        .collect()
}

/// Pick the facts most relevant to `query` (word overlap), plus the newest few.
pub fn select_relevant(facts: &[MemoryFact], query: &str) -> Vec<MemoryFact> {
    let q = words(query);
    let mut scored: Vec<(usize, usize)> = facts
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let fw = words(&f.fact);
            (q.iter().filter(|w| fw.contains(w)).count(), i)
        })
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut idx: Vec<usize> = scored.iter().take(RELEVANT_FACTS).map(|(_, i)| *i).collect();
    for i in (0..facts.len()).rev().take(NEWEST_FACTS) {
        if !idx.contains(&i) {
            idx.push(i);
        }
    }
    idx.sort();
    idx.into_iter().map(|i| facts[i].clone()).collect()
}

pub fn load_summary(app: &AppHandle) -> String {
    store(app)
        .ok()
        .and_then(|s| s.get(KEY_SUMMARY))
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

pub fn save_summary(app: &AppHandle, summary: &str) -> Result<(), String> {
    let s = store(app)?;
    s.set(KEY_SUMMARY, serde_json::Value::String(summary.chars().take(1_500).collect()));
    s.save().map_err(|e| e.to_string())
}

/// Add many facts (dedupe, case/whitespace-insensitive; also skips near-dupes
/// where one fact contains the other).
pub fn remember_many(app: &AppHandle, new_facts: &[String]) -> Result<usize, String> {
    let mut facts = load_facts(app)?;
    let mut added = 0;
    for f in new_facts {
        let fact: String = f.trim().trim_end_matches('.').chars().take(MAX_FACT_CHARS).collect();
        if fact.len() < 4 {
            continue;
        }
        let key = norm(&fact);
        if facts.iter().any(|x| {
            let k = norm(&x.fact);
            k == key || k.contains(&key) || key.contains(&k)
        }) {
            continue;
        }
        facts.push(MemoryFact { id: Uuid::new_v4().to_string(), fact, created_at: now_secs() });
        added += 1;
    }
    if facts.len() > MAX_FACTS {
        let excess = facts.len() - MAX_FACTS;
        facts.drain(..excess);
    }
    if added > 0 {
        save_facts(app, &facts)?;
    }
    Ok(added)
}

#[tauri::command(async)]
pub fn memory_add_many(app: AppHandle, facts: Vec<String>) -> Result<usize, String> {
    remember_many(&app, &facts)
}

/// Relevant memories + last conversation summary for one prompt.
pub fn format_relevant(app: &AppHandle, query: &str) -> String {
    let mut out = String::new();
    let summary = load_summary(app);
    if !summary.trim().is_empty() {
        out.push_str("\n\nWhere you two left off last time (summary): ");
        out.push_str(summary.trim());
        out.push('\n');
    }
    let Ok(facts) = load_facts(app) else { return out };
    let picked = select_relevant(&facts, query);
    if picked.is_empty() {
        return out;
    }
    out.push_str("\nThings you remember about Frank (use naturally when relevant; don't list them unless asked):\n");
    let mut total = 0;
    for f in picked {
        total += f.fact.len();
        if total > PROMPT_FACTS_CHARS {
            break;
        }
        out.push_str(&format!("- {}\n", f.fact));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(s: &str) -> MemoryFact {
        MemoryFact { id: s.into(), fact: s.into(), created_at: 0 }
    }

    #[test]
    fn relevance_picks_matching_fact() {
        let facts: Vec<MemoryFact> = (0..30)
            .map(|i| f(&format!("filler fact number {i}")))
            .chain(std::iter::once(f("Frank's sister is called Mia")))
            .chain((0..10).map(|i| f(&format!("newer filler {i}"))))
            .collect();
        let got = select_relevant(&facts, "what's my sister's name?");
        assert!(got.iter().any(|x| x.fact.contains("Mia")));
        assert!(got.len() <= RELEVANT_FACTS + NEWEST_FACTS);
    }
}

/// Format facts as a block the Grok client can inject into the system prompt.
#[allow(dead_code)]
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
