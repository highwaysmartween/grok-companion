import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelListenWindows,
  cancelWakeWord,
  DEFAULT_NEURAL_VOICE,
  getSpeechRecognitionCtor,
  listenWindowsOffline,
  listVoices,
  pickVoice,
  playAck,
  speak as speakRaw,
  speakNatural,
  speechSynthesisAvailable,
  startRecognition,
  stopSpeaking,
  waitWakeWord,
} from "./speech";

export interface UseVoiceOptions {
  onFinalTranscript: (text: string) => void;
  lang?: string;
  wakeWordEnabled?: boolean;
  wakeWord?: string;
  /** Companion name — enables "hey <name>" as well as "hey". */
  name?: string;
  /** Edge neural voice (default en-HK-YanNeural). */
  voice?: string;
  /** The wake word was just heard (before the command is transcribed). */
  onWake?: () => void;
}

/** Browser SpeechRecognition errors that mean "this engine won't work here" → use offline Windows STT. */
const BROWSER_STT_FATAL = new Set(["network", "not-allowed", "service-not-allowed", "language-not-supported", "unsupported", "start-failed"]);
/** Don't re-arm the wake listener until her own voice has fully died away. */
const SPEECH_TAIL_MS = 700;
const WAKE_BACKOFF_MIN_MS = 1_000;
const WAKE_BACKOFF_MAX_MS = 30_000;

function errText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type MicOwner = "idle" | "manual" | "wake";

