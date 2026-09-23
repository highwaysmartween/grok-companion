import { FormEvent, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MemoryFact, PublicSettings } from "../../types";
import { clearApiKey, saveApiKey, saveSettings } from "./settingsApi";
import { deleteMemory, listMemories } from "../memory/memoryApi";
import "./SettingsPanel.css";

const PERSONALITIES = [
  { id: "chill", label: "Chill 18 (English)" },
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
}

export function SettingsPanel({ settings, models, onClose, onSaved }: Props) {
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
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [facts, setFacts] = useState<MemoryFact[]>([]);

  useEffect(() => {
    listMemories().then(setFacts).catch(() => setFacts([]));
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
        voiceTarget: settings.voiceTarget || 'en-HK-YanNeural',
        characterModel: settings.characterModel || '',
      });
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

  const uniqueModels = Array.from(new Set([...models, settings.model, "grok-4.6", "grok-4.5", "grok-4.3"]));

  return (
    <div className="settings-backdrop" role="dialog" aria-label="Settings">
      <form className="settings-card" onSubmit={save}>
        <header>
          <h2>Settings</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

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
          <select value={model} onChange={(e) => setModel(e.target.value)}>
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
        </div>

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
