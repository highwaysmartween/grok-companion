import { useCallback, useRef, useState } from "react";
import type { ChatMessage, PetMood, PublicSettings } from "../../types";
import { handleMemoryIntent, parseMemoryIntent } from "../memory/memoryIntent";
import { cancelChat, streamChat } from "./chatApi";

function uid() {
  return crypto.randomUUID();
}

export interface ChatController {
  settings: PublicSettings | null;
  setMood: (mood: PetMood) => void;
  speakReply?: (text: string) => void;
}

const VOICE_FALLBACKS = [
  "Hmm, my brain glitched for a sec. Say that again?",
  "Lost the thread — try me one more time.",
  "Ugh, connection hiccup. Still here though.",
];

export function useChat(controller: ChatController) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aborting = useRef(false);
  const busyRef = useRef(false);
  const ctrl = useRef(controller);
  ctrl.current = controller;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const send = useCallback(async (raw: string, meta?: { fromVoice?: boolean }) => {
    const text = raw.trim();
    if (!text || busyRef.current) return;

    aborting.current = false;
    setError(null);
    const userMsg: ChatMessage = { id: uid(), role: "user", content: text };
    const history = [...messagesRef.current.filter((m) => !m.error && m.content), userMsg].map(
      (m) => ({ role: m.role, content: m.content }),
    );
    messagesRef.current = [...messagesRef.current, userMsg];
    setMessages((m) => [...m, userMsg]);

    const { settings, setMood, speakReply } = ctrl.current;
    // Auto-speak every reply unless user explicitly disabled TTS.
    // Voice path always speaks (even if autoSpeak somehow false).
    const wantSpeak =
      settings?.ttsEnabled !== false &&
      (meta?.fromVoice === true || settings?.autoSpeak !== false);

    const intent = parseMemoryIntent(text);
    if (intent) {
      try {
        const reply = await handleMemoryIntent(intent);
        const bot: ChatMessage = {
          id: uid(),
          role: "assistant",
          content: reply,
          local: true,
        };
        setMessages((m) => [...m, bot]);
        setMood("happy");
        if (wantSpeak) speakReply?.(reply);
        else window.setTimeout(() => setMood("idle"), 1200);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setMood("error");
        if (meta?.fromVoice) {
          const fb = VOICE_FALLBACKS[Math.floor(Math.random() * VOICE_FALLBACKS.length)]!;
          speakReply?.(fb);
        }
      }
      return;
    }

    if (!settings?.hasApiKey) {
      const tip =
        "I need an xAI API key before I can talk to Grok. Open Settings and paste one in — it stays on this machine.";
      const bot: ChatMessage = {
        id: uid(),
        role: "assistant",
        content: tip,
        local: true,
        error: true,
      };
      setMessages((m) => [...m, bot]);
      setMood("error");
      // Still speak so voice path is never silent
      if (wantSpeak || meta?.fromVoice) speakReply?.(tip);
      return;
    }

    const assistantId = uid();
    setMessages((m) => [
      ...m,
      { id: assistantId, role: "assistant", content: "", pending: true },
    ]);
    busyRef.current = true;
    setBusy(true);
    setMood("thinking");

    let assembled = "";
    let sawDelta = false;

    try {
      await streamChat(history, (event) => {
        if (aborting.current) return;
        if (event.event === "delta") {
          assembled += event.data.text;
          if (!sawDelta) {
            sawDelta = true;
            setMood("speaking");
          }
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantId ? { ...msg, content: assembled, pending: true } : msg,
            ),
          );
        } else if (event.event === "done") {
          assembled = event.data.fullText || assembled;
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantId
                ? { ...msg, content: assembled || "…", pending: false }
                : msg,
            ),
          );
        } else if (event.event === "error") {
          setError(event.data.message);
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantId
                ? {
                    ...msg,
                    content: assembled || event.data.message,
                    pending: false,
                    error: !assembled,
                  }
                : msg,
            ),
          );
          setMood("error");
        }
      });

      if (!aborting.current && assembled) {
        if (wantSpeak) speakReply?.(assembled);
        else setMood("idle");
      } else if (!assembled) {
        // API returned nothing — never leave voice path silent
        const fb = VOICE_FALLBACKS[Math.floor(Math.random() * VOICE_FALLBACKS.length)]!;
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? { ...msg, content: fb, pending: false, error: true, local: true }
              : msg,
          ),
        );
        if (wantSpeak || meta?.fromVoice) speakReply?.(fb);
        else setMood("idle");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!aborting.current) {
        setError(message);
        const fb =
          assembled ||
          (meta?.fromVoice
            ? VOICE_FALLBACKS[Math.floor(Math.random() * VOICE_FALLBACKS.length)]!
            : message);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: fb,
                  pending: false,
                  error: !assembled,
                }
              : msg,
          ),
        );
        setMood("error");
        // Voice / auto-speak: still talk so she never goes mute on failure
        if (wantSpeak || meta?.fromVoice) {
          speakReply?.(
            assembled ||
              VOICE_FALLBACKS[Math.floor(Math.random() * VOICE_FALLBACKS.length)]!,
          );
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    aborting.current = true;
    await cancelChat();
    busyRef.current = false;
    setBusy(false);
    ctrl.current.setMood("idle");
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setError(null);
    ctrl.current.setMood("idle");
  }, []);

  return { messages, busy, error, send, stop, clear };
}
