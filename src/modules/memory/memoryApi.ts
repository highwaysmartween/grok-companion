import { invoke } from "@tauri-apps/api/core";
import type { MemoryFact } from "../../types";

export async function listMemories(): Promise<MemoryFact[]> {
  return invoke<MemoryFact[]>("memory_list");
}

export async function rememberFact(fact: string): Promise<MemoryFact> {
  return invoke<MemoryFact>("memory_remember", { fact });
}

export async function deleteMemory(id: string): Promise<MemoryFact[]> {
  return invoke<MemoryFact[]>("memory_delete", { id });
}

export async function clearMemory(): Promise<void> {
  await invoke("memory_clear");
}
