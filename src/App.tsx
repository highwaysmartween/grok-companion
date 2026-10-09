import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Companion, snapToFloor } from "./modules/pet/Companion";
import { normalizeRoamAmount, type GestureKind } from "./modules/pet/behaviour";
import { gestureForReply } from "./modules/pet/gestures";
import type { GestureCue } from "./modules/pet/CompanionVRM";
import { ChatPanel } from "./modules/chat/ChatPanel";
import { SettingsPanel } from "./modules/settings/SettingsPanel";
import { StatusBar } from "./modules/status/StatusBar";
import { useChat } from "./modules/chat/useChat";
import { useVoice } from "./modules/voice/useVoice";
import { getSettings, saveSettings, toPayload } from "./modules/settings/settingsApi";
import { checkConnection } from "./modules/chat/chatApi";
import type { ConnectionKind, PetMood, PublicSettings } from "./types";
import "./App.css";

type ModelOpt = { id: string; name: string; file: string };

const FLASH_LINES = [
  "Okay… fine. Eyes up here though.",
  "You're shameless. Whatever — look.",
  "Hmm. Just this once.",
];

/** Real inactivity timer (runs on its own interval, not on voice state changes). */
const SLEEP_AFTER_MS = 120_000;
const SETTLE_AFTER_MS = 25_000;
const MOOD_TICK_MS = 3_000;
/** Coming back after this long (no mouse / chat) earns a wave hello. */
const RETURN_WAVE_AFTER_MS = 90_000;
const TRANSIENT_MOODS: PetMood[] = ["happy", "confused", "annoyed", "sad", "error"];

function classifyUserMood(raw: string): PetMood {
  const text = raw.toLowerCase();
  if (/(hello|hi|hey|thanks|love|cool|awesome|great|happy|good|nice|amazing|glad|fun|smile)/.test(text)) return "happy";
  if (/(what|why|confused|unclear|huh|lost|not sure|weird|wait|sorry|uncertain)/.test(text)) return "confused";
  if (/(angry|annoyed|ugh|hate|bad|annoying|stupid|damn|furious|upset|irritated)/.test(text)) return "annoyed";
  if (/(sad|down|lonely|tired|cry|hurt|upset|rough|depressed|exhausted)/.test(text)) return "sad";
  return "idle";
}

const findModelIdx = (list: ModelOpt[], key: string | undefined | null) =>
  key ? list.findIndex((m) => m.id === key || m.file === key) : -1;

