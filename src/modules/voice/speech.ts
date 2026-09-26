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
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function useVoice(opts: UseVoiceOptions) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [wakeArmed, setWakeArmed] = useState(false);

  const browserRecognitionRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const listenGen = useRef(0);
  const wakeGen = useRef(0);
  const micOwnerRef = useRef<"idle" | "manual" | "wake">("idle");
  const speakingRef = useRef(false);
  const optsRef = useRef(opts);

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
    micOwnerRef.current = "idle";
    browserRecognitionRef.current?.abort();
    browserRecognitionRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const startListen = useCallback(() => {
    const gen = ++listenGen.current;
    micOwnerRef.current = "manual";
    setError(null);
    stopSpeaking();
    setSpeaking(false);
    speakingRef.current = false;

    void cancelWakeWord();
    wakeGen.current += 1;
    setWakeArmed(false);

    setListening(true);
    setInterim("Listening…");

    if (getSpeechRecognitionCtor()) {
      const handle = startRecognition({
        lang: optsRef.current.lang ?? navigator.language ?? "en-US",
        onInterim: (text) => {
          if (gen !== listenGen.current) return;
          setInterim(text || "Listening…");
        },
        onFinal: (text) => {
          if (gen !== listenGen.current) return;
          browserRecognitionRef.current = null;
          micOwnerRef.current = "idle";
          setListening(false);
          setInterim("");
          if (text.trim()) optsRef.current.onFinalTranscript(text.trim());
        },
        onError: (message) => {
          if (gen !== listenGen.current) return;
          browserRecognitionRef.current = null;
          micOwnerRef.current = "idle";
          setListening(false);
          setInterim("");
          setError(message);
        },
        onEnd: () => {
          if (gen !== listenGen.current) return;
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
    }

    void (async () => {
      try {
        const text = await listenWindowsOffline(12);
        if (gen !== listenGen.current) return;
        micOwnerRef.current = "idle";
        setListening(false);
        setInterim("");
        if (text.trim()) optsRef.current.onFinalTranscript(text.trim());
      } catch (err) {
        if (gen !== listenGen.current) return;
        micOwnerRef.current = "idle";
        setListening(false);
        setInterim("");
        setError(errText(err) || "Speech recognition failed.");
      }
    })();
  }, []);

  const toggleListen = useCallback(() => {
    if (listening) stopListen();
    else startListen();
  }, [listening, startListen, stopListen]);

  const stopSpeak = useCallback(() => {
    stopSpeaking();
    speakingRef.current = false;
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      setError(null);
      speakingRef.current = true;
      setSpeaking(true);
      stopListen();

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
          } catch (err) {
            setError(errText(err) || "Could not speak.");
          }
        } finally {
          speakingRef.current = false;
          setSpeaking(false);
        }
      })();
    },
    [voices, stopListen],
  );

  useEffect(() => {
    if (!opts.wakeWordEnabled) {
      wakeGen.current += 1;
      micOwnerRef.current = micOwnerRef.current === "wake" ? "idle" : micOwnerRef.current;
      setWakeArmed(false);
      return;
    }

    const gen = ++wakeGen.current;
    const word = opts.wakeWord ?? "hey";

    const loop = async () => {
      while (gen === wakeGen.current) {
        if (micOwnerRef.current === "manual" || speakingRef.current) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }

        setWakeArmed(true);
        setInterim(`Say “${word}”…`);

        try {
          const detected = await waitWakeWord(word);
          if (gen !== wakeGen.current) return;
          if (!detected || detected.trim().length === 0) continue;

          micOwnerRef.current = "wake";
          setWakeArmed(false);
          setListening(true);
          setInterim("Heard you — go ahead…");

          const text = await listenWindowsOffline(10);
          if (gen !== wakeGen.current) return;

          micOwnerRef.current = "idle";
          setListening(false);
          setInterim("");

          if (text.trim()) {
            const cleaned = text.replace(new RegExp(`^\\s*(?:${word}|hey|hi|hay)\\b[\\s,]*`, "i"), "").trim();
            optsRef.current.onFinalTranscript(cleaned || text);
          }
        } catch {
          if (gen !== wakeGen.current) return;
          setWakeArmed(true);
          setInterim(`Say “${word}”…`);
        }
      }
    };

    void loop();

    return () => {
      wakeGen.current += 1;
      setWakeArmed(false);
      micOwnerRef.current = micOwnerRef.current === "wake" ? "idle" : micOwnerRef.current;
      void cancelWakeWord();
    };
  }, [opts.wakeWordEnabled, opts.wakeWord, speaking]);

  useEffect(() => {
    return () => {
      listenGen.current += 1;
      wakeGen.current += 1;
      micOwnerRef.current = "idle";
      browserRecognitionRef.current?.abort();
      void cancelWakeWord();
      stopSpeaking();
    };
  }, []);

  return {
    listening,
    speaking,
    interim,
    error,
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























































































































