import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, PetMood, PublicSettings } from "../../types";
import { extractAutoFacts, handleMemoryIntent, parseMemoryIntent } from "../memory/memoryIntent";
import { rememberFact } from "../memory/memoryApi";
import { isNo, isYes, openTarget, parseToolIntent, runAction, runToolIntent } from "../tools/intents";
import { cancelChat, streamChat } from "./chatApi";
import { latencyMark } from "./latency";

const HISTORY_KEY = "grok-companion.conversation.v1";
/** Messages (user + assistant) sent to the brain per request (~12 turns); memories ride in the system prompt. */
const SEND_HISTORY = 24;
/** Messages kept on screen / in localStorage. */
const KEEP_HISTORY = 80;
/** Summarise + extract memories every N brain turns (background). */
const DIGEST_EVERY = 6;
/** No words from the brain yet after this long → a quick spoken "one sec". */
const ACK_AFTER_MS = 1_800;
const ACKS = ["Mm, one sec.", "Hang on.", "Gimme a sec.", "Okay, hold on.", "Let me check."];
const uid = () => crypto.randomUUID();

function loadHistory(): ChatMessage[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(value)
      ? value.filter((m) => m && m.role && m.content && !m.pending).slice(-KEEP_HISTORY)
      : [];
  } catch {
    return [];
  }
}

const capped = (list: ChatMessage[]) => (list.length > KEEP_HISTORY ? list.slice(-KEEP_HISTORY) : list);

