/**
 * Desktop-pet behaviour model (pure, framework-free).
 *
 * The render loop in CompanionVRM owns the clock and the clips; this module
 * decides *what* she does next and *how* a stroll moves, so tuning the feel
 * never means touching three.js code.
 *
 * Adding a new clip-driven state (Jump, Pounce, Sitting, Stretch,
 * Looking_Around, Waving, Sleeping…):
 *   1. drop the Mixamo FBX into public/animations/ and list it in ANIM
 *      (CompanionVRM.tsx) under the clip key used below;
 *   2. add / enable an entry in ACTIVITIES with `requires: [<clip key>]`
 *      and a weight per roam profile. Entries whose clips are missing are
 *      never picked, so nothing changes until the file actually ships.
 */

export type RoamAmount = "off" | "calm" | "lively";
export const DEFAULT_ROAM_AMOUNT: RoamAmount = "calm";

export function normalizeRoamAmount(v: unknown): RoamAmount {
  return v === "off" || v === "lively" || v === "calm" ? v : DEFAULT_ROAM_AMOUNT;
}

/** Clip keys the behaviour layer may ask for (superset of what ships today). */
export type ClipKey =
  | "idle"
  | "walk"
  | "look"
  | "wave"
  | "talk"
  | "think"
  | "sit"
  | "sleep"
  | "stretch"
  | "jump"
  | "pounce";

/**
 * Self-directed activities picked after an idle dwell. Reactive states
 * (attend-to-user, react, sleep) are driven by mood/cursor in CompanionVRM and
 * always win over these.
 */
export type ActivityId =
  | "idle" // keep standing, breathe, glance
  | "lookAround" // head scan (Looking_Around clip if present, else procedural)
  | "turn" // turn in place a little, hold, turn back
  | "stroll" // one short walk to one target
  | "stretch" // one-shot gesture (needs Stretch.fbx)
  | "sit" // sit for a while (needs Sitting.fbx)
  | "hop" // one-shot jump/pounce (needs Jump.fbx / Pounce.fbx), lively only
  | "visitIcon"; // walk to a desktop icon — hook only, see visitDesktopIcon()

export interface ActivityDef {
  id: ActivityId;
  /** Any one of these clips must be loaded for the activity to be eligible. */
  requires?: ClipKey[];
  /** Relative pick weight per roam profile. */
  weight: Record<RoamAmount, number>;
  /** Seconds the activity lasts (for timed ones; strolls compute their own). */
  duration?: [number, number];
  /** Needs window movement (disabled when roam is Off or the host can't move). */
  moves?: boolean;
}

export const ACTIVITIES: ActivityDef[] = [
  { id: "idle", weight: { off: 0.55, calm: 0.42, lively: 0.28 } },
  { id: "lookAround", duration: [3, 5.5], weight: { off: 0.25, calm: 0.2, lively: 0.18 } },
  { id: "turn", duration: [2.5, 4.5], weight: { off: 0.15, calm: 0.12, lively: 0.12 } },
  { id: "stroll", moves: true, weight: { off: 0, calm: 0.2, lively: 0.34 } },
  { id: "stretch", requires: ["stretch"], weight: { off: 0.05, calm: 0.06, lively: 0.06 } },
  { id: "sit", requires: ["sit"], duration: [12, 30], weight: { off: 0.08, calm: 0.08, lively: 0.04 } },
  { id: "hop", requires: ["jump", "pounce"], weight: { off: 0, calm: 0, lively: 0.05 } },
  // TODO(visit-icon): give this a weight once visitDesktopIcon() is implemented.
  { id: "visitIcon", moves: true, weight: { off: 0, calm: 0, lively: 0 } },
];

export interface RoamProfile {
  /** Plain-idle dwell between activities, seconds [min, max]. */
  idleDwell: [number, number];
  /** Short breather when a second stroll is chained straight after one. */
  chainDwell: [number, number];
  /** Stroll target distance, logical px [min, max]. */
  strollDistance: [number, number];
  /** Cruise speed on screen, logical px/s. */
  cruiseSpeed: number;
  /** Seconds to ease from standstill to cruise (and back down). */
  rampTime: number;
  /** Walk-clip playback rate we aim for at cruise; body yaw is solved around it. */
  targetTimeScale: number;
  /** Probability of chaining another stroll right after one… */
  chainChance: number;
  /** …but never more than this many strolls before a full idle dwell. */
  maxStrollsInRow: number;
}

