import { FormEvent, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isEnabled as autostartIsEnabled } from "@tauri-apps/plugin-autostart";
import type { MemoryFact, PublicSettings } from "../../types";
import { clearApiKey, saveApiKey, saveSettings } from "./settingsApi";
import { deleteMemory, listMemories } from "../memory/memoryApi";
import { normalizeRoamAmount } from "../pet/behaviour";
import "./SettingsPanel.css";

const ROAM_AMOUNTS = [
  { id: "off", label: "Off — stays put" },
  { id: "calm", label: "Calm — the odd short stroll (default)" },
  { id: "lively", label: "Lively — strolls more often" },
];

const VOICES = [
  { id: "en-HK-YanNeural", label: "Yan (HK English) — default" },
  { id: "en-SG-LunaNeural", label: "Luna (SG English)" },
  { id: "en-US-AvaNeural", label: "Ava (US English)" },
  { id: "en-US-AriaNeural", label: "Aria (US English)" },
];

const PERSONALITIES = [
  { id: "chill", label: "Chill 18, flirty (English)" },
  { id: "firstdate", label: "First date" },
  { id: "cosmic", label: "Cosmic companion" },
  { id: "witty", label: "Witty" },
  { id: "calm", label: "Calm" },
  { id: "coach", label: "Coach" },
  { id: "scientist", label: "Space scientist" },
];

interface Props {
  settings: PublicSettings;
  models: string[];
  onClose: () => void;
  onSaved: (s: PublicSettings) => void;
  /** Wipes the on-screen / stored conversation (memories are separate). */
  onClearChat: () => void;
  chatCount: number;
  /** Credit line for the selected character (shown when its licence requires one). */
  credit?: string | null;
  /** Live size preview while dragging the slider. */
  onScalePreview?: (scale: number) => void;
}

