import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelWakeWord,
  DEFAULT_NEURAL_VOICE,
  listenWindowsOffline,
  listVoices,
  pickVoice,
  speak as speakRaw,
  speakNatural,
  speechSynthesisAvailable,
  stopSpeaking,
  waitWakeWord,
} from "./speech";

export interface UseVoiceOptions {
  onFinalTranscript: (text: string) => void;
  lang?: string;
  /** Continuously listen for wake word "hey", then capture a command. */
  wakeWordEnabled?: boolean;
  wakeWord?: string;
}


function errText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
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
  const speakingRef = useRef(false);
  const commandListeningRef = useRef(false);
  const optsRef = useRef(opts);
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
    setListening(false);
    setInterim("");
  }, []);

  const startListen = useCallback(() => {
    setError(null);
    try {
      stopSpeaking();
    } catch {
      /* ignore */
    }
    setSpeaking(false);
    speakingRef.current = false;
    // Free mic from wake-word PowerShell before dictation
    commandListeningRef.current = true;
    void cancelWakeWord();
    const gen = ++listenGen.current;
    setListening(true);
    setInterim("Listening… speak now");
    void (async () => {
      try {
        // Give TTS / wake PS a moment to release the audio device
        await new Promise((r) => setTimeout(r, 350));
        if (gen !== listenGen.current) return;
        const text = await listenWindowsOffline(12);
        if (gen !== listenGen.current) return;
        setInterim("");
        setListening(false);
        if (text) optsRef.current.onFinalTranscript(text);
      } catch (err) {
        if (gen !== listenGen.current) return;
        setListening(false);
        setInterim("");
        setError(errText(err) || "Offline speech failed.");
      } finally {
        commandListeningRef.current = false;
      }
    })();
  }, []);

  const toggleListen = useCallback(() => {
    if (listening) stopListen();
    else startListen();
  }, [listening, startListen, stopListen]);

  const speak = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      setError(null);
      speakingRef.current = true;
      setSpeaking(true);
      void (async () => {
        try {
          // Real person voice (Microsoft neural) — needs a short network hop
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
    [voices],
  );

  const stopSpeak = useCallback(() => {
    stopSpeaking();
    speakingRef.current = false;
    setSpeaking(false);
  }, []);

  // Wake-word loop: "hey" → capture utterance → send
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
        // Don't steal the mic while speaking or capturing a command
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
          setInterim("Heard hey — go ahead…");
          let text = "";
          try {
            text = await listenWindowsOffline(8);
          } finally {
            commandListeningRef.current = false;
          }
          if (cancelled || gen !== wakeGen.current) return;
          setListening(false);
          setInterim("");
          if (text) {
            // Strip leading wake word if dictation captured it too
            const cleaned = text.replace(/^\s*(hey|hay|hi)\b[\s,]*/i, "").trim() || text;
            optsRef.current.onFinalTranscript(cleaned);
          }
        } catch (err) {
          if (cancelled || gen !== wakeGen.current) return;
          // Timeouts: just keep listening. Real errors: surface briefly.
          const msg = err instanceof Error ? err.message : String(err);
          // Cancelled for tap-to-talk / soft timeouts: keep loop quiet
          if (!/timed out|cancelled/i.test(msg)) {
            setError(msg);
            await new Promise((r) => setTimeout(r, 2000));
            setError(null);
          }
          setListening(false);
          setWakeArmed(true);
        }
      }
    };

    void loop();
    return () => {
      cancelled = true;
      wakeGen.current += 1;
      setWakeArmed(false);
    };
  }, [opts.wakeWordEnabled, opts.wakeWord]);

  useEffect(() => {
    return () => {
      listenGen.current += 1;
      wakeGen.current += 1;
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
