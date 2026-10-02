import { useRef } from "react";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import type { PetMood } from "../../types";
import { CompanionVRM, PET_VRM_VERSION, type GestureCue } from "./CompanionVRM";
import type { RoamAmount, RoamDriver, Room } from "./behaviour";
import "./Companion.css";

interface Props {
  mood: PetMood;
  name: string;
  compact?: boolean;
  modelUrl?: string;
  flash?: boolean;
  /** Off / Calm / Lively. Off = she never walks (idle / look / turn still run). */
  roamAmount?: RoamAmount;
  /** Temporarily hold still (hovered, chat open, tray pause…). */
  roamPaused?: boolean;
  reactKey?: number;
  /** One-shot gesture requests (wave / kiss / jumps). */
  cue?: GestureCue | null;
  /** Settings → "Playful (jump on icons)". */
  playful?: boolean;
}

/** ~30 Hz window moves — smooth enough, far cheaper than per-rAF IPC. */
const MOVE_INTERVAL_MS = 33;
/** If she was dragged off the floor, glide back down over the first part of a stroll. */
const FLOOR_SETTLE_MS = 700;

/**
 * Host side of a stroll (see behaviour.ts → RoamDriver). The pet computes an
 * eased position every frame; this just glues the transparent window to it,
 * on the bottom of the work area, coalescing to at most one in-flight
 * setPosition every ~33 ms (latest position wins — no queue, no jitter).
 */
function createWindowRoamDriver(): RoamDriver {
  let session = 0;
  let startX = 0;
  let startY = 0;
  let floorY = 0;
  let minX = 0;
  let maxX = 0;
  let scale = 1;
  let beganAt = 0;
  let wantX: number | null = null;
  let lastSentX = Number.NaN;
  let lastSentY = Number.NaN;
  let lastSentAt = 0;
  let inflight = false;
  let timer = 0;
  let active = false;

  const pump = async () => {
    timer = 0;
    if (inflight || wantX == null) return;
    const now = performance.now();
    const wait = MOVE_INTERVAL_MS - (now - lastSentAt);
    if (wait > 0) {
      timer = window.setTimeout(() => void pump(), wait);
      return;
    }
    const x = Math.min(maxX, Math.max(minX, startX + wantX));
    const settle = Math.min(1, (now - beganAt) / FLOOR_SETTLE_MS);
    const y = startY + (floorY - startY) * (settle * settle * (3 - 2 * settle));
    wantX = null;
    // Physical px: sub-logical-pixel steps on scaled displays → smoother glide.
    const px = Math.round(x * scale);
    const py = Math.round(y * scale);
    if (px === lastSentX && py === lastSentY) return;
    inflight = true;
    lastSentAt = now;
    try {
      const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
      await getCurrentWindow().setPosition(new PhysicalPosition(px, py));
      lastSentX = px;
      lastSentY = py;
    } catch {
      active = false;
    } finally {
      inflight = false;
      if (wantX != null && !timer) timer = window.setTimeout(() => void pump(), 0);
    }
  };

  return {
    async begin(): Promise<Room | null> {
      const my = ++session;
      active = false;
      try {
        const win = getCurrentWindow();
        const monitor = (await currentMonitor()) ?? (await primaryMonitor());
        if (!monitor || my !== session) return null;
        scale = monitor.scaleFactor || 1;
        const workX = monitor.workArea.position.x / scale;
        const workY = monitor.workArea.position.y / scale;
        const workW = monitor.workArea.size.width / scale;
        const workH = monitor.workArea.size.height / scale;
        const outer = await win.outerPosition();
        const size = await win.outerSize();
        if (my !== session) return null;
        const winW = size.width / scale;
        const winH = size.height / scale;
        startX = outer.x / scale;
        startY = outer.y / scale;
        const margin = 4;
        minX = workX + margin;
        maxX = workX + workW - winW - margin;
        // Feet on the taskbar: window bottom = work-area bottom.
        floorY = Math.max(workY, workY + workH - winH);
        if (maxX <= minX) return null;
        beganAt = 0;
        lastSentX = Math.round(startX * scale);
        lastSentY = Math.round(startY * scale);
        wantX = null;
        active = true;
        return { left: Math.max(0, startX - minX), right: Math.max(0, maxX - startX), centerX: startX + winW / 2 };
      } catch {
        return null; // browser preview / no window API
      }
    },
    moveTo(dx: number) {
      if (!active) return;
      if (!beganAt) beganAt = performance.now();
      wantX = dx;
      if (!timer && !inflight) void pump();
    },
    end() {
      // Flush the final position (already queued by the last moveTo), then stop.
      if (active && wantX != null && !timer && !inflight) void pump();
      active = false;
    },
  };
}

/** Drop the window onto the bottom of the current work area (keeps X, clamps into view). */
export async function snapToFloor(): Promise<void> {
  try {
    const { LogicalPosition } = await import("@tauri-apps/api/dpi");
    const win = getCurrentWindow();
    const monitor = (await currentMonitor()) ?? (await primaryMonitor());
    if (!monitor) return;
    const scale = monitor.scaleFactor || 1;
    const workX = monitor.workArea.position.x / scale;
    const workY = monitor.workArea.position.y / scale;
    const workW = monitor.workArea.size.width / scale;
    const workH = monitor.workArea.size.height / scale;
    const outer = await win.outerPosition();
    const size = await win.outerSize();
    const winW = size.width / scale;
    const winH = size.height / scale;
    const x = Math.min(Math.max(outer.x / scale, workX), Math.max(workX, workX + workW - winW));
    const y = Math.max(workY, workY + workH - winH);
    await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
  } catch {
    // browser preview
  }
}

export function Companion({
  mood,
  name,
  compact,
  modelUrl,
  flash,
  roamAmount = "calm",
  roamPaused = false,
  reactKey = 0,
  cue = null,
  playful = false,
}: Props) {
  const driverRef = useRef<RoamDriver | null>(null);
  if (!driverRef.current) driverRef.current = createWindowRoamDriver();

  return (
    <div
      className={`companion ${compact ? "compact" : ""} mood-${mood}`}
      aria-label={`${name} is ${mood}`}
    >
      {!compact && (
        <>
          <div className="orbit orbit-a" />
          <div className="orbit orbit-b" />
        </>
      )}
      <div className="pet-3d-wrap">
        <CompanionVRM
          key={`${PET_VRM_VERSION}-${modelUrl ?? "default"}`}
          mood={mood}
          className="pet-3d"
          modelUrl={modelUrl}
          flash={flash}
          roamAmount={roamAmount}
          roamAllowed={!roamPaused && roamAmount !== "off"}
          reactKey={reactKey}
          cue={cue}
          playful={playful}
          roamDriver={driverRef}
        />
      </div>
      {!compact && <div className="nametag">{name}</div>}
    </div>
  );
}
