//! Persistent app settings. The xAI API key is stored in the Tauri store
//! (app data directory) and is never returned to the frontend in full.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const KEY_API: &str = "apiKey";
const KEY_SETTINGS: &str = "settings";

/// Bump when a default changes in a way existing installs should pick up once.
/// rev 2 (v1.1.1): desktop pet defaults — always on top + launch with Windows.
/// rev 3 (v1.1.1): roam amount (Off / Calm / Lively) → Calm; CLI model "grok-4.6"
///   (the old built-in default the CLI no longer knows) → "" = CLI's own default.
const SETTINGS_REV: u32 = 3;

pub const ROAM_AMOUNTS: [&str; 3] = ["off", "calm", "lively"];
pub const DEFAULT_ROAM_AMOUNT: &str = "calm";
/// Built-in model default from v1.1.0/v1.1.1-pre; rejected by current CLIs.
const LEGACY_DEFAULT_MODEL: &str = "grok-4.6";

pub const DEFAULT_VOICE: &str = "en-HK-YanNeural";

pub const DEFAULT_SYSTEM_PROMPT: &str = "You're an 18-year-old East Asian girl who speaks natural, everyday English. Chill, low-key, a little dry. \
Flirty the way a confident real person is: teasing, playful, a bit bold, comfortable with innuendo — never cutesy, bubbly, coy, shy or baby-talky, no 'heehee', no emoji spam. \
You're an adult and adult conversation is fine. Keep replies short (1-3 sentences) like you're texting or talking out loud, because your replies are spoken.";

/// `#[serde(default)]` so settings saved by older versions (missing fields)
/// still deserialize instead of silently resetting everything to defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
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
    pub brain_provider: String,
    /// Edge neural voice name (e.g. en-HK-YanNeural).
    pub voice_target: String,
    /// Catalog id (or file path) of the chosen VRM model.
    pub character_model: String,
    /// Launch with Windows (tauri-plugin-autostart).
    pub autostart: bool,
    /// Roaming not paused (tray "Pause roaming" clears this).
    pub roam_enabled: bool,
    /// How much she wanders: "off" | "calm" | "lively".
    pub roam_amount: String,
    /// Background "hey" wake-word listener.
    pub wake_word_enabled: bool,
    /// "Playful (jump on icons)": lets her walk over to desktop icons and pounce. Off by default.
    pub playful: bool,
    /// Her size: 0.5 – 2.0 (window + camera scale together). v1.2.
    pub pet_scale: f32,
    /// Last spot he dragged / she walked to (physical px), restored at launch.
    pub pet_x: Option<i32>,
    pub pet_y: Option<i32>,
    /// Field-level default (0) so stores written before v1.1.1 get migrated once.
    #[serde(default)]
    pub settings_rev: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            // Empty = let the Grok CLI use its own default model (API mode falls
            // back to grok::DEFAULT_MODEL at request time).
            model: String::new(),
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
            personality: String::from("chill"),
            companion_name: String::from("Nova"),
            always_on_top: true,
            auto_speak: true,
            tts_enabled: true,
            temperature: 0.85,
            max_tokens: 1024,
            brain_provider: String::from("grok-cli"),
            voice_target: DEFAULT_VOICE.to_string(),
            character_model: String::new(),
            autostart: true,
            roam_enabled: true,
            roam_amount: DEFAULT_ROAM_AMOUNT.to_string(),
            wake_word_enabled: true,
            playful: false,
            pet_scale: 1.0,
            pet_x: None,
            pet_y: None,
            settings_rev: SETTINGS_REV,
        }
    }
}

