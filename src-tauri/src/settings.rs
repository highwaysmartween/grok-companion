//! Persistent app settings. The xAI API key is stored in the Tauri store
//! (app data directory) and is never returned to the frontend in full.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const KEY_API: &str = "apiKey";
const KEY_SETTINGS: &str = "settings";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub model: String,
    pub system_prompt: String,
    pub personality: String,
    pub companion_name: String,
    pub always_on_top: bool,
    pub auto_speak: bool,
    pub tts_enabled: bool,
    pub temperature: f32,
    pub max_tokens: u32,
    /// "auto" | "xai-api" | "grok-cli"
    #[serde(default = "default_brain")]
    pub brain_provider: String,
}

fn default_brain() -> String {
    "grok-cli".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            model: crate::grok::DEFAULT_MODEL.to_string(),
            system_prompt: String::from(
                "You are an 18-year-old East Asian girl who speaks natural everyday English. Cool, low-key, a little dry — not cutesy, not bubbly, no 'heehee' or baby talk. Keep replies short (1-3 sentences). Sound like a real person texting. Adult conversations are fine.",
            ),
            personality: String::from("chill"),
            companion_name: String::from("Nova"),
            always_on_top: false,
            auto_speak: true,
            tts_enabled: true,
            temperature: 0.85,
            max_tokens: 1024,
            brain_provider: default_brain(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    pub has_api_key: bool,
    pub api_key_hint: Option<String>,
    pub model: String,
    pub system_prompt: String,
    pub personality: String,
    pub companion_name: String,
    pub always_on_top: bool,
    pub auto_speak: bool,
    pub tts_enabled: bool,
    pub temperature: f32,
    pub max_tokens: u32,
    pub brain_provider: String,
}

impl PublicSettings {
    fn from_parts(settings: AppSettings, api_key: Option<String>) -> Self {
        let api_key_hint = api_key.as_ref().and_then(|k| mask_key(k));
        let cli = settings.brain_provider == "grok-cli" || settings.brain_provider == "auto";
        Self {
            has_api_key: api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false)
                || std::env::var("XAI_API_KEY")
                    .map(|v| !v.is_empty())
                    .unwrap_or(false)
                || cli,
            api_key_hint,
            model: settings.model,
            system_prompt: settings.system_prompt,
            personality: settings.personality,
            companion_name: settings.companion_name,
            always_on_top: settings.always_on_top,
            auto_speak: settings.auto_speak,
            tts_enabled: settings.tts_enabled,
            temperature: settings.temperature,
            max_tokens: settings.max_tokens,
            brain_provider: settings.brain_provider,
        }
    }
}

fn mask_key(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.len() < 8 {
        return Some("••••".into());
    }
    let tail = &trimmed[trimmed.len() - 4..];
    Some(format!("••••{tail}"))
}

fn store(
    app: &AppHandle,
) -> Result<std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>, String> {
    app.store(STORE_FILE)
        .map_err(|e| format!("Could not open settings store: {e}"))
}

pub fn load_settings(app: &AppHandle) -> AppSettings {
    let Ok(store) = store(app) else {
        return AppSettings::default();
    };
    store
        .get(KEY_SETTINGS)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn load_api_key(app: &AppHandle) -> Option<String> {
    if let Ok(store) = store(app) {
        if let Some(val) = store.get(KEY_API) {
            if let Some(s) = val.as_str() {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    std::env::var("XAI_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<PublicSettings, String> {
    let settings = load_settings(&app);
    let api_key = load_api_key(&app);
    Ok(PublicSettings::from_parts(settings, api_key))
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<PublicSettings, String> {
    let store = store(&app)?;
    let value = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
    store.set(KEY_SETTINGS, value);
    store.save().map_err(|e| format!("Could not save settings: {e}"))?;
    let _ = app.emit("settings-changed", ());
    let api_key = load_api_key(&app);
    Ok(PublicSettings::from_parts(settings, api_key))
}

#[tauri::command]
pub fn save_api_key(app: AppHandle, api_key: String) -> Result<PublicSettings, String> {
    let trimmed = api_key.trim().to_string();
    if trimmed.is_empty() {
        return Err("API key cannot be empty".into());
    }
    let store = store(&app)?;
    store.set(KEY_API, serde_json::Value::String(trimmed));
    store.save().map_err(|e| format!("Could not save API key: {e}"))?;
    get_settings(app)
}

#[tauri::command]
pub fn clear_api_key(app: AppHandle) -> Result<PublicSettings, String> {
    let store = store(&app)?;
    store.delete(KEY_API);
    store.save().map_err(|e| format!("Could not clear API key: {e}"))?;
    get_settings(app)
}

#[cfg(test)]
mod tests {
    use super::mask_key;

    #[test]
    fn masks_long_keys() {
        assert_eq!(mask_key("xai-abcdefghijklmnopqrstuvwxyz").as_deref(), Some("••••wxyz"));
    }
}
