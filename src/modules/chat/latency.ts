import { invoke } from "@tauri-apps/api/core";

/**
 * Turn latency log (v1.2): wake → transcript → first token → first sentence →
 * first audio. Written to %APPDATA%\com.grok.desktopcompanion\latency.log.
 */
let turn: { start: number; marks: string[] } | null = null;

export function latencyMark(name: string, detail?: string): void {
  const now = performance.now();
  if (name === "wake" || (name === "transcript" && !turn)) turn = { start: now, marks: [] };
  if (!turn) return;
  turn.marks.push(`${name}=${Math.round(now - turn.start)}ms${detail ? ` [${detail.slice(0, 60).replace(/\s+/g, " ")}]` : ""}`);
  if (name === "audio-start" || name === "reply-done-noaudio") {
    const line = `${new Date().toISOString()} ${turn.marks.join(" ")}`;
    turn = null;
    console.info("[latency]", line);
    void invoke("log_latency", { line }).catch(() => undefined);
  }
}

export function latencyReset(): void {
  turn = null;
}
