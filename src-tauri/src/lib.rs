mod grok;
mod memory;
mod proc;
mod settings;
mod stt;
mod tts;

// The old inject.rs (typing into other windows) was removed in v1.1.1 — the
// companion deliberately has no PC-control surface.

use grok::{cancel_chat, chat_stream, check_connection, list_models, GrokState};
use memory::{memory_clear, memory_delete, memory_list, memory_remember};
use serde::Serialize;
use settings::{clear_api_key, get_settings, save_api_key, save_settings};
use std::sync::Arc;
use stt::{stt_cancel_listen, stt_cancel_wake, stt_listen_windows, stt_wait_wake_word, SttState};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tts::{tts_default_voice, tts_speak_natural, tts_stop, TtsState};

/// Enable/disable launch-at-login to match the setting. Skipped in debug builds
/// so `tauri dev` never registers the dev binary in the Run key.
pub fn apply_autostart(app: &AppHandle, enabled: bool) {
    if cfg!(debug_assertions) {
        return;
    }
    let al = app.autolaunch();
    let current = al.is_enabled().unwrap_or(false);
    if enabled && !current {
        if let Err(e) = al.enable() {
            eprintln!("[autostart] enable failed: {e}");
        }
    } else if !enabled && current {
        if let Err(e) = al.disable() {
            eprintln!("[autostart] disable failed: {e}");
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorInfo {
    /// Cursor position relative to the window's top-left, in logical px.
    pub x: f64,
    pub y: f64,
    /// Window size in logical px.
    pub width: f64,
    pub height: f64,
    pub inside: bool,
}

/// Global cursor position relative to this window (works even when the cursor
/// is outside the window, unlike DOM mouse events). Used for head look-at.
/// Async so the ~10 Hz poll never runs on (or blocks) the main thread.
#[tauri::command(async)]
fn cursor_relative(window: WebviewWindow) -> Result<CursorInfo, String> {
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
    let x = (cursor.x - pos.x as f64) / scale;
    let y = (cursor.y - pos.y as f64) / scale;
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    Ok(CursorInfo {
        x,
        y,
        width,
        height,
        inside: x >= 0.0 && y >= 0.0 && x <= width && y <= height,
    })
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let s = settings::load_settings(handle);
    let show_hide = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause_roam", "Pause roaming", true, !s.roam_enabled, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_hide, &pause, &settings_item, &sep, &quit])?;

    let pause_for_events = pause.clone();
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Grok Companion")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "toggle" => toggle_main(app),
            "pause_roam" => {
                let paused = pause_for_events.is_checked().unwrap_or(false);
                let _ = settings::update_settings(app, |s| {
                    s.roam_enabled = !paused;
                    // Un-pausing with the amount set to Off would do nothing visible.
                    if !paused && s.roam_amount == "off" {
                        s.roam_amount = settings::DEFAULT_ROAM_AMOUNT.to_string();
                    }
                });
                let _ = app.emit("tray-roam", !paused);
            }
            "settings" => {
                show_main(app);
                let _ = app.emit("tray-open-settings", ());
            }
            "quit" => {
                // Make sure no hidden PowerShell / CLI children outlive us.
                if let Some(st) = app.try_state::<Arc<SttState>>() {
                    proc::kill_slot(&st.wake_pid);
                    proc::kill_slot(&st.listen_pid);
                }
                if let Some(st) = app.try_state::<Arc<TtsState>>() {
                    proc::kill_slot(&st.synth_pid);
                    proc::kill_slot(&st.play_pid);
                }
                if let Some(st) = app.try_state::<Arc<GrokState>>() {
                    proc::kill_slot(&st.cli_pid);
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .manage(Arc::new(GrokState::new()))
        .manage(Arc::new(SttState::default()))
        .manage(Arc::new(TtsState::default()))
        .setup(|app| {
            if let Err(e) = build_tray(app) {
                eprintln!("[tray] could not create tray icon: {e}");
            }
            let s = settings::load_settings(app.handle());
            apply_autostart(app.handle(), s.autostart);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(s.always_on_top);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            save_api_key,
            clear_api_key,
            check_connection,
            list_models,
            chat_stream,
            cancel_chat,
            memory_list,
            memory_remember,
            memory_delete,
            memory_clear,
            stt_listen_windows,
            stt_cancel_listen,
            stt_wait_wake_word,
            stt_cancel_wake,
            tts_speak_natural,
            tts_stop,
            tts_default_voice,
            cursor_relative,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
