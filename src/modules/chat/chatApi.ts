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

export async function streamChat(
  messages: { role: string; content: string }[],
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const channel = new Channel<ChatStreamEvent>();
  channel.onmessage = onEvent;
  await invoke("chat_stream", { messages, onEvent: channel });
}
