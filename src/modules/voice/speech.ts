/** Voice helpers. STT: Windows offline. TTS: Edge neural (real voice) with Web Speech fallback. */

import { invoke } from "@tauri-apps/api/core";

export function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function speechRecognitionAvailable(): boolean {
  return true;
}

export function speechSynthesisAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function listVoices(): SpeechSynthesisVoice[] {
  if (!speechSynthesisAvailable()) return [];
  return window.speechSynthesis.getVoices();
}

/** Prefer neural / natural female voices when Web Speech is used as fallback. */
export function pickVoice(
  voices: SpeechSynthesisVoice[],
  preferredName?: string,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  if (preferredName) {
    const exact = voices.find((v) => v.name === preferredName);
    if (exact) return exact;
  }
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const pool = en.length ? en : voices;
  const score = (name: string) => {
    const n = name.toLowerCase();
    if (/xiaoxiao|yan|luna|hong kong|hongkong|huihui|nanami/.test(n)) return 0;
    if (/emma|aria|natasha|molly|natural|neural|online|ana/.test(n)) return 1;
    if (/zira|samantha|hazel|susan/.test(n)) return 2;
    if (/female|woman|girl/.test(n)) return 3;
    if (/jenny/.test(n)) return 4;
    return 5;
  };
  return [...pool].sort((a, b) => score(a.name) - score(b.name))[0] ?? null;
}

export interface RecognitionHandle {
  stop: () => void;
  abort: () => void;
}

/** Offline Windows dictation (System.Speech) — no network. Cancel with cancelListenWindows(). */
export async function listenWindowsOffline(timeoutSecs = 8): Promise<string> {
  return invoke<string>("stt_listen_windows", { timeoutSecs });
}

/** Kill an in-flight offline listen (tap-to-talk cancel). */
export async function cancelListenWindows(): Promise<void> {
  try {
    await invoke("stt_cancel_listen");
  } catch {
    // ignore
  }
}

export interface WakeOutcome {
  status: "wake" | "timeout" | "cancelled";
  /** What was said right after the wake word (same warm recognizer). */
  text: string;
}

/**
 * Arms the offline wake listener ("hey" / "hey <name>"). Resolves on wake,
 * timeout or cancel; rejects on engine/mic errors (caller backs off).
 * The backend also emits `stt-wake` the instant the wake word is heard.
 */
export async function waitWakeWord(opts: {
  word?: string;
  name?: string;
  minConfidence?: number;
} = {}): Promise<WakeOutcome> {
  return invoke<WakeOutcome>("stt_wait_wake_word", {
    word: opts.word ?? "hey",
    name: opts.name ?? null,
    minConfidence: opts.minConfidence ?? null,
  });
}

/** Stop the background wake-word PowerShell so tap-to-talk / TTS can own the audio. */
export async function cancelWakeWord(): Promise<void> {
  try {
    await invoke("stt_cancel_wake");
  } catch {
    // ignore
  }
}

let ackCtx: AudioContext | null = null;
/** Tiny soft two-note blip so the user knows she's listening (no asset needed). */
export function playAck(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    ackCtx = ackCtx ?? new Ctx();
    const ctx = ackCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    for (const [i, freq] of [660, 880].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = now + i * 0.07;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.06, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.13);
    }
  } catch {
    // audio is optional
  }
}

/** Microsoft Edge neural TTS — sounds like a real person (needs network). */
/** Default: Yan (HK) — East Asian teen/young woman speaking English. */
export const DEFAULT_NEURAL_VOICE = "en-HK-YanNeural";

/** Resolves "done" when playback finished, "stopped" when cut off by tts_stop / a newer utterance. */
export async function speakNatural(
  text: string,
  voice = DEFAULT_NEURAL_VOICE,
): Promise<"done" | "stopped"> {
  const r = await invoke<string>("tts_speak_natural", { text, voice });
  return r === "stopped" ? "stopped" : "done";
}

/** v1.2: synthesize one sentence (warm edge-tts helper) → mp3 bytes, played in the webview. */
export async function synthNatural(text: string, voice = DEFAULT_NEURAL_VOICE): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("tts_synth", { text, voice });
}

let liveAudio: HTMLAudioElement | null = null;
let liveAudioDone: (() => void) | null = null;

