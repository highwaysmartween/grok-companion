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

type ModelOpt = { id: string; name: string; file: string };
import "./App.css";

const FLASH_LINES = [
  "Okay… fine. Eyes up here though.",
  "You're shameless. Whatever — look.",
  "Hmm. Just this once.",
];

export default function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mood, setMood] = useState<PetMood>("idle");
  const [input, setInput] = useState("");
  const [connection, setConnection] = useState<ConnectionKind>("unknown");
  const [connectionMessage, setConnectionMessage] = useState("Starting…");
  const [models, setModels] = useState<string[]>([]);
  const [compact, setCompact] = useState(true);
  const [modelsCatalog, setModelsCatalog] = useState<ModelOpt[]>([
    { id: "norykko", name: "Norykko Tsuruya (Bikini)", file: "/models/companion_03.vrm" },
    { id: "nyoko", name: "NyokoNoUta (Bikini)", file: "/models/companion_04.vrm" },
    { id: "christina", name: "Christina (Bikini)", file: "/models/companion_02.vrm" },
    { id: "r18", name: "r18 (lingerie)", file: "/models/companion.vrm" },
    { id: "r18b", name: "r18 alt", file: "/models/companion_05.vrm" },
    { id: "catgirl", name: "Catgirl", file: "/models/catgirl.vrm" },
  ]);
  const [modelIdx, setModelIdx] = useState(0);
  const [flash, setFlash] = useState(false);
  const preFlashIdx = useRef<number | null>(null);

  const sendRef = useRef<(text: string, meta?: { fromVoice?: boolean }) => Promise<void>>(
    async () => undefined,
  );

  const voice = useVoice({
    wakeWordEnabled: true,
    wakeWord: "hey",
    onFinalTranscript: (text) => {
      setInput("");
      void sendRef.current(text, { fromVoice: true });
    },
  });

  const chat = useChat({
    settings,
    setMood,
    speakReply: (text) => voice.speak(plainForSpeech(text)),
  });

  const handleUserText = useCallback(
    async (text: string, meta?: { fromVoice?: boolean }) => {
      const flashCmd = isFlashCommand(text);
      if (flashCmd === "on") {
        // Bikini skins often bake cloth into body — switch to lingerie/r18 which has CLOTH layers.
        const prefer = (m: ModelOpt) =>
          /r18|companion\.vrm$|companion_05/i.test(`${m.id} ${m.file}`);
        const cur = modelsCatalog[modelIdx];
        if (!cur || !prefer(cur)) {
          const idx = modelsCatalog.findIndex(prefer);
          if (idx >= 0) {
            preFlashIdx.current = modelIdx;
            setModelIdx(idx);
          }
        }
        setFlash(true);
        setMood("happy");
        // Flash ALWAYS speaks — never silent statue
        const line = FLASH_LINES[Math.floor(Math.random() * FLASH_LINES.length)]!;
        voice.speak(line);
        return;
      }
      if (flashCmd === "off") {
        setFlash(false);
        if (preFlashIdx.current != null) {
          setModelIdx(preFlashIdx.current);
          preFlashIdx.current = null;
        }
        setMood("happy");
        voice.speak("Whatever. Clothes back on.");
        return;
      }
      await chat.send(text, meta);
    },
    [chat, voice, modelsCatalog, modelIdx],
  );
  sendRef.current = handleUserText;

  useEffect(() => {
    if (voice.listening) setMood("listening");
    else if (chat.busy) setMood((m) => (m === "listening" ? "thinking" : m));
    else if (voice.speaking) setMood("speaking");
  }, [voice.listening, voice.speaking, chat.busy]);

  useEffect(() => {
    if (!voice.speaking && !voice.listening && !chat.busy) {
      setMood((m) => (m === "speaking" || m === "listening" ? "idle" : m));
    }
  }, [voice.speaking, voice.listening, chat.busy]);

  useEffect(() => {
    void fetch("/models/catalog.json")
      .then((r) => r.json())
      .then((list: ModelOpt[]) => {
        if (Array.isArray(list) && list.length) {
          setModelsCatalog(list);
          const i = list.findIndex((m) => m.id === "norykko");
          if (i >= 0) setModelIdx(i);
          else setModelIdx(0);
        }
      })
      .catch(() => undefined);
  }, []);

  // Pet-only desktop mode: small transparent window on launch
  useEffect(() => {
    if (!compact) return;
    void (async () => {
      try {
        const { LogicalSize } = await import("@tauri-apps/api/dpi");
        const win = getCurrentWindow();
        await win.setSize(new LogicalSize(440, 640));
        await win.setAlwaysOnTop(true);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const refreshConnection = useCallback(async () => {
    try {
      const status = await checkConnection();
      setConnectionMessage(status.message);
      setModels(status.models);
      if (!status.hasApiKey) setConnection("nokey");
      else if (status.connected) setConnection("online");
      else setConnection("error");
    } catch (err) {
      setConnection("offline");
      setConnectionMessage(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getSettings();
        if (cancelled) return;
        setSettings(s);
        if (!s.hasApiKey) setSettingsOpen(true);
        await getCurrentWindow().setAlwaysOnTop(s.alwaysOnTop);
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

  const onSaved = async (s: PublicSettings) => {
    setSettings(s);
    await getCurrentWindow().setAlwaysOnTop(s.alwaysOnTop);
    await refreshConnection();
  };

  const name = settings?.companionName || "Nova";
  const title = useMemo(() => `${name} — Grok Companion`, [name]);

  const toggleCompact = async () => {
    const next = !compact;
    setCompact(next);
    const win = getCurrentWindow();
    try {
      const { LogicalSize } = await import("@tauri-apps/api/dpi");
      if (next) {
        await win.setSize(new LogicalSize(440, 640));
        await win.setAlwaysOnTop(true);
      } else {
        await win.setSize(new LogicalSize(480, 820));
        if (settings && !settings.alwaysOnTop) await win.setAlwaysOnTop(false);
      }
    } catch {
      /* ignore resize failures in browser preview */
    }
  };

  const sendTyped = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    handleUserText(text, { fromVoice: false });
  };

  const wakeHint =
    voice.listening
      ? voice.interim || "Listening…"
      : voice.wakeArmed
        ? voice.interim || "Say hey…"
        : voice.speaking
          ? "Speaking…"
          : null;

  return (
    <div className={`shell ${compact ? "is-compact" : ""}`}>
      <div className="stars" />
      <header className="titlebar" data-tauri-drag-region>
        <span className="brand" data-tauri-drag-region>
          {title}
        </span>
        <div className="win-actions">
          <button
            type="button"
            onClick={() => setModelIdx((i) => (i + 1) % Math.max(modelsCatalog.length, 1))}
            title={`Model: ${modelsCatalog[modelIdx]?.name ?? "default"}`}
          >
            ♀
          </button>
          <button type="button" onClick={() => void toggleCompact()} title="Toggle compact pet mode (transparent pet)">
            {compact ? "▣" : "▬"}
          </button>
          <button type="button" onClick={() => setSettingsOpen(true)} title="Settings">
            ⚙
          </button>
          <button type="button" onClick={() => void getCurrentWindow().minimize()} title="Minimize">
            –
          </button>
          <button type="button" onClick={() => void getCurrentWindow().close()} title="Close">
            ×
          </button>
        </div>
      </header>

      <Companion
        mood={mood}
        name={name}
        compact={compact}
        modelUrl={modelsCatalog[modelIdx]?.file}
        flash={flash}
        roamEnabled
      />

      {!compact && (
        <StatusBar
          connection={connection}
          connectionMessage={connectionMessage}
          mood={mood}
          listening={voice.listening}
          speaking={voice.speaking}
          busy={chat.busy}
          wakeArmed={voice.wakeArmed}
          interim={voice.interim}
        />
      )}

      {!compact && (
        <ChatPanel
          messages={chat.messages}
          busy={chat.busy}
          listening={voice.listening}
          interim={voice.interim || (voice.wakeArmed ? "Say hey…" : "")}
          input={input}
          onInput={setInput}
          onSend={sendTyped}
          onMic={() => {
            if (voice.listening) voice.stopListen();
            else {
              voice.stopSpeak();
              voice.startListen();
            }
          }}
          onStopSpeak={() => {
            voice.stopSpeak();
            setMood("idle");
          }}
          speaking={voice.speaking}
          sttAvailable={voice.sttAvailable}
          companionName={name}
        />
      )}

      {compact && (
        <div className="compact-mic">
          {wakeHint && <span className="wake-hint">{wakeHint}</span>}
          <button
            type="button"
            className={voice.listening ? "hot" : voice.wakeArmed ? "armed" : ""}
            onClick={() => (voice.listening ? voice.stopListen() : voice.startListen())}
            disabled={!voice.sttAvailable}
          >
            {voice.listening
              ? "Listening… tap to stop"
              : voice.wakeArmed
                ? "Say hey… or tap"
                : "Tap to talk"}
          </button>
        </div>
      )}

      {voice.error && <p className="banner">{voice.error}</p>}
      {chat.error && <p className="banner">{chat.error}</p>}

      {settingsOpen && settings && (
        <SettingsPanel
          settings={settings}
          models={models}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => {
            void onSaved(s);
          }}
        />
      )}
    </div>
  );
}

function isFlashCommand(text: string): "on" | "off" | null {
  const t = text.trim().toLowerCase().replace(/^hey\b[\s,]*/i, "");
  if (
    /\b(flash|undress|strip|topless|get\s*naked|take\s*(it|them|your\s*)?(clothes|top|shirt)?\s*off|tits?\s*out|boobs?\s*out|show\s*(me\s*)?(your\s*)?(tits|boobs|breasts|body|chest))\b/.test(
      t,
    ) ||
    t === "flash" ||
    t === "strip"
  )
    return "on";
  if (/\b(cover\s*up|put\s*(it|them|clothes)\s*on|unflash|dress(\s*up)?)\b/.test(t))
    return "off";
  return null;
}

function plainForSpeech(text: string) {
  return text.replace(/[`*_#]/g, "").replace(/\n+/g, " ").trim();
}