export const ROAM_PROFILES: Record<RoamAmount, RoamProfile> = {
  off: {
    idleDwell: [10, 25],
    chainDwell: [2, 3],
    strollDistance: [0, 0],
    cruiseSpeed: 0,
    rampTime: 1,
    targetTimeScale: 0.6,
    chainChance: 0,
    maxStrollsInRow: 0,
  },
  calm: {
    idleDwell: [8, 25],
    chainDwell: [1.5, 3],
    strollDistance: [80, 300],
    cruiseSpeed: 52,
    rampTime: 1.1,
    targetTimeScale: 0.6,
    chainChance: 0,
    maxStrollsInRow: 1,
  },
  lively: {
    idleDwell: [5, 14],
    chainDwell: [1.2, 2.5],
    strollDistance: [100, 300],
    cruiseSpeed: 68,
    rampTime: 0.9,
    targetTimeScale: 0.72,
    chainChance: 0.35,
    maxStrollsInRow: 2,
  },
};

/** Stroll choreography timings (seconds). */
export const STROLL_TIMING = {
  /** Body turn toward the walk direction (and back). */
  turn: 0.45,
  /** Standing beat after turning, before the first step. */
  prePause: [0.35, 0.7] as [number, number],
  /** Idle ↔ walk crossfade. */
  crossfade: 0.5,
  /** Standing beat after arriving, before turning back to the viewer. */
  postPause: [0.6, 1.2] as [number, number],
  /** Graceful stop when interrupted mid-walk. */
  abortRamp: 0.55,
};

export type Rng = () => number;

export const rand = (lo: number, hi: number, rng: Rng = Math.random) => lo + (hi - lo) * rng();
export const randIn = (r: [number, number], rng: Rng = Math.random) => rand(r[0], r[1], rng);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const smoothstep = (u: number) => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};

export interface PickContext {
  amount: RoamAmount;
  /** Clip keys that actually loaded. */
  clips: ReadonlySet<ClipKey>;
  /** Host can move the window right now (Tauri, not paused, monitor known). */
  canMove: boolean;
  /** Strolls done since the last full idle dwell. */
  strollsInRow: number;
}

function eligible(def: ActivityDef, ctx: PickContext): boolean {
  if (def.moves && (!ctx.canMove || ctx.amount === "off")) return false;
  if (def.id === "stroll" && ctx.strollsInRow >= ROAM_PROFILES[ctx.amount].maxStrollsInRow) return false;
  if (def.requires && !def.requires.some((c) => ctx.clips.has(c))) return false;
  return def.weight[ctx.amount] > 0;
}

/** Weighted pick of the next self-directed activity (always returns something). */
export function pickActivity(ctx: PickContext, rng: Rng = Math.random): ActivityId {
  const pool = ACTIVITIES.filter((d) => eligible(d, ctx));
  const total = pool.reduce((s, d) => s + d.weight[ctx.amount], 0);
  if (total <= 0) return "idle";
  let r = rng() * total;
  for (const d of pool) {
    r -= d.weight[ctx.amount];
    if (r <= 0) return d.id;
  }
  return pool[pool.length - 1]!.id;
}

export function activityDuration(id: ActivityId, rng: Rng = Math.random): number {
  const def = ACTIVITIES.find((d) => d.id === id);
  return def?.duration ? randIn(def.duration, rng) : 3;
}

/** Should another stroll follow this one immediately (after a short beat)? */
export function shouldChainStroll(amount: RoamAmount, strollsInRow: number, rng: Rng = Math.random): boolean {
  const p = ROAM_PROFILES[amount];
  return strollsInRow < p.maxStrollsInRow && rng() < p.chainChance;
}

export interface Room {
  /** Free logical px to the left / right of the window inside the work area. */
  left: number;
  right: number;
}

export interface StrollPlan {
  dir: 1 | -1;
  distance: number;
}

/**
 * One target per stroll. Picks a side with room (biased toward the screen
 * centre so she never hugs or bounces between edges) and a short distance.
 * Returns null when there isn't room for even a minimum stroll.
 */
export function planStroll(amount: RoamAmount, room: Room, rng: Rng = Math.random): StrollPlan | null {
  const [minD, maxD] = ROAM_PROFILES[amount].strollDistance;
  if (maxD <= 0) return null;
  const left = Math.max(0, room.left);
  const right = Math.max(0, room.right);
  const canL = left >= minD;
  const canR = right >= minD;
  if (!canL && !canR) return null;
  let dir: 1 | -1;
  if (canL && canR) {
    const pRight = 0.5 + 0.35 * ((right - left) / Math.max(1, right + left));
    dir = rng() < pRight ? 1 : -1;
  } else {
    dir = canR ? 1 : -1;
  }
  // Bias toward shorter strolls: most land in the lower half of the range.
  const want = minD + (maxD - minD) * Math.pow(rng(), 1.4);
  const avail = dir > 0 ? right : left;
  return { dir, distance: Math.max(minD, Math.min(want, avail)) };
}

