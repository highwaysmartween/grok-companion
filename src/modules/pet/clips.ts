/**
 * Clip registry: Mixamo FBX (X Bot rig, 30 fps, Without Skin) → VRM.
 * Shared by CompanionVRM and the headless clip check.
 *
 * `urls` are tried in order (first that loads wins). `startup` clips load
 * before she appears; the rest stream in afterwards one at a time (and on
 * first use), so a cold start parses ~2 MB instead of ~12 MB.
 */
import type { RootMode } from "./loadMixamoAnimation";

export type ClipKey =
  | "idle"
  | "happyIdle"
  | "look"
  | "stretch"
  | "walk"
  | "wave"
  | "kiss"
  | "talk"
  | "think"
  | "sitDown"
  | "sit"
  | "standUp"
  | "sleep"
  | "joyJump"
  | "jump";

export interface ClipDef {
  urls: readonly string[];
  /** Loop forever, or play once and clamp on the last frame. */
  once?: boolean;
  /** For very short one-shots (Waving is a single 0.5 s wave): play N times. */
  repeat?: number;
  root?: RootMode;
  /** Upper-body layer only (blended over the base pose, legs untouched). */
  upperBody?: boolean;
  measureGait?: boolean;
  startup?: boolean;
}

export const CLIPS: Record<ClipKey, ClipDef> = {
  idle: { urls: ["/animations/Breathing_Idle.fbx", "/animations/Idle.fbx"], startup: true },
  happyIdle: { urls: ["/animations/Happy_Idle.fbx"] },
  look: { urls: ["/animations/Looking_Around.fbx"], once: true },
  stretch: { urls: ["/animations/Arm_Stretching.fbx"], once: true },
  walk: {
    urls: ["/animations/Female_Walk.fbx", "/animations/Walking.fbx"],
    root: "detrend",
    measureGait: true,
    startup: true,
  },
  wave: { urls: ["/animations/Waving.fbx"], once: true, repeat: 3 },
  kiss: { urls: ["/animations/Blow_A_Kiss.fbx"], once: true },
  talk: { urls: ["/animations/Talking.fbx"], upperBody: true },
  think: { urls: ["/animations/Thinking.fbx"] },
  sitDown: { urls: ["/animations/Stand_To_Sit.fbx"], once: true, root: "pin" },
  sit: { urls: ["/animations/Sitting_Idle.fbx"], root: "pin" },
  standUp: { urls: ["/animations/Sit_To_Stand.fbx"], once: true, root: "pin" },
  sleep: { urls: ["/animations/Laying_Sleeping.fbx"] },
  joyJump: { urls: ["/animations/Joyful_Jump.fbx"], once: true },
  jump: { urls: ["/animations/Standing_Jump.fbx"], once: true },
};

export const CLIP_KEYS = Object.keys(CLIPS) as ClipKey[];