export function useVoice(opts: UseVoiceOptions) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wakeStatus, setWakeStatus] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [wakeArmed, setWakeArmed] = useState(false);

  const browserRecognitionRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const offlineListenRef = useRef(false);
  const browserSttBrokenRef = useRef(false);
  const listenGen = useRef(0);
  const wakeGen = useRef(0);
  const micOwnerRef = useRef<MicOwner>("idle");
  const wakeArmedRef = useRef(false);
  const optsRef = useRef(opts);
  const voicesRef = useRef(voices);
  optsRef.current = opts;
  voicesRef.current = voices;

  // --- speech queue -------------------------------------------------------
  /** Bumped on every stop/replace: stale runners never touch `speaking`. */
  const speakEpoch = useRef(0);
  const nextUtterId = useRef(0);
  const queueRef = useRef<{ id: number; text: string }[]>([]);
  const playingIdRef = useRef<number | null>(null);
  const speakingRef = useRef(false);
  const quietUntilRef = useRef(0);

  const setSpeakingState = useCallback((v: boolean) => {
    speakingRef.current = v;
    if (!v) quietUntilRef.current = Date.now() + SPEECH_TAIL_MS;
    setSpeaking(v);
  }, []);

  const setArmed = useCallback((v: boolean) => {
    wakeArmedRef.current = v;
    setWakeArmed(v);
  }, []);

  // Errors are hints, not modal: fade them out so they don't sit on top of her forever.
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), 8000);
    return () => window.clearTimeout(id);
  }, [error]);

  useEffect(() => {
    if (!speechSynthesisAvailable()) return;
    const load = () => setVoices(listVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  const speakOne = useCallback(async (text: string, epoch: number) => {
    try {
      await speakNatural(text, optsRef.current.voice || DEFAULT_NEURAL_VOICE);
      return;
    } catch {
      if (epoch !== speakEpoch.current) return;
    }
    // Natural voice unavailable (no edge-tts / offline / not Windows) → Web Speech.
    try {
      await new Promise<void>((resolve, reject) => {
        const utter = speakRaw(text, { voice: pickVoice(voicesRef.current), rate: 0.98 });
        utter.onend = () => resolve();
        utter.onerror = (ev) => (ev.error === "interrupted" || ev.error === "canceled" ? resolve() : reject(new Error("web speech failed")));
      });
    } catch (err) {
      if (epoch === speakEpoch.current) setError(errText(err) || "Could not speak.");
    }
  }, []);

  const pump = useCallback(async (epoch: number) => {
    if (playingIdRef.current !== null) return; // a runner for this epoch is active
    while (epoch === speakEpoch.current && queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      playingIdRef.current = item.id;
      setSpeakingState(true);
      await speakOne(item.text, epoch);
      if (playingIdRef.current === item.id) playingIdRef.current = null;
    }
    // Only the runner of the live epoch, with nothing queued or playing, may end speaking.
    if (epoch === speakEpoch.current && playingIdRef.current === null && queueRef.current.length === 0) {
      setSpeakingState(false);
    }
  }, [setSpeakingState, speakOne]);

  /** Cut her off now (barge-in / stop button). */
  const stopSpeak = useCallback(() => {
    speakEpoch.current += 1;
    queueRef.current = [];
    playingIdRef.current = null;
    setSpeakingState(false);
    void stopSpeaking();
  }, [setSpeakingState]);

  // --- listening ------------------------------------------------------------
  const stopListen = useCallback(() => {
    listenGen.current += 1;
    if (micOwnerRef.current === "manual") micOwnerRef.current = "idle";
    browserRecognitionRef.current?.abort();
    browserRecognitionRef.current = null;
    if (offlineListenRef.current) {
      offlineListenRef.current = false;
      void cancelListenWindows();
    }
    setListening(false);
    setInterim("");
  }, []);

  /**
   * Speak a line. `mode: "replace"` (default) cuts off whatever she is saying;
   * `"queue"` plays after it. Every utterance gets an id so an earlier one
   * finishing can never flip `speaking` off while a later one plays.
   */
  const speak = useCallback(
    (text: string, mode: "replace" | "queue" = "replace") => {
      const clean = text.trim();
      if (!clean) return;
      setError(null);
      if (micOwnerRef.current === "manual") stopListen();
      const id = ++nextUtterId.current;
      const idle = playingIdRef.current === null && queueRef.current.length === 0;
      if (mode === "replace" || idle) {
        const epoch = ++speakEpoch.current;
        queueRef.current = [{ id, text: clean }];
        const wasPlaying = playingIdRef.current !== null;
        playingIdRef.current = null;
        setSpeakingState(true);
        void (async () => {
          // Kill the previous utterance *before* starting the next one so a
          // late tts_stop can't cut the new one off.
          if (wasPlaying || window.speechSynthesis?.speaking) await stopSpeaking();
          if (epoch === speakEpoch.current) await pump(epoch);
        })();
      } else {
        queueRef.current.push({ id, text: clean });
        void pump(speakEpoch.current);
      }
      // She shouldn't hear herself: `speaking` is already true (wake loop won't
      // re-arm) — now free the mic from any armed wake listener.
      void cancelWakeWord();
    },
    [pump, setSpeakingState, stopListen],
  );

  const runOfflineListen = useCallback((gen: number) => {
    offlineListenRef.current = true;
    setInterim("Listening… (offline)");
    void (async () => {
      try {
        const text = await listenWindowsOffline(12);
        if (gen !== listenGen.current) return;
        offlineListenRef.current = false;
        micOwnerRef.current = "idle";
        setListening(false);
        setInterim("");
        if (text.trim()) optsRef.current.onFinalTranscript(text.trim());
      } catch (err) {
        if (gen !== listenGen.current) return;
        offlineListenRef.current = false;
        micOwnerRef.current = "idle";
        setListening(false);
        setInterim("");
        const msg = errText(err);
        if (msg !== "cancelled") setError(msg || "Speech recognition failed.");
      }
    })();
  }, []);

  const startListen = useCallback(() => {
    const gen = ++listenGen.current;
    // Barge-in: tapping the mic cuts her off.
    if (speakingRef.current) stopSpeak();
    browserRecognitionRef.current?.abort();
    browserRecognitionRef.current = null;
    micOwnerRef.current = "manual";
    setError(null);
    setArmed(false);
    setListening(true);
    setInterim("Listening…");

    void (async () => {
      await cancelWakeWord(); // release the mic before we grab it
      if (gen !== listenGen.current) return;
      playAck();

      if (!browserSttBrokenRef.current && getSpeechRecognitionCtor()) {
        let gotFinal = false;
        let fellBack = false;
        const handle = startRecognition({
          lang: optsRef.current.lang ?? navigator.language ?? "en-US",
          onInterim: (text) => {
            if (gen !== listenGen.current) return;
            setInterim(text || "Listening…");
          },
          onFinal: (text) => {
            if (gen !== listenGen.current) return;
            gotFinal = true;
            browserRecognitionRef.current = null;
            micOwnerRef.current = "idle";
            setListening(false);
            setInterim("");
            if (text.trim()) optsRef.current.onFinalTranscript(text.trim());
          },
          onError: (message, code) => {
            if (gen !== listenGen.current) return;
            browserRecognitionRef.current = null;
            if (BROWSER_STT_FATAL.has(code)) {
              // WebView2 often has the API but no cloud backend ("network").
              browserSttBrokenRef.current = true;
              fellBack = true;
              runOfflineListen(gen);
              return;
            }
            micOwnerRef.current = "idle";
            setListening(false);
            setInterim("");
            setError(message);
          },
          onEnd: () => {
            if (gen !== listenGen.current || fellBack || gotFinal) return;
            browserRecognitionRef.current = null;
            micOwnerRef.current = "idle";
            setListening(false);
            setInterim("");
          },
        });
        if (handle) {
          browserRecognitionRef.current = handle;
          return;
        }
        if (fellBack) return;
        browserSttBrokenRef.current = true;
      }
      if (gen !== listenGen.current) return;
      runOfflineListen(gen);
    })();
  }, [runOfflineListen, setArmed, stopSpeak]);

  const toggleListen = useCallback(() => {
    if (micOwnerRef.current === "manual") stopListen();
    else startListen();
  }, [startListen, stopListen]);

  // --- wake word --------------------------------------------------------------
  // The backend emits `stt-wake` the instant it hears the wake word; the same
  // warm recognizer is already capturing the command.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen("stt-wake", () => {
      if (!wakeArmedRef.current || micOwnerRef.current !== "idle") return;
      micOwnerRef.current = "wake";
      setArmed(false);
      setListening(true);
      setInterim("Mm? Go ahead…");
      playAck();
      optsRef.current.onWake?.();
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setArmed]);

  useEffect(() => {
    if (!opts.wakeWordEnabled) {
      wakeGen.current += 1;
      if (micOwnerRef.current === "wake") micOwnerRef.current = "idle";
      setArmed(false);
      setWakeStatus(null);
      void cancelWakeWord();
      return;
    }

    const gen = ++wakeGen.current;
    const word = (opts.wakeWord ?? "hey").trim() || "hey";
    const name = (opts.name ?? "").trim();
    const stripRe = new RegExp(`^\\s*(?:${escapeRe(word)})(?:\\s+${name ? escapeRe(name) : "(?!)"})?\\b[\\s,.!?]*`, "i");

    // Read through a function so TS doesn't keep a stale narrowing across awaits.
    const owner = (): MicOwner => micOwnerRef.current;
    const loop = async () => {
      let backoff = 0;
      let reported = false;
      while (gen === wakeGen.current) {
        // Never arm while the mic is owned elsewhere, while she talks, or in her speech tail.
        if (owner() !== "idle" || speakingRef.current || Date.now() < quietUntilRef.current) {
          if (wakeArmedRef.current) setArmed(false);
          await sleep(200);
          continue;
        }
        setArmed(true);
        let outcome;
        try {
          outcome = await waitWakeWord({ word, name });
        } catch (err) {
          if (gen !== wakeGen.current) return;
          setArmed(false);
          backoff = backoff ? Math.min(backoff * 2, WAKE_BACKOFF_MAX_MS) : WAKE_BACKOFF_MIN_MS;
          if (!reported) {
            reported = true;
            setWakeStatus(`“${word}” wake word unavailable (${errText(err)}). Retrying quietly — tap to talk still works.`);
          }
          await sleep(backoff);
          continue;
        }
        if (gen !== wakeGen.current) return;
        backoff = 0;
        if (reported) {
          reported = false;
          setWakeStatus(null);
        }
        if (outcome.status === "cancelled") {
          // Someone else took the mic (tap-to-talk / TTS). Loop waits for idle.
          if (owner() === "wake") micOwnerRef.current = "idle";
          await sleep(150);
          continue;
        }
        if (outcome.status === "timeout") continue;

        // Wake heard.
        const owned = owner() === "wake" || owner() === "idle";
        if (owner() === "wake") micOwnerRef.current = "idle";
        if (!owned) continue;
        setArmed(false);
        setListening(false);
        setInterim("");
        const cleaned = outcome.text.replace(stripRe, "").trim();
        if (cleaned) optsRef.current.onFinalTranscript(cleaned);
      }
    };

    void loop();

    return () => {
      wakeGen.current += 1;
      setArmed(false);
      if (micOwnerRef.current === "wake") {
        micOwnerRef.current = "idle";
        setListening(false);
        setInterim("");
      }
      void cancelWakeWord();
    };
  }, [opts.wakeWordEnabled, opts.wakeWord, opts.name, setArmed]);

  useEffect(() => {
    return () => {
      listenGen.current += 1;
      wakeGen.current += 1;
      speakEpoch.current += 1;
      micOwnerRef.current = "idle";
      browserRecognitionRef.current?.abort();
      void cancelWakeWord();
      void cancelListenWindows();
      void stopSpeaking();
    };
  }, []);

  return {
    listening,
    speaking,
    interim,
    error,
    wakeStatus,
    wakeArmed,
    sttAvailable: true,
    ttsAvailable: speechSynthesisAvailable(),
    startListen,
    stopListen,
    toggleListen,
    speak,
    stopSpeak,
  };
}
