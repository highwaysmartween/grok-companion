import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
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
import { latencyMark } from "./modules/chat/latency";
import { playChime } from "./modules/voice/speech";
import type { FlashMode } from "./modules/pet/flash";
import { fmtClock, type Alarm } from "./modules/tools/intents";
import type { ConnectionKind, PetMood, PublicSettings } from "./types";
import "./App.css";

type ModelOpt = {
  id: string;
  name: string;
  file: string;
  /** Licence credit line shown in Settings when this model is selected. */
  credit?: string;
  /** Preferred model for "flash" when the current one can't. */
  flashTarget?: boolean;
};

/** Compact pet window at 100% (logical px). */
const PET_W = 440;
const PET_H = 640;
const CHAT_W = 340;
const CHAT_MIN_H = 470;
const SETTINGS_MIN_W = 440;
const SETTINGS_MIN_H = 620;
const clampScale = (v: number) => Math.min(2, Math.max(0.5, Math.round(v * 100) / 100));

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
  const flashModes = useRef<Record<string, FlashMode>>({});
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  scaleRef.current = scale;
  const [chatSide, setChatSide] = useState<"left" | "right">("right");
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; started: boolean } | null>(null);
  const suppressClick = useRef(false);
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
    onWake: () => {
      latencyMark("wake");
      fireCue("wave");
    },
    onAudioStart: () => latencyMark("audio-start"),
    onFinalTranscript: (text) => {
      setInput("");
      touchMood(classifyUserMood(text));
      void sendRef.current(text, { fromVoice: true });
    },
  });
  const chat = useChat({
    settings,
    setMood: touchMood,
    speakReply: (text, mode) => voice.speak(plainForSpeech(text), mode),
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
      // Stay on the current model if it can flash; otherwise switch to the
      // nude base (bundled in the personal build) or, failing that, r18.
      const cur = modelsCatalog[modelIdx];
      const curMode = cur ? flashModes.current[cur.file] : undefined;
      if (!cur || !curMode || curMode === "none") {
        const isR18 = (m: ModelOpt) => /r18|companion\.vrm$|companion_05/i.test(`${m.id} ${m.file}`);
        let idx = modelsCatalog.findIndex((m) => m.flashTarget);
        if (idx < 0) idx = modelsCatalog.findIndex(isR18);
        if (idx >= 0 && idx !== modelIdx) {
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
    const pub = fetch("/models/catalog.json").then((r) => r.json()).catch(() => [{ id: "default", name: "Companion", file: "/models/companion.vrm" }]);
    // Personal builds only: models that may not be redistributed live in the
    // git-ignored public/models-private/ (with its own catalog.json).
    const priv = fetch("/models-private/catalog.json")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    void Promise.all([pub, priv]).then(([a, b]: [ModelOpt[], ModelOpt[]]) => {
      const list = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
      if (list.length) setModelsCatalog(list);
    });
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

  // --- window layout: size (scale) + chat panel beside her -----------------
  const layoutRef = useRef<{ side: "left" | "right" | null; scale: number; settings: boolean }>({ side: null, scale: 1, settings: false });
  const applyLayout = useCallback(async (nextScale: number, chat: boolean, settingsOn: boolean) => {
    try {
      const win = getCurrentWindow();
      const sf = await win.scaleFactor();
      const monitor = (await currentMonitor()) ?? (await primaryMonitor());
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      const prev = layoutRef.current;
      // Where her body currently is (left edge, physical px).
      const petLeft = pos.x + (prev.side === "left" ? Math.round(CHAT_W * sf) : 0);
      const bottom = pos.y + size.height;
      const petW = Math.round(PET_W * nextScale * sf);
      const petH = Math.round(PET_H * nextScale * sf);
      let side: "left" | "right" | null = null;
      let w = petW;
      let h = petH;
      if (chat) {
        const room = monitor ? monitor.workArea.position.x + monitor.workArea.size.width - (petLeft + petW) : 1e9;
        side = room >= CHAT_W * sf ? "right" : "left";
        w = petW + Math.round(CHAT_W * sf);
        h = Math.max(petH, Math.round(CHAT_MIN_H * sf));
      }
      if (settingsOn) {
        w = Math.max(w, Math.round(SETTINGS_MIN_W * sf));
        h = Math.max(h, Math.round(SETTINGS_MIN_H * sf));
      }
      let x = side === "left" ? petLeft - Math.round(CHAT_W * sf) : petLeft;
      let y = bottom - h;
      if (monitor) {
        const wa = monitor.workArea;
        x = Math.min(Math.max(x, wa.position.x), wa.position.x + wa.size.width - w);
        y = Math.min(Math.max(y, wa.position.y), wa.position.y + wa.size.height - h);
      }
      layoutRef.current = { side, scale: nextScale, settings: settingsOn };
      setChatSide(side ?? "right");
      await invoke("pet_set_bounds", { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
    } catch {
      // browser preview
    }
  }, []);

  // Size from settings (and tray Small / Medium / Large).
  useEffect(() => {
    if (settings?.petScale) setScale(clampScale(settings.petScale));
  }, [settings?.petScale]);
  useEffect(() => {
    if (!compact) return;
    void applyLayout(scale, chatOpen, settingsOpen);
  }, [scale, chatOpen, settingsOpen, compact, applyLayout]);

  const persistScaleTimer = useRef(0);
  const changeScale = useCallback((next: number, save = true) => {
    const v = clampScale(next);
    setScale(v);
    if (!save) return;
    window.clearTimeout(persistScaleTimer.current);
    persistScaleTimer.current = window.setTimeout(() => void persist({ petScale: v }), 600);
  }, [persist]);

  // Esc closes chat / settings; leaving the window closes the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (settingsOpen) setSettingsOpen(false);
      else if (chatOpen && compact) setChatOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, chatOpen, compact]);
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused && compact && !dragRef.current) setChatOpen(false);
      })
      .then((fn) => (disposed ? fn() : (off = fn)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, [compact]);

  // Drag her anywhere: OS drag on mouse-down + move; a click without movement is a tap.
  const lastRect = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    let settle = 0;
    void getCurrentWindow()
      .onMoved(({ payload }) => {
        if (!dragRef.current?.started) return;
        // OS drags move the window too — repaint what she uncovers on the way.
        const prev = lastRect.current;
        if (prev) void invoke("pet_repaint_behind", { x: prev.x, y: prev.y, width: prev.w, height: prev.h }).catch(() => undefined);
        void getCurrentWindow().outerSize().then((sz) => {
          lastRect.current = { x: payload.x, y: payload.y, w: sz.width, h: sz.height };
        });
        window.clearTimeout(settle);
        settle = window.setTimeout(() => {
          dragRef.current = null;
          setDragging(false);
          void invoke("pet_save_position", { x: payload.x, y: payload.y }).catch(() => undefined);
        }, 450);
      })
      .then((fn) => (disposed ? fn() : (off = fn)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      window.clearTimeout(settle);
      off?.();
    };
  }, []);

  const onPetMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.screenX, y: e.screenY, started: false };
    suppressClick.current = false;
  };
  const onPetMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d || d.started || (e.buttons & 1) === 0) return;
    if (Math.hypot(e.screenX - d.x, e.screenY - d.y) < 5) return;
    d.started = true;
    suppressClick.current = true;
    setDragging(true);
    void (async () => {
      try {
        const win = getCurrentWindow();
        const [p, sz] = await Promise.all([win.outerPosition(), win.outerSize()]);
        lastRect.current = { x: p.x, y: p.y, w: sz.width, h: sz.height };
        await win.startDragging();
      } catch {
        dragRef.current = null;
        setDragging(false);
      }
    })();
  };
  const onPetMouseUp = () => {
    if (dragRef.current && !dragRef.current.started) dragRef.current = null;
  };
  const onPetWheel = (e: React.WheelEvent) => {
    if (!compact) return;
    changeScale(scaleRef.current * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
  };

  // Alarms / timers / reminders firing (Rust shows her + a Windows notification).
  const alarmDeps = useRef({ chat, voice, fireCue, touchMood });
  alarmDeps.current = { chat, voice, fireCue, touchMood };
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void listen<Alarm>("alarm-due", (e) => {
      const a = e.payload;
      const line =
        a.kind === "timer"
          ? `Frank, your timer's done${a.label ? ` — ${a.label}` : ""}.`
          : a.kind === "reminder"
            ? `Hey Frank, reminder: ${a.label || "you asked me to remind you now"}.`
            : `Frank, it's ${fmtClock(a.dueMs).replace(/ today$/, "")}. Your alarm${a.label && a.label !== "wake up" ? ` for ${a.label}` : ""}. Time to get up.`;
      const { chat, voice, fireCue, touchMood } = alarmDeps.current;
      playChime(a.kind === "alarm" ? 3 : 2);
      fireCue("wave");
      touchMood("happy");
      chat.announce(line);
      window.setTimeout(() => voice.speak(line, "queue"), a.kind === "alarm" ? 3200 : 2100);
    })
      .then((fn) => (disposed ? fn() : (off = fn)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void listen<number>("tray-scale", (e) => {
      setSettings((s) => (s ? { ...s, petScale: e.payload } : s));
      setScale(clampScale(e.payload));
    })
      .then((fn) => (disposed ? fn() : (off = fn)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const title = useMemo(() => `${name} — Grok Companion`, [name]);
  const toggleCompact = async () => {
    const next = !compact; setCompact(next); setChatOpen(!next);
    try {
      const { LogicalSize } = await import("@tauri-apps/api/dpi");
      const win = getCurrentWindow();
      if (!next) await win.setSize(new LogicalSize(480, 820));
      else layoutRef.current = { side: null, scale: scaleRef.current, settings: false };
      await win.setAlwaysOnTop(next || !!settings?.alwaysOnTop);
      if (next) void snapToFloor();
    } catch {
      // preview/browser fallback
    }
  };
  const sendTyped = () => { const text = input.trim(); if (!text) return; setInput(""); void handleUserText(text); };
  const wakeHint = voice.listening ? voice.interim || "Listening…" : voice.wakeArmed ? "Say “hey”…" : voice.speaking ? "Speaking…" : voice.wakeStatus ? "“hey” isn't working — tap to talk" : null;
  // Tray "Pause roaming" clears roamEnabled; the amount itself is kept.
  const roamAmount = settings && settings.roamEnabled !== false ? normalizeRoamAmount(settings.roamAmount) : "off";
  const roamPaused = !compact || chatOpen || settingsOpen || hovered || dragging;
  const micActive = voice.listening || voice.speaking;

  const petStyle: React.CSSProperties | undefined =
    compact && chatOpen ? { position: "absolute", bottom: 0, [chatSide === "right" ? "left" : "right"]: 0, width: Math.round(PET_W * scale) } : undefined;
  const credit = modelsCatalog[modelIdx]?.credit ?? null;

  return <div
    className={`shell ${compact ? "is-compact" : ""} ${compact && chatOpen ? `chat-open chat-${chatSide}` : ""}`}
    onMouseDown={(e) => {
      // Click on empty (transparent) space closes the chat.
      if (compact && chatOpen && e.target === e.currentTarget) setChatOpen(false);
    }}
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
      <button type="button" onClick={() => void invoke("pet_hide").catch(() => getCurrentWindow().hide())} title="Hide to tray (Quit from the tray icon)">×</button>
    </div></header>
    <div
      className="companion-click-target"
      style={petStyle}
      onMouseDown={onPetMouseDown}
      onMouseMove={onPetMouseMove}
      onMouseUp={onPetMouseUp}
      onWheel={onPetWheel}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        setReactKey((k) => k + 1);
        bumpActivity();
        if (compact) setChatOpen((o) => !o);
      }}
      title="Tap to chat · drag to move · scroll to resize"
    >
      <Companion mood={mood} name={name} compact={compact} modelUrl={modelsCatalog[modelIdx]?.file} flash={flash} flashKey={flashKey} roamAmount={roamAmount} roamPaused={roamPaused} reactKey={reactKey} cue={cue} playful={!!settings?.playful} scale={scale} onFlashMode={(url, m) => { flashModes.current[url] = m; }} />
    </div>
    {!compact && <StatusBar connection={connection} connectionMessage={connectionMessage} mood={mood} listening={voice.listening} speaking={voice.speaking} busy={chat.busy} wakeArmed={voice.wakeArmed} interim={voice.interim} />}
    {(!compact || chatOpen) && <div className={compact ? "compact-chat" : "full-chat"}>
      {compact && <button type="button" className="chat-close" onClick={() => setChatOpen(false)} aria-label="Close chat" title="Close chat (Esc)">✕</button>}
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
      credit={credit}
      onScalePreview={(v) => changeScale(v, false)}
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
