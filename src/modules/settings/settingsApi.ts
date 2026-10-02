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

/** Full payload from current public settings, with optional overrides. */
export function toPayload(s: PublicSettings, patch: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    model: s.model,
    systemPrompt: s.systemPrompt,
    personality: s.personality,
    companionName: s.companionName,
    alwaysOnTop: s.alwaysOnTop,
    autoSpeak: s.autoSpeak,
    ttsEnabled: s.ttsEnabled,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    brainProvider: s.brainProvider,
    voiceTarget: s.voiceTarget || "en-HK-YanNeural",
    characterModel: s.characterModel || "",
    autostart: s.autostart,
    roamEnabled: s.roamEnabled,
    wakeWordEnabled: s.wakeWordEnabled,
    ...patch,
  };
}
