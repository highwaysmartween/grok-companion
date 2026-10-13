import { Channel, invoke } from "@tauri-apps/api/core";
import type { ChatStreamEvent, ConnectionStatus } from "../../types";

export async function checkConnection(): Promise<ConnectionStatus> {
  return invoke<ConnectionStatus>("check_connection");
}

export async function listModels(): Promise<string[]> {
  return invoke<string[]>("list_models");
}

export async function cancelChat(): Promise<void> {
  await invoke("cancel_chat");
}

/**
 * `voice: true` = a spoken turn: the Rust side uses the fast streaming API
 * model with a low token cap and a leaner context so her first words come quick.
 */
export async function streamChat(
  messages: { role: string; content: string }[],
  onEvent: (event: ChatStreamEvent) => void,
  opts?: { voice?: boolean },
): Promise<void> {
  const channel = new Channel<ChatStreamEvent>();
  channel.onmessage = onEvent;
  await invoke("chat_stream", { messages, voice: opts?.voice === true, onEvent: channel });
}

/** Pre-open the HTTPS connection to the brain (called on "hey Nova"). */
export function warmBrain(): void {
  void invoke("brain_warm").catch(() => undefined);
}
