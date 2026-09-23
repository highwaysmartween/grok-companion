import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import type { PetMood } from "../../types";
import { CompanionVRM, PET_VRM_VERSION } from "./CompanionVRM";
import "./Companion.css";

interface Props {
  mood: PetMood;
  name: string;
  compact?: boolean;
  modelUrl?: string;
  flash?: boolean;
  /** When false, freeze window roam (still plays idle clips). Default true. */
  roamEnabled?: boolean;
}

/**
 * Desktop roam: while CompanionVRM plays Walking, physically slide the
 * transparent Tauri window across the primary monitor work area.
 */
async function roamWindow(facing: 1 | -1, durationMs: number, cancelled: () => boolean) {
  try {
    const { LogicalPosition } = await import("@tauri-apps/api/dpi");
    const win = getCurrentWindow();
    const monitor = (await currentMonitor()) ?? (await primaryMonitor());
    if (!monitor || cancelled()) return;

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

    const margin = 8;
    const minX = workX + margin;
    const maxX = workX + workW - winW - margin;
    const minY = workY + margin;
    const maxY = workY + workH - winH - margin;
    if (maxX <= minX || maxY <= minY) return;

    // Prefer target in walk facing direction; bounce if near edge
    let targetX: number;
    if (facing > 0) {
      targetX = curX + (80 + Math.random() * Math.max(120, (maxX - curX) * 0.7));
    } else {
      targetX = curX - (80 + Math.random() * Math.max(120, (curX - minX) * 0.7));
    }
    if (targetX > maxX) targetX = minX + Math.random() * (maxX - minX) * 0.35;
    if (targetX < minX) targetX = maxX - Math.random() * (maxX - minX) * 0.35;
    targetX = Math.min(maxX, Math.max(minX, targetX));

    // Small vertical drift so she doesn't stay on one shelf of the screen
    let targetY = curY + (Math.random() - 0.5) * Math.min(160, (maxY - minY) * 0.25);
    targetY = Math.min(maxY, Math.max(minY, targetY));

    const start = performance.now();
    const fromX = curX;
    const fromY = curY;
    const ease = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));

    await new Promise<void>((resolve) => {
      const step = async (now: number) => {
        if (cancelled()) {
          resolve();
          return;
        }
        const u = ease((now - start) / Math.max(durationMs, 1));
        const x = fromX + (targetX - fromX) * u;
        const y = fromY + (targetY - fromY) * u;
        try {
          await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
        } catch {
          resolve();
          return;
        }
        if (u >= 1) resolve();
        else requestAnimationFrame((t) => void step(t));
      };
      requestAnimationFrame((t) => void step(t));
    });
  } catch (err) {
    console.warn("[pet] roam window move failed", err);
  }
}

export function Companion({
  mood,
  name,
  compact,
  modelUrl,
  flash,
  roamEnabled = true,
}: Props) {
  const roamGen = useRef(0);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const roamEnabledRef = useRef(roamEnabled);
  roamEnabledRef.current = roamEnabled;

  // Pause in-flight roam when mood becomes engaged
  useEffect(() => {
    if (mood === "speaking" || mood === "listening" || mood === "thinking") {
      roamGen.current += 1;
    }
  }, [mood]);

  const onWalkStart = useCallback(
    (opts: { facing: 1 | -1; durationMs: number }) => {
      if (!roamEnabledRef.current) return;
      const m = moodRef.current;
      if (m === "speaking" || m === "listening" || m === "thinking") return;
      const gen = ++roamGen.current;
      void roamWindow(opts.facing, opts.durationMs, () => gen !== roamGen.current);
    },
    [],
  );

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
          onWalkStart={onWalkStart}
          onWalkEnd={onWalkEnd}
        />
      </div>
      {!compact && <div className="nametag">{name}</div>}
    </div>
  );
}