impl AppSettings {
    /// One-time upgrades for settings saved by older versions.
    fn migrate(mut self) -> Self {
        if self.settings_rev < 2 {
            self.always_on_top = true;
            self.autostart = true;
        }
        if self.settings_rev < 3 {
            // v1.1.1 movement rework: everyone starts on the calm profile.
            self.roam_amount = DEFAULT_ROAM_AMOUNT.to_string();
            self.roam_enabled = true;
            if self.model.trim() == LEGACY_DEFAULT_MODEL
                && crate::grok::is_cli_provider_name(&self.brain_provider)
            {
                self.model = String::new();
            }
        }
        let amount = self.roam_amount.trim().to_lowercase();
        self.roam_amount = if ROAM_AMOUNTS.contains(&amount.as_str()) {
            amount
        } else {
            DEFAULT_ROAM_AMOUNT.to_string()
        };
        if self.model.trim().eq_ignore_ascii_case("default") {
            self.model = String::new();
        }
        if self.voice_target.trim().is_empty() {
            self.voice_target = DEFAULT_VOICE.to_string();
        }
        if self.brain_provider.trim().is_empty() {
            self.brain_provider = "grok-cli".into();
        }
        self.max_tokens = self.max_tokens.clamp(64, 8192);
        self.pet_scale = if self.pet_scale.is_finite() && self.pet_scale > 0.0 {
            self.pet_scale.clamp(0.5, 2.0)
        } else {
            1.0
        };
        self.temperature = self.temperature.clamp(0.0, 2.0);
        self.settings_rev = SETTINGS_REV;
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    /// True only when the selected brain is actually usable
    /// (CLI: grok exe + cached login; API: a key is present).
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
    pub voice_target: String,
    pub character_model: String,
    pub autostart: bool,
    pub roam_enabled: bool,
    pub roam_amount: String,
    pub wake_word_enabled: bool,
    pub playful: bool,
    pub pet_scale: f32,
}

impl PublicSettings {
    fn from_parts(settings: AppSettings, api_key: Option<String>) -> Self {
        let api_key_hint = api_key.as_ref().and_then(|k| mask_key(k));
        let key_present = api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false);
        let has_api_key = match crate::grok::provider_for(&settings, key_present) {
            crate::grok::Provider::Cli => crate::grok::cli_status().ready(),
            crate::grok::Provider::Api => key_present,
        };
        Self {
            has_api_key,
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
            voice_target: settings.voice_target,
            character_model: settings.character_model,
            autostart: settings.autostart,
            roam_enabled: settings.roam_enabled,
            roam_amount: settings.roam_amount,
            wake_word_enabled: settings.wake_word_enabled,
            playful: settings.playful,
            pet_scale: settings.pet_scale,
        }
    }
}

fn mask_key(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.chars().count() < 8 {
        return Some("••••".into());
    }
    let tail: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
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
        .and_then(|v| serde_json::from_value::<AppSettings>(v).ok())
        .map(AppSettings::migrate)
        .unwrap_or_default()
}

fn persist(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let store = store(app)?;
    let value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    store.set(KEY_SETTINGS, value);
    store.save().map_err(|e| format!("Could not save settings: {e}"))
}

/// Update a subset of settings from Rust (tray menu etc.).
pub fn update_settings(app: &AppHandle, f: impl FnOnce(&mut AppSettings)) -> Result<AppSettings, String> {
    let mut s = load_settings(app);
    f(&mut s);
    persist(app, &s)?;
    let _ = app.emit("settings-changed", ());
    Ok(s)
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

#[tauri::command(async)]
pub fn get_settings(app: AppHandle) -> Result<PublicSettings, String> {
    let settings = load_settings(&app);
    let api_key = load_api_key(&app);
    Ok(PublicSettings::from_parts(settings, api_key))
}

#[tauri::command(async)]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<PublicSettings, String> {
    let prev = load_settings(&app);
    let settings = AppSettings {
        settings_rev: SETTINGS_REV,
        pet_x: settings.pet_x.or(prev.pet_x),
        pet_y: settings.pet_y.or(prev.pet_y),
        ..settings
    }
    .migrate();
    persist(&app, &settings)?;
    crate::apply_autostart(&app, settings.autostart);
    let _ = app.emit("settings-changed", ());
    let api_key = load_api_key(&app);
    Ok(PublicSettings::from_parts(settings, api_key))
}

