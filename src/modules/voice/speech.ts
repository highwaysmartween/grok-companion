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
    // Prefer East-Asian English / Xiaoxiao-like for companion personality
    if (/xiaoxiao|yan|luna|hong kong|hongkong|huihui|nanami/.test(n)) return 0;
    if (/emma|aria|natasha|molly|natural|neural|online|ana/.test(n)) return 1;
    if (/zira|samantha|hazel|susan/.test(n)) return 2;
    if (/female|woman|girl/.test(n)) return 3;
    if (/jenny/.test(n)) return 4; // avoid generic Jenny
    return 5;
  };
  return [...pool].sort((a, b) => score(a.name) - score(b.name))[0] ?? null;
}

export interface RecognitionHandle {
  stop: () => void;
  abort: () => void;
}

/** Offline Windows dictation (System.Speech) — no network. */
export async function listenWindowsOffline(timeoutSecs = 8): Promise<string> {
  return invoke<string>("stt_listen_windows", { timeoutSecs });
}

/** Blocks until wake word (default "hey") via Windows offline speech. */
export async function waitWakeWord(word = "hey"): Promise<string> {
  return invoke<string>("stt_wait_wake_word", { word });
}

/** Stop the background wake-word PowerShell so tap-to-talk can own the mic. */
export async function cancelWakeWord(): Promise<void> {
  try {
    await invoke("stt_cancel_wake");
  } catch {
    /* ignore */
  }
}

/** Microsoft Edge neural TTS — sounds like a real person (needs network). */
/** Default: Yan (HK) — East Asian teen/young woman speaking English. */
export const DEFAULT_NEURAL_VOICE = "en-HK-YanNeural";

export async function speakNatural(
  text: string,
  voice = DEFAULT_NEURAL_VOICE,
): Promise<void> {
  await invoke("tts_speak_natural", { text, voice });
}

export async function stopNaturalSpeaking(): Promise<void> {
  try {
    await invoke("tts_stop");
  } catch {
    /* ignore */
  }
}

export function startRecognition(opts: {
  lang?: string;
  onStart?: () => void;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
}): RecognitionHandle | null {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    opts.onError?.("No cloud speech in this WebView — use Windows offline mic or type.");
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
      network:
        "Cloud speech needs internet. The app uses Windows offline dictation when you tap the mic.",
      aborted: "Listening cancelled.",
    };
    const message = map[ev.error] ?? `Speech error: ${ev.error}`;
    if (ev.error !== "aborted") opts.onError?.(message);
  };
  rec.onend = () => opts.onEnd?.();

  try {
    rec.start();
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : "Could not start microphone.");
    return null;
  }

  return {
    stop: () => {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    },
    abort: () => {
      try {
        rec.abort();
      } catch {
        /* already stopped */
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

export function stopSpeaking() {
  if (speechSynthesisAvailable()) {
    window.speechSynthesis.cancel();
  }
  void stopNaturalSpeaking();
}