export default function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [mood, setMood] = useState<PetMood>("idle");
  const [input, setInput] = useState("");
  const [connection, setConnection] = useState<ConnectionKind>("unknown");
  const [connectionMessage, setConnectionMessage] = useState("Starting…");
  const [models, setModels] = useState<string[]>([]);
  const [compact, setCompact] = useState(true);
  const [modelsCatalog, setModelsCatalog] = useState<ModelOpt[]>([]);
  const [modelIdx, setModelIdx] = useState(0);
  const [flash, setFlash] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
  const coverSwapTimer = useRef(0);
  const [hovered, setHovered] = useState(false);
  const [reactKey, setReactKey] = useState(0);
  const [cue, setCue] = useState<GestureCue | null>(null);
  const cueSeq = useRef(0);
  const fireCue = useCallback((kind: GestureKind) => {
    cueSeq.current += 1;
    setCue({ kind, id: cueSeq.current });
  }, []);
  const preFlashIdx = useRef<number | null>(null);
  const restoredModel = useRef(false);
  const sendRef = useRef<(text: string, meta?: { fromVoice?: boolean }) => Promise<void>>(async () => undefined);
  const lastInteractionRef = useRef(Date.now());
  const lastMoveBump = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const touchMood = useCallback((next: PetMood) => {
    lastInteractionRef.current = Date.now();
    setMood(next);
  }, []);

  const name = settings?.companionName || "Nova";

  const voice = useVoice({
    wakeWordEnabled: settings ? settings.wakeWordEnabled !== false : false,
    wakeWord: "hey",
    name,
    voice: settings?.voiceTarget,
    onWake: () => fireCue("wave"),
    onFinalTranscript: (text) => {
      setInput("");
      touchMood(classifyUserMood(text));
      void sendRef.current(text, { fromVoice: true });
    },
  });
  const chat = useChat({
    settings,
    setMood: touchMood,
    speakReply: (text) => voice.speak(plainForSpeech(text)),
    onReply: (text, replyMood) => {
      const g = gestureForReply(text, replyMood);
      if (g) fireCue(g);
    },
  });

  const persist = useCallback(async (patch: Partial<Parameters<typeof toPayload>[1]>) => {
    const s = settingsRef.current;
    if (!s) return;
    try {
      setSettings(await saveSettings(toPayload(s, patch)));
    } catch (err) {
      console.warn("[app] could not save settings", err);
    }
  }, []);

  const handleUserText = useCallback(async (text: string, meta?: { fromVoice?: boolean }) => {
    const flashCmd = isFlashCommand(text);
    if (flashCmd === "on") {
      const prefer = (m: ModelOpt) => /r18|companion\.vrm$|companion_05/i.test(`${m.id} ${m.file}`);
      const cur = modelsCatalog[modelIdx];
      if (!cur || !prefer(cur)) {
        const idx = modelsCatalog.findIndex(prefer);
        if (idx >= 0) {
          if (preFlashIdx.current == null) preFlashIdx.current = modelIdx;
          setModelIdx(idx);
        }
      }
      window.clearTimeout(coverSwapTimer.current);
      setFlash(true);
      // She stops, stands, grabs the hem and pulls her top up (CompanionVRM flash move).
      setFlashKey((k) => k + 1);
      touchMood("happy");
      voice.speak(FLASH_LINES[Math.floor(Math.random() * FLASH_LINES.length)]!);
      return;
    }
    if (flashCmd === "off") {
      setFlash(false);
      // Let her lower the top on this model before swapping back to the previous one.
      window.clearTimeout(coverSwapTimer.current);
      coverSwapTimer.current = window.setTimeout(() => {
        if (preFlashIdx.current != null) {
          setModelIdx(preFlashIdx.current);
          preFlashIdx.current = null;
        }
      }, 1600);
      touchMood("happy");
      voice.speak("Whatever. Clothes back on.");
      return;
    }
    touchMood(classifyUserMood(text));
    await chat.send(text, meta);
  }, [chat, voice, modelsCatalog, modelIdx, touchMood, fireCue]);

  sendRef.current = handleUserText;

  // Activity-driven moods.
  useEffect(() => {
    if (voice.listening) touchMood("listening");
    else if (chat.busy) touchMood("thinking");
    else if (voice.speaking) touchMood("speaking");
    else setMood((cur) => (cur === "listening" || cur === "thinking" || cur === "speaking" ? "idle" : cur));
  }, [voice.listening, voice.speaking, chat.busy, touchMood]);

  // Independent inactivity timer → settle transient moods, then sleep.
  const activeRef = useRef(false);
  activeRef.current = voice.listening || voice.speaking || chat.busy;
  useEffect(() => {
    const id = window.setInterval(() => {
      if (activeRef.current) return;
      const idleFor = Date.now() - lastInteractionRef.current;
      setMood((cur) => {
        if (idleFor > SLEEP_AFTER_MS) return "sleeping";
        if (idleFor > SETTLE_AFTER_MS && TRANSIENT_MOODS.includes(cur)) return "idle";
        return cur;
      });
    }, MOOD_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const bumpActivity = useCallback(() => {
    const now = Date.now();
    if (now - lastMoveBump.current < 1000) return;
    lastMoveBump.current = now;
    const away = now - lastInteractionRef.current;
    lastInteractionRef.current = now;
    if (away > RETURN_WAVE_AFTER_MS) fireCue("wave");
    setMood((cur) => (cur === "sleeping" ? "idle" : cur));
  }, [fireCue]);

  useEffect(() => {
    void fetch("/models/catalog.json").then((r) => r.json()).then((list: ModelOpt[]) => {
      if (Array.isArray(list) && list.length) setModelsCatalog(list);
    }).catch(() => setModelsCatalog([{ id: "default", name: "Companion", file: "/models/companion.vrm" }]));
  }, []);

  // Restore the chosen character once both settings and catalog are known.
  useEffect(() => {
    if (restoredModel.current || !settings || modelsCatalog.length === 0) return;
    restoredModel.current = true;
    const idx = findModelIdx(modelsCatalog, settings.characterModel);
    if (idx >= 0) setModelIdx(idx);
  }, [settings, modelsCatalog]);

  const nextCharacter = useCallback(() => {
    if (modelsCatalog.length === 0) return;
    const idx = (modelIdx + 1) % modelsCatalog.length;
    preFlashIdx.current = null; // an explicit pick wins over the flash swap
    setModelIdx(idx);
    void persist({ characterModel: modelsCatalog[idx]!.id });
  }, [modelIdx, modelsCatalog, persist]);

  const refreshConnection = useCallback(async () => {
    try {
      const status = await checkConnection();
      setConnectionMessage(status.message); setModels(status.models);
      setConnection(!status.hasApiKey ? "nokey" : status.connected ? "online" : "error");
    } catch (err) {
      setConnection("offline");
      setConnectionMessage(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await getSettings();
        if (cancelled) return;
        setSettings(s);
        if (!s.hasApiKey) setSettingsOpen(true);
        try {
          await getCurrentWindow().setAlwaysOnTop(s.alwaysOnTop);
        } catch {
          // preview
        }
        void snapToFloor();
        await refreshConnection();
      } catch (err) {
        if (!cancelled) {
          setConnection("error");
          setConnectionMessage(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    const id = window.setInterval(() => void refreshConnection(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshConnection]);

  // Tray menu → frontend.
  useEffect(() => {
    const offs: (() => void)[] = [];
    let disposed = false;
    const add = (p: Promise<() => void>) =>
      p.then((fn) => (disposed ? fn() : offs.push(fn))).catch(() => undefined);
    add(listen("tray-open-settings", () => setSettingsOpen(true)));
    add(listen<boolean>("tray-roam", (e) => setSettings((s) => {
      if (!s) return s;
      const on = !!e.payload;
      return { ...s, roamEnabled: on, roamAmount: on && s.roamAmount === "off" ? "calm" : s.roamAmount };
    })));
    return () => {
      disposed = true;
      offs.forEach((fn) => fn());
    };
  }, []);

  const title = useMemo(() => `${name} — Grok Companion`, [name]);
  const toggleCompact = async () => {
    const next = !compact; setCompact(next); setChatOpen(!next);
    try {
      const { LogicalSize } = await import("@tauri-apps/api/dpi");
      const win = getCurrentWindow();
      await win.setSize(new LogicalSize(next ? 440 : 480, next ? 640 : 820));
      await win.setAlwaysOnTop(next || !!settings?.alwaysOnTop);
      if (next) void snapToFloor();
    } catch {
      // preview/browser fallback
    }
  };
  const sendTyped = () => { const text = input.trim(); if (!text) return; setInput(""); void handleUserText(text); };
  const wakeHint = voice.listening ? voice.interim || "Listening…" : voice.wakeArmed ? "Say “hey”…" : voice.speaking ? "Speaking…" : null;
  // Tray "Pause roaming" clears roamEnabled; the amount itself is kept.
  const roamAmount = settings && settings.roamEnabled !== false ? normalizeRoamAmount(settings.roamAmount) : "off";
  const roamPaused = !compact || chatOpen || settingsOpen || hovered;
  const micActive = voice.listening || voice.speaking;

  return <div
    className={`shell ${compact ? "is-compact" : ""}`}
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    onMouseMove={bumpActivity}
  >
    <div className="stars" />
    <header className="titlebar" data-tauri-drag-region><span className="brand">{title}</span><div className="win-actions">
      <button type="button" onClick={nextCharacter} title="Change character">◈</button>
      <button type="button" onClick={() => void toggleCompact()} title="Toggle companion view">{compact ? "▣" : "▬"}</button>
      <button type="button" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
      <button type="button" onClick={() => void getCurrentWindow().minimize()} title="Minimize">–</button>
      <button type="button" onClick={() => void getCurrentWindow().hide()} title="Hide to tray (Quit from the tray icon)">×</button>
    </div></header>
    <div className="companion-click-target" onClick={() => { setReactKey((k) => k + 1); bumpActivity(); if (compact) setChatOpen(true); }} title="Open companion chat">
      <Companion mood={mood} name={name} compact={compact} modelUrl={modelsCatalog[modelIdx]?.file} flash={flash} flashKey={flashKey} roamAmount={roamAmount} roamPaused={roamPaused} reactKey={reactKey} cue={cue} playful={!!settings?.playful} />
    </div>
    {!compact && <StatusBar connection={connection} connectionMessage={connectionMessage} mood={mood} listening={voice.listening} speaking={voice.speaking} busy={chat.busy} wakeArmed={voice.wakeArmed} interim={voice.interim} />}
    {(!compact || chatOpen) && <div className={compact ? "compact-chat" : "full-chat"}>
      {compact && <button type="button" className="chat-close" onClick={() => setChatOpen(false)}>×</button>}
      <ChatPanel messages={chat.messages} busy={chat.busy} listening={voice.listening} interim={voice.interim || (voice.wakeArmed ? "Say hey…" : "")} input={input} onInput={setInput} onSend={sendTyped} onMic={() => (voice.listening ? voice.stopListen() : voice.startListen())} onStopSpeak={() => { voice.stopSpeak(); touchMood("idle"); }} speaking={voice.speaking} sttAvailable={voice.sttAvailable} companionName={name} />
    </div>}
    {compact && !chatOpen && <div className={`compact-mic ${micActive ? "active" : ""}`}>
      <span className="wake-hint">{wakeHint}</span>
      <button
        type="button"
        className={voice.listening ? "hot" : voice.wakeArmed ? "armed" : ""}
        onClick={() => (voice.listening ? voice.stopListen() : voice.speaking ? voice.stopSpeak() : voice.startListen())}
      >
        {voice.listening ? "Listening… (tap to stop)" : voice.speaking ? "Stop" : "Tap to talk"}
      </button>
    </div>}
    {voice.error && <p className="banner">{voice.error}</p>}{chat.error && <p className="banner">{chat.error}</p>}
    {voice.wakeStatus && <p className="banner subtle">{voice.wakeStatus}</p>}
    {settingsOpen && settings && <SettingsPanel
      settings={settings}
      models={models}
      chatCount={chat.messages.length}
      onClearChat={() => chat.clear()}
      onClose={() => setSettingsOpen(false)}
      onSaved={(s) => {
        setSettings(s);
        void getCurrentWindow().setAlwaysOnTop(compact || s.alwaysOnTop).catch(() => undefined);
        void refreshConnection();
      }}
    />}
  </div>;
}

function isFlashCommand(text: string): "on" | "off" | null {
  const t = text.trim().toLowerCase().replace(/^hey\b[\s,]*/i, "");
  if (/\b(flash|undress|strip|topless|get\s*naked|take\s*(it|them|your\s*)?(clothes|top|shirt)?\s*off|tits?\s*out|boobs?\s*out|show\s*(me\s*)?(your\s*)?(tits|boobs|breasts|body|chest))\b/.test(t)) return "on";
  if (/\b(cover\s*up|put\s*(it|them|clothes)\s*on|unflash|dress(\s*up)?)\b/.test(t)) return "off";
  return null;
}

function plainForSpeech(text: string) { return text.replace(/[`*_#]/g, "").replace(/\n+/g, " ").trim(); }