/** Play mp3 bytes; resolves when finished or stopped. Rejects if the webview can't play it. */
export function playMp3(bytes: ArrayBuffer, onStart?: () => void): Promise<"done" | "stopped"> {
  stopMp3();
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
  const audio = new Audio(url);
  audio.preload = "auto";
  liveAudio = audio;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (r: "done" | "stopped") => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      URL.revokeObjectURL(url);
      if (liveAudio === audio) {
        liveAudio = null;
        liveAudioDone = null;
      }
      resolve(r);
    };
    liveAudioDone = () => finish("stopped");
    // Never let a lost "ended" pin her in Speaking… (2 min hard cap per sentence).
    const watchdog = window.setTimeout(() => finish("done"), 120_000);
    audio.onended = () => finish("done");
    audio.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      URL.revokeObjectURL(url);
      reject(new Error("webview audio error"));
    };
    audio.onplaying = () => onStart?.();
    audio.play().catch((err) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      URL.revokeObjectURL(url);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export function stopMp3(): void {
  const a = liveAudio;
  const done = liveAudioDone;
  liveAudio = null;
  liveAudioDone = null;
  if (a) {
    try {
      a.pause();
      a.removeAttribute("src");
    } catch {
      // ignore
    }
  }
  done?.();
}

/** Soft three-note chime for alarms / timers (WebAudio, no asset). */
export function playChime(repeats = 3): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    ackCtx = ackCtx ?? new Ctx();
    const ctx = ackCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    for (let r = 0; r < repeats; r++) {
      for (const [i, freq] of [784, 988, 1319].entries()) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const t0 = now + r * 1.1 + i * 0.16;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.62);
      }
    }
  } catch {
    // audio is optional
  }
}

export async function stopNaturalSpeaking(): Promise<void> {
  try {
    await invoke("tts_stop");
  } catch {
    // ignore
  }
}

export function startRecognition(opts: {
  lang?: string;
  onStart?: () => void;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  /** `code` is the raw SpeechRecognition error ("network", "not-allowed", …). */
  onError?: (message: string, code: string) => void;
  onEnd?: () => void;
}): RecognitionHandle | null {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    opts.onError?.("No cloud speech in this WebView — use Windows offline mic or type.", "unsupported");
    return null;
  }

  const rec = new Ctor();
  rec.lang = opts.lang ?? navigator.language ?? "en-US";
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => opts.onStart?.();
  rec.onresult = (ev) => {
    let interim = "";
    let finalText = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      const transcript = res[0]?.transcript ?? "";
      if (res.isFinal) finalText += transcript;
      else interim += transcript;
    }
    if (interim) opts.onInterim?.(interim);
    if (finalText) opts.onFinal?.(finalText.trim());
  };
  rec.onerror = (ev) => {
    const map: Record<string, string> = {
      "not-allowed": "Microphone permission was denied.",
      "no-speech": "I didn't catch that — try again?",
      "audio-capture": "No microphone found.",
      network: "Cloud speech needs internet. The app uses Windows offline dictation when you tap the mic.",
      aborted: "Listening cancelled.",
    };
    const message = map[ev.error] ?? `Speech error: ${ev.error}`;
    if (ev.error !== "aborted") opts.onError?.(message, ev.error);
  };
  rec.onend = () => opts.onEnd?.();

  try {
    rec.start();
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : "Could not start microphone.", "start-failed");
    return null;
  }

  return {
    stop: () => {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    },
    abort: () => {
      try {
        rec.abort();
      } catch {
        // ignore
      }
    },
  };
}

/** Legacy Web Speech (robotic on many PCs) — only used if natural TTS fails. */
export function speak(text: string, opts?: { voice?: SpeechSynthesisVoice | null; rate?: number }) {
  if (!speechSynthesisAvailable()) {
    throw new Error("Speech synthesis is not available in this WebView.");
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = opts?.rate ?? 0.98;
  utter.pitch = 1.0;
  if (opts?.voice) utter.voice = opts.voice;
  window.speechSynthesis.speak(utter);
  return utter;
}

/** Stop Web Speech + kill the natural-voice player. Await it before starting a new utterance. */
export async function stopSpeaking(): Promise<void> {
  stopMp3();
  if (speechSynthesisAvailable()) {
    window.speechSynthesis.cancel();
  }
  await stopNaturalSpeaking();
}
