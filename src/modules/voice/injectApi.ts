import { invoke } from "@tauri-apps/api/core";

export interface GrokWindow {
  hwnd: string;
  title: string;
  process: string;
  pid: number;
  isGrok: boolean;
}

export async function listGrokWindows(): Promise<GrokWindow[]> {
  return invoke<GrokWindow[]>("list_grok_windows");
}

export async function injectToGrokTerminal(
  text: string,
  hwnd?: string | null,
): Promise<string> {
  return invoke<string>("inject_to_grok_terminal", { text, hwnd: hwnd ?? null });
}
