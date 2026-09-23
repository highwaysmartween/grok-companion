import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Companion } from "./modules/pet/Companion";
import { ChatPanel } from "./modules/chat/ChatPanel";
import { SettingsPanel } from "./modules/settings/SettingsPanel";
import { StatusBar } from "./modules/status/StatusBar";
import { useChat } from "./modules/chat/useChat";
import { useVoice } from "./modules/voice/useVoice";
import { getSettings } from "./modules/settings/settingsApi";
import { checkConnection } from "./modules/chat/chatApi";
import type { ConnectionKind, PetMood, PublicSettings } from "./types";
import "./App.css";

type ModelOpt = { id: string; name: string; file: string };

const FLASH_LINES = [
  "Okay… fine. Eyes up here though.",
  "You're shameless. Whatever — look.",
  "Hmm. Just this once.",
];

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
  const preFlashIdx = useRef<number | null>(null);
  const sendRef = useRef<(text: string, meta?: { fromVoice?: boolean }) => Promise<void>>(async () => undefined);

  const voice = useVoice({
    wakeWordEnabled: true,
    wakeWord: "hey",
    onFinalTranscript: (text) => { setInput(""); void sendRef.current(text, { fromVoice: true }); },
  });
  const chat = useChat({ settings, setMood, speakReply: (text) => voice.speak(plainForSpeech(text)) });

  const handleUserText = useCallback(async (text: string, meta?: { fromVoice?: boolean }) => {
    const flashCmd = isFlashCommand(text);
    if (flashCmd === "on") {
      const prefer = (m: ModelOpt) => /r18|companion\.vrm$|companion_05/i.test(`${m.id} ${m.file}`);
      const cur = modelsCatalog[modelIdx];
      if (!cur || !prefer(cur)) {
        const idx = modelsCatalog.findIndex(prefer);
        if (idx >= 0) { preFlashIdx.current = modelIdx; setModelIdx(idx); }
      }
      setFlash(true);
      setMood("happy");
      voice.speak(FLASH_LINES[Math.floor(Math.random() * FLASH_LINES.length)]!);
      return;
    }
    if (flashCmd === "off") {
      setFlash(false);
      if (preFlashIdx.current != null) { setModelIdx(preFlashIdx.current); preFlashIdx.current = null; }
      setMood("happy");
      voice.speak("Whatever. Clothes back on.");
      return;
    }
    await chat.send(text, meta);
  }, [chat, voice, modelsCatalog, modelIdx]);
  sendRef.current = handleUserText;

  useEffect(() => {
    if (voice.listening) setMood("listening");
    else if (chat.busy) setMood("thinking");
    else if (voice.speaking) setMood("speaking");
  }, [voice.listening, voice.speaking, chat.busy]);

  useEffect(() => {
    if (!voice.speaking && !voice.listening && !chat.busy) setMood((m) => ["speaking", "listening", "thinking"].includes(m) ? "idle" : m);
  }, [voice.speaking, voice.listening, chat.busy]);

  useEffect(() => {
    void fetch("/models/catalog.json").then((r) => r.json()).then((list: ModelOpt[]) => {
      if (Array.isArray(list) && list.length) setModelsCatalog(list);
    }).catch(() => setModelsCatalog([{ id: "default", name: "Companion", file: "/models/companion.vrm" }]));
  }, []);

  const refreshConnection = useCallback(async () => {
    try {
      const status = await checkConnection();
      setConnectionMessage(status.message); setModels(status.models);
      setConnection(!status.hasApiKey ? "nokey" : status.connected ? "online" : "error");
    } catch (err) { setConnection("offline"); setConnectionMessage(err instanceof Error ? err.message : String(err)); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await getSettings(); if (cancelled) return;
        setSettings(s); if (!s.hasApiKey) setSettingsOpen(true);
        await getCurrentWindow().setAlwaysOnTop(s.alwaysOnTop); await refreshConnection();
      } catch (err) { if (!cancelled) { setConnection("error"); setConnectionMessage(err instanceof Error ? err.message : String(err)); } }
    })();
    const id = window.setInterval(() => void refreshConnection(), 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [refreshConnection]);

  const name = settings?.companionName || "Nova";
  const title = useMemo(() => `${name} — Grok Companion`, [name]);
  const toggleCompact = async () => {
    const next = !compact; setCompact(next); setChatOpen(!next);
    try { const { LogicalSize } = await import("@tauri-apps/api/dpi"); const win = getCurrentWindow(); await win.setSize(new LogicalSize(next ? 440 : 480, next ? 640 : 820)); await win.setAlwaysOnTop(next || !!settings?.alwaysOnTop); } catch { /* browser preview */ }
  };
  const sendTyped = () => { const text = input.trim(); if (!text) return; setInput(""); void handleUserText(text); };
  const wakeHint = voice.listening ? voice.interim || "Listening…" : voice.wakeArmed ? voice.interim || "Say hey…" : voice.speaking ? "Speaking…" : null;

  return <div className={`shell ${compact ? "is-compact" : ""}`}>
    <div className="stars" />
    <header className="titlebar" data-tauri-drag-region><span className="brand">{title}</span><div className="win-actions">
      <button type="button" onClick={() => setModelIdx((i) => (i + 1) % Math.max(modelsCatalog.length, 1))} title="Change character">◈</button>
      <button type="button" onClick={() => void toggleCompact()} title="Toggle companion view">{compact ? "▣" : "▬"}</button>
      <button type="button" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
      <button type="button" onClick={() => void getCurrentWindow().minimize()} title="Minimize">–</button>
      <button type="button" onClick={() => void getCurrentWindow().close()} title="Close">×</button>
    </div></header>
    <div className="companion-click-target" onClick={() => compact && setChatOpen(true)} title="Open companion chat">
      <Companion mood={mood} name={name} compact={compact} modelUrl={modelsCatalog[modelIdx]?.file} flash={flash} roamEnabled />
    </div>
    {!compact && <StatusBar connection={connection} connectionMessage={connectionMessage} mood={mood} listening={voice.listening} speaking={voice.speaking} busy={chat.busy} wakeArmed={voice.wakeArmed} interim={voice.interim} />}
    {(!compact || chatOpen) && <div className={compact ? "compact-chat" : "full-chat"}>
      {compact && <button type="button" className="chat-close" onClick={() => setChatOpen(false)}>×</button>}
      <ChatPanel messages={chat.messages} busy={chat.busy} listening={voice.listening} interim={voice.interim || (voice.wakeArmed ? "Say hey…" : "")} input={input} onInput={setInput} onSend={sendTyped} onMic={() => voice.listening ? voice.stopListen() : (voice.stopSpeak(), voice.startListen())} onStopSpeak={() => { voice.stopSpeak(); setMood("idle"); }} speaking={voice.speaking} sttAvailable={voice.sttAvailable} companionName={name} />
    </div>}
    {compact && !chatOpen && <div className="compact-mic"><span className="wake-hint">{wakeHint}</span><button type="button" className={voice.listening ? "hot" : voice.wakeArmed ? "armed" : ""} onClick={() => voice.listening ? voice.stopListen() : voice.startListen()}>{voice.listening ? "Listening…" : voice.wakeArmed ? "Say hey…" : "Tap to talk"}</button></div>}
    {voice.error && <p className="banner">{voice.error}</p>}{chat.error && <p className="banner">{chat.error}</p>}
    {settingsOpen && settings && <SettingsPanel settings={settings} models={models} onClose={() => setSettingsOpen(false)} onSaved={(s) => { setSettings(s); void refreshConnection(); }} />}
  </div>;
}

function isFlashCommand(text: string): "on" | "off" | null {
  const t = text.trim().toLowerCase().replace(/^hey\b[\s,]*/i, "");
  if (/\b(flash|undress|strip|topless|get\s*naked|take\s*(it|them|your\s*)?(clothes|top|shirt)?\s*off|tits?\s*out|boobs?\s*out|show\s*(me\s*)?(your\s*)?(tits|boobs|breasts|body|chest))\b/.test(t) || t === "flash" || t === "strip") return "on";
  if (/\b(cover\s*up|put\s*(it|them|clothes)\s*on|unflash|dress(\s*up)?)\b/.test(t)) return "off";
  return null;
}
function plainForSpeech(text: string) { return text.replace(/[`*_#]/g, "").replace(/\n+/g, " ").trim(); }