export interface StrollMotion {
  distance: number;
  cruise: number;
  ramp: number;
  duration: number;
  /** Position (0…distance) and speed (px/s) at time t seconds into the walk. */
  sample(t: number): { pos: number; vel: number };
}

/**
 * S-curve velocity profile: smoothstep ease-in to cruise, constant cruise,
 * smoothstep ease-out to a stop. Position is the exact integral, so the
 * window glides with no jerks. ∫₀ˣ smoothstep = x³ − x⁴/2.
 */
export function makeStrollMotion(distance: number, cruiseSpeed: number, rampTime: number): StrollMotion {
  const d = Math.max(0, distance);
  const ramp = Math.max(0.05, rampTime);
  const cruise = Math.max(1, Math.min(cruiseSpeed, d / ramp));
  const duration = d <= 0 ? 0 : ramp + d / cruise;
  const rampDist = (x: number) => cruise * ramp * (x * x * x - (x * x * x * x) / 2);
  return {
    distance: d,
    cruise,
    ramp,
    duration,
    sample(t: number) {
      if (d <= 0 || t >= duration) return { pos: d, vel: 0 };
      if (t <= 0) return { pos: 0, vel: 0 };
      if (t < ramp) {
        const x = t / ramp;
        return { pos: rampDist(x), vel: cruise * smoothstep(x) };
      }
      if (t > duration - ramp) {
        const y = (duration - t) / ramp;
        return { pos: d - rampDist(y), vel: cruise * smoothstep(y) };
      }
      return { pos: (cruise * ramp) / 2 + cruise * (t - ramp), vel: cruise };
    },
  };
}

/**
 * Keep the feet planted: the walk clip's stride moves `naturalPxPerSec`
 * sideways at timeScale 1 when seen side-on. Mixamo's Walking is a brisk
 * ~1.1 body-heights/s, far faster than a calm on-screen stroll, so instead of
 * slow-motion legs we turn her only partly toward the walk direction (a 3/4
 * stroll) and play the clip near `targetTimeScale`; screen-x foot speed is
 * then natural · timeScale · sin(yaw) = cruise.
 */
export function solveGait(
  cruisePx: number,
  naturalPxPerSec: number,
  targetTimeScale: number,
): { yaw: number; timeScale: number } {
  if (!(naturalPxPerSec > 1) || !(cruisePx > 0)) return { yaw: 0.35, timeScale: targetTimeScale };
  const s = clamp(cruisePx / (naturalPxPerSec * targetTimeScale), Math.sin(0.2), Math.sin(0.8));
  return { yaw: Math.asin(s), timeScale: clamp(cruisePx / (naturalPxPerSec * s), 0.3, 1.1) };
}

/** Timed, eased scalar (body yaw turns etc.). */
export class Tween {
  private from = 0;
  private to = 0;
  private start = 0;
  private dur = 0;
  value = 0;
  set(to: number, now: number, dur: number) {
    this.from = this.value;
    this.to = to;
    this.start = now;
    this.dur = Math.max(0.001, dur);
  }
  update(now: number) {
    this.value = this.from + (this.to - this.from) * smoothstep((now - this.start) / this.dur);
    return this.value;
  }
  get target() {
    return this.to;
  }
  done(now: number) {
    return now - this.start >= this.dur;
  }
}

/** Host side of a stroll: moves the transparent window along the floor. */
export interface RoamDriver {
  /** Measure free room and lock the start position; null = cannot move now. */
  begin(): Promise<Room | null>;
  /** Place the window at start + dx (logical px). Throttled (~30 Hz) internally. */
  moveTo(dx: number): void;
  /** Flush the last position and release. */
  end(): void;
}

/** A desktop icon she could wander over to (screen logical px). */
export interface DesktopIconTarget {
  label: string;
  x: number;
  y: number;
}

/**
 * Hook: walk over to a desktop icon and "inspect" it.
 *
 * TODO(visit-icon): needs a Rust command that lists desktop icon positions
 * (Windows: SysListView32 in the Progman/WorkerW "FolderView", LVM_GETITEMPOSITION),
 * then plan one stroll whose target x is the icon, play look/sit/pounce on
 * arrival. The ACTIVITIES entry has weight 0 until this resolves true.
 */
export async function visitDesktopIcon(
  _driver: RoamDriver,
  _target: DesktopIconTarget | null,
  _amount: RoamAmount,
): Promise<boolean> {
  return false;
}
