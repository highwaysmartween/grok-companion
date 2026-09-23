mod grok;
mod memory;
mod settings;
mod stt;
mod tts;

use grok::{cancel_chat, chat_stream, check_connection, list_models, GrokState};
use memory::{memory_clear, memory_delete, memory_list, memory_remember};
use settings::{clear_api_key, get_settings, save_api_key, save_settings};
use stt::{stt_cancel_wake, stt_listen_windows, stt_wait_wake_word, SttState};
use tts::{tts_default_voice, tts_speak_natural, tts_stop, TtsState};
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(Arc::new(GrokState::new()))
        .manage(SttState::default())
        .manage(TtsState::default())
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
            stt_wait_wake_word,
            stt_cancel_wake,
            tts_speak_natural,
            tts_stop,
            tts_default_voice,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