export function SettingsPanel({ settings, models, onClose, onSaved, onClearChat, chatCount, credit, onScalePreview }: Props) {
  const [petScale, setPetScale] = useState(settings.petScale || 1);
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState(settings.companionName);
  const [model, setModel] = useState(settings.model);
  const [personality, setPersonality] = useState(settings.personality);
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [alwaysOnTop, setAlwaysOnTop] = useState(settings.alwaysOnTop);
  const [autoSpeak, setAutoSpeak] = useState(settings.autoSpeak);
  const [ttsEnabled, setTtsEnabled] = useState(settings.ttsEnabled);
  const [temperature, setTemperature] = useState(settings.temperature);
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens);
  const [brainProvider, setBrainProvider] = useState(settings.brainProvider || "grok-cli");
  const [voiceTarget, setVoiceTarget] = useState(settings.voiceTarget || "en-HK-YanNeural");
  const [autostart, setAutostart] = useState(settings.autostart);
  const [roamAmount, setRoamAmount] = useState(normalizeRoamAmount(settings.roamAmount));
  const [wakeWordEnabled, setWakeWordEnabled] = useState(settings.wakeWordEnabled);
  const [playful, setPlayful] = useState(!!settings.playful);
  const [autostartOs, setAutostartOs] = useState<boolean | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [facts, setFacts] = useState<MemoryFact[]>([]);

  useEffect(() => {
    listMemories().then(setFacts).catch(() => setFacts([]));
    autostartIsEnabled().then(setAutostartOs).catch(() => setAutostartOs(null));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      let next = await saveSettings({
        model,
        systemPrompt,
        personality,
        companionName: name.trim() || "Nova",
        alwaysOnTop,
        autoSpeak,
        ttsEnabled,
        temperature,
        maxTokens,
        brainProvider,
        voiceTarget: voiceTarget || "en-HK-YanNeural",
        characterModel: settings.characterModel || "",
        autostart,
        // Picking a (new) amount un-pauses tray "Pause roaming"; otherwise keep it.
        roamEnabled:
          roamAmount !== "off" && roamAmount !== normalizeRoamAmount(settings.roamAmount) ? true : settings.roamEnabled,
        roamAmount,
        wakeWordEnabled,
        playful,
        petScale,
      });
      autostartIsEnabled().then(setAutostartOs).catch(() => undefined);
      if (apiKey.trim()) {
        next = await saveApiKey(apiKey.trim());
        setApiKey("");
      }
      onSaved(next);
      setStatus("Saved.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onClearKey = async () => {
    setBusy(true);
    try {
      const next = await clearApiKey();
      onSaved(next);
      setStatus("API key cleared from app data.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const uniqueModels = Array.from(
    new Set([...models, settings.model, "grok-4.7", "grok-4.6", "grok-4.5"].filter((m) => m && m !== "default")),
  );

  return (
    <div className="settings-backdrop" role="dialog" aria-label="Settings">
      <form className="settings-card" onSubmit={save}>
        <header>
          <h2>Settings</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
            ✕
          </button>
        </header>

        <label>
          Size — {Math.round(petScale * 100)}%
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={petScale}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setPetScale(v);
              onScalePreview?.(v);
            }}
          />
          <span className="fine">Tip: scroll the mouse wheel over her to resize, drag her to move her.</span>
        </label>
        {credit && <p className="fine credit">Character: {credit}</p>}

        <label>
          Companion name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
        </label>

        <label>
          Personality
          <select value={personality} onChange={(e) => setPersonality(e.target.value)}>
            {PERSONALITIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>


        <label>
          Brain
          <select value={brainProvider} onChange={(e) => setBrainProvider(e.target.value)}>
            <option value="grok-cli">Grok CLI (signed-in account)</option>
            <option value="xai-api">xAI API key</option>
            <option value="auto">Auto</option>
          </select>
        </label>
        <p className="fine">
          Grok CLI uses your local <code>grok</code> install (OAuth). Use this while the API team has no credits.
        </p>

        <label>
          Model
          <select value={model === "default" ? "" : model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Default ({brainProvider === "xai-api" ? "API default" : "CLI's own default"})</option>
            {uniqueModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label>
          xAI API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings.hasApiKey ? `Saved ${settings.apiKeyHint ?? "••••"}` : "xai-… (never stored in source)"}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="fine">
          Key is saved in this app's data folder via Tauri Store — never shipped to the frontend after save.{" "}
          <button
            type="button"
            className="link"
            onClick={() => openUrl("https://console.x.ai/")}
          >
            Open xAI console
          </button>
        </p>
        {settings.hasApiKey && (
          <button type="button" className="link danger" onClick={onClearKey}>
            Clear saved key
          </button>
        )}

        <label>
          Voice (Edge neural)
          <select value={voiceTarget} onChange={(e) => setVoiceTarget(e.target.value)}>
            {[...VOICES, ...(VOICES.some((v) => v.id === voiceTarget) ? [] : [{ id: voiceTarget, label: voiceTarget }])].map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          System prompt
          <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={4} />
        </label>

        <div className="row">
          <label className="check">
            <input type="checkbox" checked={alwaysOnTop} onChange={(e) => setAlwaysOnTop(e.target.checked)} />
            Always on top
          </label>
          <label className="check">
            <input type="checkbox" checked={ttsEnabled} onChange={(e) => setTtsEnabled(e.target.checked)} />
            Enable TTS
          </label>
          <label className="check">
            <input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} />
            Auto-speak replies
          </label>
          <label className="check">
            <input type="checkbox" checked={wakeWordEnabled} onChange={(e) => setWakeWordEnabled(e.target.checked)} />
            “Hey” wake word
          </label>
          <label className="check">
            <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
            Launch with Windows
          </label>
          <label className="check" title="Lets her walk over to desktop icons and jump on them (icon detection comes later)">
            <input type="checkbox" checked={playful} onChange={(e) => setPlayful(e.target.checked)} />
            Playful (jump on icons)
          </label>
        </div>
        <label>
          Roam amount
          <select value={roamAmount} onChange={(e) => setRoamAmount(normalizeRoamAmount(e.target.value))}>
            {ROAM_AMOUNTS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {!settings.roamEnabled && roamAmount !== "off" && (
          <p className="fine">Roaming is paused from the tray menu (choosing a different amount here un-pauses it).</p>
        )}
        {autostartOs !== null && autostartOs !== autostart && (
          <p className="fine">
            Launch-at-login is currently {autostartOs ? "on" : "off"} in Windows; Save to apply (dev builds never register).
          </p>
        )}

        <label>
          Temperature {temperature.toFixed(2)}
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
          />
        </label>
        <label>
          Max tokens
          <input
            type="number"
            min={64}
            max={8192}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value))}
          />
        </label>

        <section className="memories">
          <h3>Local memories</h3>
          {facts.length === 0 && <p className="fine">None yet. Ask Nova to remember something.</p>}
          <ul>
            {facts.map((f) => (
              <li key={f.id}>
                <span>{f.fact}</span>
                <button
                  type="button"
                  className="link danger"
                  onClick={async () => setFacts(await deleteMemory(f.id))}
                >
                  delete
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="memories">
          <h3>Chat history</h3>
          <p className="fine">
            {chatCount} message{chatCount === 1 ? "" : "s"} on screen. Clearing doesn't touch memories above.
          </p>
          <button
            type="button"
            className="link danger"
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                window.setTimeout(() => setConfirmClear(false), 4000);
                return;
              }
              setConfirmClear(false);
              onClearChat();
              setStatus("Chat history cleared.");
            }}
          >
            {confirmClear ? "Tap again to clear chat history" : "Clear chat history"}
          </button>
        </section>

        {status && <p className="status-msg">{status}</p>}

        <footer>
          <button type="button" onClick={onClose} className="ghost">
            Close
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}