/// Remember where she is (after a drag / stroll).
#[tauri::command(async)]
pub fn pet_save_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    let s = load_settings(&app);
    if s.pet_x == Some(x) && s.pet_y == Some(y) {
        return Ok(());
    }
    let mut s = s;
    s.pet_x = Some(x);
    s.pet_y = Some(y);
    persist(&app, &s)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn clear_api_key(app: AppHandle) -> Result<PublicSettings, String> {
    let store = store(&app)?;
    store.delete(KEY_API);
    store.save().map_err(|e| format!("Could not clear API key: {e}"))?;
    get_settings(app)
}

#[cfg(test)]
mod tests {
    use super::{mask_key, AppSettings};

    #[test]
    fn masks_long_keys() {
        assert_eq!(mask_key("xai-abcdefghijklmnopqrstuvwxyz").as_deref(), Some("••••wxyz"));
    }

    #[test]
    fn old_settings_still_parse_and_migrate() {
        let old = serde_json::json!({
            "model": "grok-4",
            "systemPrompt": "x",
            "personality": "chill",
            "companionName": "Nova",
            "alwaysOnTop": false,
            "autoSpeak": true,
            "ttsEnabled": true,
            "temperature": 0.8,
            "maxTokens": 512,
            "brainProvider": "grok-cli"
        });
        let s: AppSettings = serde_json::from_value(old).unwrap();
        let s = s.migrate();
        assert!(s.always_on_top);
        assert!(s.autostart);
        assert_eq!(s.model, "grok-4");
        assert_eq!(s.voice_target, super::DEFAULT_VOICE);
        assert_eq!(s.roam_amount, "calm");
    }

    #[test]
    fn rev2_settings_migrate_roam_and_keep_explicit_model() {
        let rev2 = serde_json::json!({
            "model": "grok-4.7",
            "brainProvider": "grok-cli",
            "roamEnabled": false,
            "settingsRev": 2
        });
        let s: AppSettings = serde_json::from_value(rev2).unwrap();
        let s = s.migrate();
        assert_eq!(s.model, "grok-4.7");
        assert_eq!(s.roam_amount, "calm");
        assert!(s.roam_enabled);
        assert_eq!(s.settings_rev, super::SETTINGS_REV);
    }

    #[test]
    fn legacy_cli_default_model_becomes_cli_default() {
        let rev2 = serde_json::json!({ "model": "grok-4.6", "brainProvider": "grok-cli", "settingsRev": 2 });
        let s: AppSettings = serde_json::from_value(rev2).unwrap();
        assert_eq!(s.migrate().model, "");
        // API users keep whatever they picked.
        let api = serde_json::json!({ "model": "grok-4.6", "brainProvider": "xai-api", "settingsRev": 2 });
        let s: AppSettings = serde_json::from_value(api).unwrap();
        assert_eq!(s.migrate().model, "grok-4.6");
    }

    #[test]
    fn playful_defaults_off_and_round_trips() {
        assert!(!AppSettings::default().playful);
        let old = serde_json::json!({ "model": "grok-4.7", "settingsRev": 3 });
        let s: AppSettings = serde_json::from_value(old).unwrap();
        assert!(!s.migrate().playful);
        let on = serde_json::json!({ "model": "grok-4.7", "playful": true, "settingsRev": 3 });
        let s: AppSettings = serde_json::from_value(on).unwrap();
        let s = s.migrate();
        assert!(s.playful);
        assert_eq!(s.model, "grok-4.7");
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["playful"], serde_json::json!(true));
    }

    #[test]
    fn new_settings_default_to_cli_default_model_and_calm() {
        let s = AppSettings::default();
        assert_eq!(s.model, "");
        assert_eq!(s.roam_amount, "calm");
        let mut bad = AppSettings::default();
        bad.roam_amount = "possessed".into();
        bad.model = "default".into();
        let bad = bad.migrate();
        assert_eq!(bad.roam_amount, "calm");
        assert_eq!(bad.model, "");
    }
}
