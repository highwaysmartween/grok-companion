import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelWakeWord,
  DEFAULT_NEURAL_VOICE,
  getSpeechRecognitionCtor,
  listenWindowsOffline,
  listVoices,
  pickVoice,
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
}

function errText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  try { return JSON.stringify(err); } catch { return String(err); }
}

export function useVoice(opts: UseVoiceOptions) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [wakeArmed, setWakeArmed] = useState(false);
  const speakingRef = useRef(false);
  const commandListeningRef = useRef(false);
  const optsRef = useRef(opts);
  const browserRecognitionRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const listenGen = useRef(0);
  const wakeGen = useRef(0);
  optsRef.current = opts;

  useEffect(() => {
    if (!speechSynthesisAvailable()) return;
    const load = () => setVoices(listVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  const stopListen = useCallback(() => {
    listenGen.current += 1;
    commandListeningRef.current = false;
    browserRecognitionRef.current?.abort();
    browserRecognitionRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const startListen = useCallback(() => {
    setError(null);
    stopSpeaking();
    setSpeaking(false);
    speakingRef.current = false;
    commandListeningRef.current = true;
    void cancelWakeWord();
    const gen = ++listenGen.current;
    setListening(true);
    setInterim("Listening… speak now");

    // WebView2's native recognizer generally gives better results than the
    // legacy System.Speech PowerShell engine. Use it when available, while
    // retaining Windows offline dictation as the fallback.
    if (getSpeechRecognitionCtor()) {
      const handle = startRecognition({
        lang: optsRef.current.lang ?? navigator.language ?? "en-US",
        onInterim: (text) => { if (gen === listenGen.current) setInterim(text); },
        onFinal: (text) => {
          if (gen !== listenGen.current) return;
          browserRecognitionRef.current = null;
          commandListeningRef.current = false;
          setListening(false);
          setInterim("");
          if (text.trim()) optsRef.current.onFinalTranscript(text.trim());
        },
        onError: (message) => {
          if (gen !== listenGen.current) return;
          browserRecognitionRef.current = null;
          commandListeningRef.current = false;
          setListening(false);
          setInterim("");
          setError(message);
        },
        onEnd: () => {
          if (gen !== listenGen.current || browserRecognitionRef.current === null) return;
          browserRecognitionRef.current = null;
          commandListeningRef.current = false;
          setListening(false);
          setInterim("");
        },
      });
      if (handle) {
        browserRecognitionRef.current = handle;
        return;
      }
    }

    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, 250));
        if (gen !== listenGen.current) return;
        const text = await listenWindowsOffline(15);
        if (gen !== listenGen.current) return;
        setInterim("");
        setListening(false);
        if (text.trim()) optsRef.current.onFinalTranscript(text.trim());
      } catch (err) {
        if (gen !== listenGen.current) return;
        setListening(false);
        setInterim("");
        setError(errText(err) || "Speech recognition failed. Try typing or tap the mic again.");
      } finally {
        commandListeningRef.current = false;
      }
    })();
  }, [stopListen]);

  const toggleListen = useCallback(() => {
    if (listening) stopListen(); else startListen();
  }, [listening, startListen, stopListen]);

  const speak = useCallback((text: string) => {
    if (!text.trim()) return;
    setError(null);
    speakingRef.current = true;
    setSpeaking(true);
    void (async () => {
      try {
        await speakNatural(text, DEFAULT_NEURAL_VOICE);
      } catch {
        try {
          await new Promise<void>((resolve, reject) => {
            const utter = speakRaw(text, { voice: pickVoice(voices), rate: 0.98 });
            utter.onend = () => resolve();
            utter.onerror = () => reject(new Error("web speech failed"));
          });
        } catch (err) { setError(errText(err) || "Could not speak."); }
      } finally {
        speakingRef.current = false;
        setSpeaking(false);
      }
    })();
  }, [voices]);

  const stopSpeak = useCallback(() => {
    stopSpeaking();
    speakingRef.current = false;
    setSpeaking(false);
  }, []);

  useEffect(() => {
    if (!opts.wakeWordEnabled) {
      wakeGen.current += 1;
      setWakeArmed(false);
      return;
    }
    const gen = ++wakeGen.current;
    const word = opts.wakeWord ?? "hey";
    let cancelled = false;
    const loop = async () => {
      while (!cancelled && gen === wakeGen.current) {
        if (speakingRef.current || commandListeningRef.current) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        setWakeArmed(true);
        setInterim(`Say “${word}”…`);
        try {
          await waitWakeWord(word);
          if (cancelled || gen !== wakeGen.current) return;
          setWakeArmed(false);
          setError(null);
          commandListeningRef.current = true;
          setListening(true);
          setInterim("Heard you — go ahead…");
          let text = "";
          try { text = await listenWindowsOffline(10); } finally { commandListeningRef.current = false; }
          if (cancelled || gen !== wakeGen.current) return;
          setListening(false);
          setInterim("");
          if (text) optsRef.current.onFinalTranscript(text.replace(/^\s*(hey|hay|hi)\b[\s,]*/i, "").trim() || text);
        } catch (err) {
          if (cancelled || gen !== wakeGen.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          if (!/timed out|cancelled/i.test(msg)) { setError(msg); await new Promise((r) => setTimeout(r, 1600)); setError(null); }
          setListening(false);
          setWakeArmed(true);
        }
      }
    };
    void loop();
    return () => { cancelled = true; wakeGen.current += 1; setWakeArmed(false); };
  }, [opts.wakeWordEnabled, opts.wakeWord]);

  useEffect(() => () => {
    listenGen.current += 1;
    wakeGen.current += 1;
    browserRecognitionRef.current?.abort();
    stopSpeaking();
  }, []);

  return {
    listening, speaking, interim, error, wakeArmed,
    sttAvailable: true,
    ttsAvailable: speechSynthesisAvailable(),
    startListen, stopListen, toggleListen, speak, stopSpeak,
  };
}
