# Grok Companion

Windows **desktop companion** (Tauri 2 + Vite + React + TypeScript + Rust) that chats with **xAI Grok**. The API key is stored in the app’s local settings store — never baked into the frontend bundle.

Package: `grok-desktop-companion` · Identifier: `com.grok.desktopcompanion`

## Features (high level)

- Frameless desktop pet with 3D VRM models and Mixamo animations
- Chat with streaming Grok replies via a Rust backend
- Mic / speech-to-text and text-to-speech (OS Web Speech)
- Settings for model, system prompt, **personality**, companion name, always-on-top, and **voice** prefs
- Optional local memory commands (remember / list / forget)

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
