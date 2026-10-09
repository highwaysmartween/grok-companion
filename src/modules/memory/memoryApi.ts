import { invoke } from "@tauri-apps/api/core";
import type { MemoryFact } from "../../types";

export async function listMemories(): Promise<MemoryFact[]> {
  return invoke<MemoryFact[]>("memory_list");
}

/** `replacePrefix`: drop older facts starting with this first (e.g. "User's name is"). */
export async function rememberFact(fact: string, replacePrefix?: string): Promise<MemoryFact> {
  return invoke<MemoryFact>("memory_remember", { fact, replacePrefix: replacePrefix ?? null });
}

export async function deleteMemory(id: string): Promise<MemoryFact[]> {
  return invoke<MemoryFact[]>("memory_delete", { id });
}

export async function clearMemory(): Promise<void> {
  await invoke("memory_clear");
}
