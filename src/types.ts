export type PetMood = "idle" | "listening" | "thinking" | "speaking" | "happy" | "error";

export type ChatRole = "user" | "assistant" | "system";

export type BrainProvider = "auto" | "xai-api" | "grok-cli";

export interface ChatMessage {
  id: string;
  role: Exclude<ChatRole, "system">;
  content: string;
  pending?: boolean;
  error?: boolean;
  local?: boolean;
}

export interface PublicSettings {
  hasApiKey: boolean;
  apiKeyHint: string | null;
  model: string;
  systemPrompt: string;
  personality: string;
  companionName: string;
  alwaysOnTop: boolean;
  autoSpeak: boolean;
  ttsEnabled: boolean;
  temperature: number;
  maxTokens: number;
  brainProvider: BrainProvider | string;
  voiceTarget: string;
  characterModel: string;
}

export interface SettingsPayload {
  model: string;
  systemPrompt: string;
  personality: string;
  companionName: string;
  alwaysOnTop: boolean;
  autoSpeak: boolean;
  ttsEnabled: boolean;
  temperature: number;
  maxTokens: number;
  brainProvider: BrainProvider | string;
  voiceTarget: string;
  characterModel: string;
}

export interface ConnectionStatus {
  connected: boolean;
  hasApiKey: boolean;
  message: string;
  models: string[];
}

export interface MemoryFact {
  id: string;
  fact: string;
  createdAt: number;
}

export type ChatStreamEvent =
  | { event: "started"; data: { requestId: string; model: string } }
  | { event: "delta"; data: { requestId: string; text: string } }
  | { event: "done"; data: { requestId: string; fullText: string } }
  | { event: "error"; data: { requestId: string; message: string } };

export type ConnectionKind = "unknown" | "offline" | "nokey" | "online" | "error";
