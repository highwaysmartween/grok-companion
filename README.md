# Grok Companion

Windows **desktop companion** (Tauri 2 + Vite + React + TypeScript + Rust) that chats with **xAI Grok**. The API key is stored in the app’s local settings store — never baked into the frontend bundle.

Package: `grok-desktop-companion` · Identifier: `com.grok.desktopcompanion`

## Features (high level)

- Frameless desktop pet with 3D VRM models and Mixamo animations
- Chat with streaming Grok replies via a Rust backend
- Mic / speech-to-text and text-to-speech (OS Web Speech)
- Settings for model, system prompt, **personality**, companion name, always-on-top, and **voice** prefs
- Optional local memory commands (remember / list / forget)

## v1.1.1 — "companion life"

- Desktop pet shell: always on top, no taskbar button, **tray icon** (Show/Hide, Pause roaming, Settings, Quit), **launches with Windows** (toggle in Settings; release builds only).
- She walks along the bottom of the work area (on the taskbar), faces where she walks, stops when you hover, looks at your cursor, breathes, reacts, and falls asleep after ~2 min of inactivity.
- Voice: async TTS/STT (no UI freezes), real stop/barge-in, utterance queue, tighter "hey" / "hey &lt;name&gt;" wake word with back-off, offline fallback when WebView speech fails.
- Brain: Grok CLI gets the persona via `--system-prompt-override` and the chat via `--prompt-file` (auto-falls back to the old `-p` flags if your CLI rejects them); history trimmed to the last 20 messages.
- Lightweight rendering: 30 fps cap, pixel ratio ≤ 1.25, low-power GPU, paused when hidden/minimized.
- Optional clips: drop `Happy_Idle`, `Looking_Around`, `Waving`, `Talking_2`, `Thinking`, `Sitting`, `Sleeping` (Mixamo FBX) into `public/animations/` and they're used automatically; otherwise procedural motion fills in.

## Run from source

Prerequisites: Node.js 20+, Rust (stable), WebView2, MSVC C++ Build Tools. See [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev
```

Production build:

```bash
npm run tauri build
```

On first launch, open **Settings** and paste your xAI API key (from [console.x.ai](https://console.x.ai/)). Optional empty template: `.env.example` (`XAI_API_KEY=`) — do not commit a real key.

## Models & animations

VRM / GLB companions and FBX animations live under `public/models/` and `public/animations/`. A small `catalog.json` lists available models.

## Releases

Prebuilt Windows binaries are on the [Releases](https://github.com/highwaysmartween/grok-companion/releases) page (e.g. tag `v1.0.0`). Use those if you only want to run the app, not build it.

## Repo hygiene

Ignored by git: `node_modules/`, `dist/`, `src-tauri/target/`, `src-tauri/gen/`, `.env`, logs.
