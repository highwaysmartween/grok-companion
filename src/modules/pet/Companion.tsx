import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import type { PetMood } from "../../types";
import { CompanionVRM, PET_VRM_VERSION, type RoamControl } from "./CompanionVRM";
import "./Companion.css";

interface Props {
  mood: PetMood;
  name: string;
  compact?: boolean;
  modelUrl?: string;
  flash?: boolean;
  /** When false, she never wanders (idle / look / react still run). Default true. */
  roamEnabled?: boolean;
  /** Temporarily hold still (hovered, chat open, being dragged…). */
  roamPaused?: boolean;
  reactKey?: number;
}

/** Desktop walk speed (logical px / s). Slow enough to read as a stroll. */
const WALK_PX_PER_SEC = 115;
/** ~30 Hz window moves — smooth enough, far cheaper than per-rAF IPC. */
const MOVE_INTERVAL_MS = 33;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * Desktop roam: while CompanionVRM plays Walking, slide the transparent window
 * along the bottom of the work area (standing on the taskbar). Reports the real
 * direction back through `control` so she always faces where she's going, and
 * 0 when the move ends (or can't happen).
 */
async function roamWindow(
  wantFacing: 1 | -1,
  durationMs: number,
  cancelled: () => boolean,
  control: RoamControl,
) {
  try {
    const { LogicalPosition } = await import("@tauri-apps/api/dpi");
    const win = getCurrentWindow();
    const monitor = (await currentMonitor()) ?? (await primaryMonitor());
    if (!monitor || cancelled()) {
      control.facing = 0;
      return;
    }

    const scale = monitor.scaleFactor || 1;
    const workX = monitor.workArea.position.x / scale;
    const workY = monitor.workArea.position.y / scale;
    const workW = monitor.workArea.size.width / scale;
    const workH = monitor.workArea.size.height / scale;

    const outer = await win.outerPosition();
    const size = await win.outerSize();
    const winW = size.width / scale;
    const winH = size.height / scale;
    const curX = outer.x / scale;
    const curY = outer.y / scale;

    const margin = 4;
    const minX = workX + margin;
    const maxX = workX + workW - winW - margin;
    // Feet on the taskbar: window bottom = work-area bottom.
    const floorY = Math.max(workY, workY + workH - winH);
    if (maxX <= minX) {
      control.facing = 0;
      return;
    }

    const want = WALK_PX_PER_SEC * (durationMs / 1000);
    const roomRight = maxX - curX;
    const roomLeft = curX - minX;
    let dir: 1 | -1 = wantFacing;
    // Not enough room that way → turn around (and face the new way).
    if ((dir > 0 ? roomRight : roomLeft) < Math.min(want, 120)) dir = dir > 0 ? -1 : 1;
    const room = dir > 0 ? roomRight : roomLeft;
    const dist = Math.min(want, Math.max(0, room));
    if (dist < 24 && Math.abs(floorY - curY) < 2) {
      control.facing = 0;
      return;
    }
    control.facing = dir;
    if (cancelled()) return;

    const targetX = curX + dir * dist;
    const moveMs = Math.max(400, (dist / WALK_PX_PER_SEC) * 1000);
    const start = performance.now();
    const ease = (u: number) => {
      // Short ease in/out at the ends, constant speed in the middle.
      const k = 0.12;
      if (u < k) return (u * u) / (2 * k * (1 - k));
      if (u > 1 - k) return 1 - ((1 - u) * (1 - u)) / (2 * k * (1 - k));
      return (u - k / 2) / (1 - k);
    };

    for (;;) {
      if (cancelled()) return;
      const u = Math.min(1, (performance.now() - start) / moveMs);
      const e = ease(u);
      const x = curX + (targetX - curX) * e;
      // Settle onto the floor during the first part of the walk; no vertical drift.
      const y = curY + (floorY - curY) * Math.min(1, u * 2.5);
      try {
        await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
      } catch {
        break;
      }
      if (u >= 1) break;
      await sleep(MOVE_INTERVAL_MS);
    }
    if (!cancelled()) control.facing = 0;
  } catch (err) {
    console.warn("[pet] roam window move failed", err);
    control.facing = 0;
  }
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
  roamEnabled = true,
  roamPaused = false,
  reactKey = 0,
}: Props) {
  const roamGen = useRef(0);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const allowRef = useRef(roamEnabled && !roamPaused);
  allowRef.current = roamEnabled && !roamPaused;
  const roamControl = useRef<RoamControl>({ facing: null });

  // Stop any in-flight walk when engaged, paused or disabled.
  useEffect(() => {
    if (mood === "speaking" || mood === "listening" || mood === "thinking" || !roamEnabled || roamPaused) {
      roamGen.current += 1;
      roamControl.current.facing = 0;
    }
  }, [mood, roamEnabled, roamPaused]);

  const onWalkStart = useCallback((opts: { facing: 1 | -1; durationMs: number }) => {
    const m = moodRef.current;
    if (!allowRef.current || m === "speaking" || m === "listening" || m === "thinking") {
      roamControl.current.facing = 0;
      return;
    }
    const gen = ++roamGen.current;
    void roamWindow(opts.facing, opts.durationMs, () => gen !== roamGen.current, roamControl.current);
  }, []);

  const onWalkEnd = useCallback(() => {
    roamGen.current += 1;
  }, []);

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
          roamEnabled={roamEnabled && !roamPaused}
          reactKey={reactKey}
          onWalkStart={onWalkStart}
          onWalkEnd={onWalkEnd}
          roamControl={roamControl}
        />
      </div>
      {!compact && <div className="nametag">{name}</div>}
    </div>
  );
}
