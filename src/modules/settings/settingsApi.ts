import { invoke } from "@tauri-apps/api/core";
import type { PublicSettings, SettingsPayload } from "../../types";

export async function getSettings(): Promise<PublicSettings> {
  return invoke<PublicSettings>("get_settings");
}

export async function saveSettings(settings: SettingsPayload): Promise<PublicSettings> {
  return invoke<PublicSettings>("save_settings", { settings });
}

export async function saveApiKey(apiKey: string): Promise<PublicSettings> {
  return invoke<PublicSettings>("save_api_key", { apiKey });
}

export async function clearApiKey(): Promise<PublicSettings> {
  return invoke<PublicSettings>("clear_api_key");
}