export function emotionForReply(text: string): PetMood {
  const lower = text.toLowerCase();
  if (/sorry|error|can't|cannot|failed|unable|glitch/.test(lower)) return "error";
  if (/not sure|confused|unclear|what do you mean/.test(lower)) return "confused";
  if (/great|awesome|glad|love that|congrat/.test(lower)) return "happy";
  return "idle";
}

/** Hidden tags the brain may add: stripped before showing / speaking. */
const TAG_RE = /<(remember|action)>([\s\S]*?)<\/\1>/gi;

export function splitTags(text: string): { clean: string; remember: string[]; actions: string[] } {
  const remember: string[] = [];
  const actions: string[] = [];
  const clean = text
    .replace(TAG_RE, (_, kind: string, body: string) => {
      (kind.toLowerCase() === "remember" ? remember : actions).push(body.trim());
      return "";
    })
    // An unterminated tag at the end (stream cut) never gets spoken.
    .replace(/<(?:remember|action)>[\s\S]*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { clean, remember, actions };
}

/**
 * Streaming sentence splitter: feed deltas, get back complete sentences ready
 * to speak. Text inside (or possibly starting) a hidden tag is held back.
 */
export class SentenceStream {
  private buf = "";
  private spokenUpTo = 0;
  push(delta: string): string[] {
    this.buf += delta;
    return this.drain(false);
  }
  flush(): string[] {
    return this.drain(true);
  }
  private drain(final: boolean): string[] {
    let visible: string;
    if (final) {
      visible = splitTags(this.buf).clean;
    } else {
      // Complete tags removed; nothing after an open "<" (maybe a tag starting).
      visible = this.buf.replace(TAG_RE, "");
      const lt = visible.indexOf("<");
      if (lt >= 0) visible = visible.slice(0, lt);
    }
    const out: string[] = [];
    for (;;) {
      const pending = visible.slice(this.spokenUpTo);
      const re = /[.!?…]+["')\]]*(?=\s)|\n/g;
      let m: RegExpExecArray | null;
      let cut = -1;
      while ((m = re.exec(pending)) !== null) {
        const end = m.index + m[0].length;
        const cand = pending.slice(0, end).trim();
        // First sentence goes out as soon as it's complete; later ones ≥ 12 chars
        // so "Ok." / "Yeah." don't each cost a TTS round-trip.
        const min = this.spokenUpTo === 0 && out.length === 0 ? 2 : 12;
        if (cand.replace(/[\s.!?…,"')\]]/g, "").length > 0 && cand.length >= min) {
          cut = end;
          out.push(cand);
          break;
        }
      }
      if (cut < 0) break;
      this.spokenUpTo += cut;
    }
    if (final) {
      const rest = visible.slice(this.spokenUpTo).trim();
      this.spokenUpTo = visible.length;
      if (rest.replace(/[\s.!?…,]/g, "")) out.push(rest);
    }
    return out;
  }
}

export interface ChatController {
  settings: PublicSettings | null;
  setMood: (mood: PetMood) => void;
  /** Speak a line. `queue` plays after whatever she's saying. */
  speakReply?: (text: string, mode?: "replace" | "queue") => void;
  /** Called once per finished brain reply with its text and the mood it set. */
  onReply?: (text: string, mood: PetMood) => void;
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
  const pendingOpen = useRef<string | null>(null);
  const brainTurns = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.filter((m) => !m.pending).slice(-KEEP_HISTORY)));
    } catch { /* storage can be unavailable in preview mode */ }
  }, [messages]);

  /** Local reply (tools / memory): shown, spoken, and given to the brain as "[App] …" context. */
  const localReply = useCallback((reply: string, wantSpeak: boolean, mood: PetMood = "happy") => {
    setMessages((m) => capped([...m, { id: uid(), role: "assistant", content: reply, local: true, tool: true }]));
    ctrl.current.setMood(mood);
    latencyMark("reply-local");
    if (wantSpeak) ctrl.current.speakReply?.(reply, "replace");
    else window.setTimeout(() => ctrl.current.setMood("idle"), 1200);
  }, []);

  const send = useCallback(async (raw: string, meta?: { fromVoice?: boolean }) => {
    const text = raw.trim();
    if (!text || busyRef.current) return;
    aborting.current = false;
    setError(null);
    latencyMark("transcript", text);
    const userMsg: ChatMessage = { id: uid(), role: "user", content: text };
    const prior = messagesRef.current.filter((m) => !m.error && !m.pending && m.content && (!m.local || m.tool));
    const history = [...prior, userMsg]
      .slice(-SEND_HISTORY)
      .map((m) => ({ role: m.role, content: m.tool ? `[App] ${m.content}` : m.content }));
    messagesRef.current = capped([...messagesRef.current, userMsg]);
    setMessages((m) => capped([...m, userMsg]));
    const { settings, setMood, speakReply } = ctrl.current;
    const wantSpeak = settings?.ttsEnabled !== false && (meta?.fromVoice === true || settings?.autoSpeak !== false);

    // A yes/no for "want me to open example.com?".
    if (pendingOpen.current) {
      const url = pendingOpen.current;
      if (isYes(text)) {
        pendingOpen.current = null;
        try {
          const r = await openTarget(url, true);
          localReply(r.status === "opened" ? `Opening ${url.replace(/^https?:\/\//, "")}.` : "Couldn't open that one.", wantSpeak);
        } catch (err) {
          localReply(`Couldn't open it: ${err instanceof Error ? err.message : String(err)}`, wantSpeak, "error");
        }
        return;
      }
      pendingOpen.current = null;
      if (isNo(text)) {
        localReply("Okay, leaving it.", wantSpeak);
        return;
      }
    }

    const intent = parseMemoryIntent(text);
    if (intent) {
      try {
        localReply(await handleMemoryIntent(intent), wantSpeak);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setMood("error");
      }
      return;
    }

    const tool = parseToolIntent(text);
    if (tool) {
      try {
        const out = await runToolIntent(tool);
        if (out.confirmOpen) pendingOpen.current = out.confirmOpen;
        localReply(out.reply, wantSpeak);
      } catch (err) {
        localReply(`Couldn't do that: ${err instanceof Error ? err.message : String(err)}`, wantSpeak, "error");
      }
      return;
    }

    // Lightweight automatic memory for clear statements ("my name is…", "I like…").
    for (const f of extractAutoFacts(text)) {
      void rememberFact(f.fact, f.replacePrefix).catch(() => undefined);
    }

    // API brain without a key can't work at all. For the CLI brain we still try even if
    // the readiness probe says "not signed in" — the CLI's own error is more precise.
    if (!settings || (!settings.hasApiKey && settings.brainProvider === "xai-api")) {
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
    let spokeAny = false;
    let ackSpoken = false;
    let firstDelta = true;
    const sentences = new SentenceStream();
    const speakChunk = (s: string) => {
      if (!wantSpeak || aborting.current) return;
      if (!spokeAny) latencyMark("first-sentence", s);
      speakReply?.(s, spokeAny || ackSpoken ? "queue" : "replace");
      spokeAny = true;
    };
    const ackTimer = wantSpeak
      ? window.setTimeout(() => {
          if (firstDelta && !aborting.current) {
            ackSpoken = true;
            speakReply?.(ACKS[Math.floor(Math.random() * ACKS.length)]!, "replace");
          }
        }, ACK_AFTER_MS)
      : 0;
    try {
      await streamChat(history, (event) => {
        if (aborting.current) return;
        if (event.event === "delta") {
          if (firstDelta) {
            firstDelta = false;
            latencyMark("first-token");
          }
          assembled += event.data.text;
          setMood("speaking");
          const shown = splitTags(assembled).clean;
          setMessages((m) => m.map((msg) => msg.id === assistantId ? { ...msg, content: shown, pending: true } : msg));
          for (const s of sentences.push(event.data.text)) speakChunk(s);
        } else if (event.event === "done") {
          assembled = event.data.fullText || assembled;
        } else if (event.event === "error") {
          setError(event.data.message);
          setMessages((m) => m.map((msg) => msg.id === assistantId ? { ...msg, content: splitTags(assembled).clean || event.data.message, pending: false, error: !assembled } : msg));
          setMood("error");
        }
      });
      window.clearTimeout(ackTimer);
      const { clean, remember, actions } = splitTags(assembled);
      if (!aborting.current && clean) {
        for (const s of sentences.flush()) speakChunk(s);
        setMessages((m) => m.map((msg) => msg.id === assistantId ? { ...msg, content: clean, pending: false } : msg));
        const replyMood = emotionForReply(clean);
        setMood(replyMood);
        ctrl.current.onReply?.(clean, replyMood);
        latencyMark("reply-done");
      } else if (!clean && !aborting.current) {
        const fallback = VOICE_FALLBACKS[Math.floor(Math.random() * VOICE_FALLBACKS.length)]!;
        setMessages((m) => m.map((msg) => msg.id === assistantId ? { ...msg, content: fallback, pending: false, error: true, local: true } : msg));
        if (wantSpeak || meta?.fromVoice) speakReply?.(fallback, ackSpoken ? "queue" : "replace");
      }
      if (remember.length) void invoke("memory_add_many", { facts: remember }).catch(() => undefined);
      for (const a of actions) {
        void runAction(a).then((err) => {
          if (err) setError(err);
        });
      }
      brainTurns.current += 1;
      if (brainTurns.current % DIGEST_EVERY === 0) {
        const recent = [...messagesRef.current, { role: "assistant", content: clean }]
          .filter((m) => m.content)
          .slice(-SEND_HISTORY)
          .map((m) => ({ role: m.role, content: m.content }));
        void invoke("memory_digest", { messages: recent }).catch((e) => console.warn("[memory] digest failed", e));
      }
    } catch (err) {
      window.clearTimeout(ackTimer);
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
  }, [localReply]);

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

  /** Say something that isn't a reply (alarm going off), and log it in the chat. */
  const announce = useCallback((text: string) => {
    setMessages((m) => capped([...m, { id: uid(), role: "assistant", content: text, local: true, tool: true }]));
  }, []);

  return { messages, busy, error, send, stop, clear, announce };
}
