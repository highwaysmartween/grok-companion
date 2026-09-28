import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, PetMood, PublicSettings } from "../../types";
import { handleMemoryIntent, parseMemoryIntent } from "../memory/memoryIntent";
import { cancelChat, streamChat } from "./chatApi";

const HISTORY_KEY = "grok-companion.conversation.v1";
const uid = () => crypto.randomUUID();

function loadHistory(): ChatMessage[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(value) ? value.filter((m) => m && m.role && m.content) : [];
  } catch {
    return [];
  }
}

function emotionForReply(text: string): PetMood {
  const lower = text.toLowerCase();
  if (/sorry|error|can't|cannot|failed|unable|glitch/.test(lower)) return "error";
  if (/not sure|confused|unclear|what do you mean/.test(lower)) return "confused";
  if (/great|awesome|glad|love that|congrat/.test(lower)) return "happy";
  return "idle";
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
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aborting = useRef(false);
  const busyRef = useRef(false);
  const ctrl = useRef(controller);
  ctrl.current = controller;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-100)));
    } catch { /* storage can be unavailable in preview mode */ }
  }, [messages]);

  const send = useCallback(async (raw: string, meta?: { fromVoice?: boolean }) => {
    const text = raw.trim();
    if (!text || busyRef.current) return;
    aborting.current = false;
    setError(null);
    const userMsg: ChatMessage = { id: uid(), role: "user", content: text };
    const history = [...messagesRef.current.filter((m) => !m.error && m.content), userMsg].map((m) => ({ role: m.role, content: m.content }));
    messagesRef.current = [...messagesRef.current, userMsg];
    setMessages((m) => [...m, userMsg]);
    const { settings, setMood, speakReply } = ctrl.current;
    const wantSpeak = settings?.ttsEnabled !== false && (meta?.fromVoice === true || settings?.autoSpeak !== false);

    const intent = parseMemoryIntent(text);
    if (intent) {
      try {
        const reply = await handleMemoryIntent(intent);
        setMessages((m) => [...m, { id: uid(), role: "assistant", content: reply, local: true }]);
        setMood("happy");
        if (wantSpeak) speakReply?.(reply); else window.setTimeout(() => setMood("idle"), 1200);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setMood("error");
      }
      return;
    }

    if (!settings?.hasApiKey) {
      const tip = "I need Grok connected before I can talk. Open Settings and choose Grok CLI or add an xAI API key.";
      setMessages((m) => [...m, { id: uid(), role: "assistant", content: tip, local: true, error: true }]);
      setMood("error");
      if (wantSpeak || meta?.fromVoice) speakReply?.(tip);
      return;
    }

    const assistantId = uid();
    setMessages((m) => [...m, { id: assistantId, role: "assistant", content: "", pending: true }]);
    busyRef.current = true;
    setBusy(true);
    setMood("thinking");
    let assembled = "";
    try {
      await streamChat(history, (event) => {
        if (aborting.current) return;
        if (event.event === "delta") {
          assembled += event.data.text;
          setMood("speaking");
          setMessages((m) => m.map((msg) => msg.id === assistantId ? { ...msg, content: assembled, pending: true } : msg));
        } else if (event.event === "done") {
          assembled = event.data.fullText || assembled;
          setMessages((m) => m.map((msg) => msg.id === assistantId ? { ...msg, content: assembled || "…", pending: false } : msg));
        } else if (event.event === "error") {
          setError(event.data.message);
          setMessages((m) => m.map((msg) => msg.id === assistantId ? { ...msg, content: assembled || event.data.message, pending: false, error: !assembled } : msg));
          setMood("error");
        }
      });
      if (!aborting.current && assembled) {
        setMood(emotionForReply(assembled));
        if (wantSpeak) speakReply?.(assembled);
      } else if (!assembled) {
        const fallback = VOICE_FALLBACKS[Math.floor(Math.random() * VOICE_FALLBACKS.length)]!;
        setMessages((m) => m.map((msg) => msg.id === assistantId ? { ...msg, content: fallback, pending: false, error: true, local: true } : msg));
        if (wantSpeak || meta?.fromVoice) speakReply?.(fallback);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!aborting.current) {
        setError(message);
        setMessages((m) => m.map((msg) => msg.id === assistantId ? { ...msg, content: message, pending: false, error: true } : msg));
        setMood("error");
        if (wantSpeak || meta?.fromVoice) speakReply?.(message);
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
    localStorage.removeItem(HISTORY_KEY);
    ctrl.current.setMood("idle");
  }, []);

  return { messages, busy, error, send, stop, clear };
}
