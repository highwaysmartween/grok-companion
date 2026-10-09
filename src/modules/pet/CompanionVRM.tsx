import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PetMood } from "../../types";
import { clipGaitSpeed, loadMixamoAnimation, UPPER_BODY_BONES } from "./loadMixamoAnimation";
import { CLIPS, CLIP_KEYS, type ClipKey } from "./clips";
import {
  ROAM_PROFILES,
  STROLL_TIMING,
  Tween,
  activityDuration,
  FLASH_DURATION,
  flashCoverUpElapsed,
  flashFrame,
  flashPrep,
  makeStrollMotion,
  pickActivity,
  pickIdleBase,
  planStroll,
  rand,
  randIn,
  shouldChainStroll,
  solveGait,
  visitDesktopIcon,
  VARIATIONS,
  type ActivityId,
  type GestureKind,
  type RoamAmount,
  type RoamDriver,
  type StrollMotion,
} from "./behaviour";
import { FlashRig, FlashTop } from "./flash";

export interface GestureCue {
  kind: GestureKind;
  /** Monotonic id; a cue is played once per id (survives model swaps). */
  id: number;
}

interface Props {
  mood: PetMood;
  className?: string;
  modelUrl?: string;
  /** Flash state from the app: true while flashed, false = "cover up" (lowers the top mid-flash). */
  flash?: boolean;
  /** Bump to play the flash move once (she pulls her top up, holds, lowers it). */
  flashKey?: number;
  /** How much she wanders. "off" = never walks (idle / look / turn still run). */
  roamAmount?: RoamAmount;
  /** Strolls allowed right now (not paused by hover / chat / tray). */
  roamAllowed?: boolean;
  /** Settings → "Playful (jump on icons)". */
  playful?: boolean;
  /** Bump to trigger a one-shot reaction (wave / nod). */
  reactKey?: number;
  /** One-shot gesture requests from the app (wave on wake word, kiss on flirty replies…). */
  cue?: GestureCue | null;
  /** Host that moves the transparent Tauri window during a stroll. */
  roamDriver?: MutableRefObject<RoamDriver | null>;
}

export const PET_VRM_VERSION = 20;

/** Reactive modes override the self-directed activity loop (see behaviour.ts). */
type Mode = "activity" | "attend" | "react" | "sleep";
type Posture = "stand" | "sit" | "lie";
type StrollPhase = "measure" | "turn" | "prePause" | "walk" | "stopping" | "pounce" | "postPause" | "turnBack";
interface Stroll {
  phase: StrollPhase;
  phaseAt: number;
  phaseUntil: number;
  dir: 1 | -1;
  motion: StrollMotion | null;
  yaw: number;
  /** Walk-clip timeScale at profile cruise speed (feet planted). */
  timeScale: number;
  cruise: number;
  pos: number;
  vel: number;
  stopFromVel: number;
  interrupted: boolean;
  /** Driver.begin() resolved after we gave up → release on arrival. */
  dropped: boolean;
  fadedOut: boolean;
  /** Icon visit: pounce (jump) on arrival. */
  pounce: boolean;
  /** Debug / icon visit: exact distance + direction instead of a random plan. */
  forced?: { dir: 1 | -1; distance: number };
}
/** A one-shot clip in flight (LoopOnce + clampWhenFinished, then back to the base state). */
interface Shot {
  key: ClipKey;
  end: number;
  fadeOut: number;
  /** Idle variations (look-around, stretch) yield to the user immediately. */
  interruptible: boolean;
  onDone?: () => void;
}
interface Transition {
  kind: "sitDown" | "standUp" | "lieDown" | "getUp";
  end: number;
  onDone?: () => void;
}

/** Upper-body Talking layer weight (base pose keeps the legs; ~half the upper body). */
const TALK_LAYER_WEIGHT = 1.1;
/** Cues older than this are dropped rather than played late. */
const CUE_TTL = 10;
const WAVE_COOLDOWN = 30;
/** Background clip prefetch order after the startup set (most likely needed first). */
const PREFETCH: ClipKey[] = ["wave", "think", "talk", "kiss", "happyIdle", "look", "stretch", "sitDown", "sit", "standUp", "sleep", "joyJump", "jump"];
const PREFETCH_GAP_MS = 450;
/** Lying framing: camera pulls back so the whole body fits the portrait window. */
const LIE_ZOOM = 0.5;

// Session-wide (survive model swaps / remounts).
let greetedThisSession = false;
let lastHandledCue = 0;
let lastHandledFlash = 0;
/** DEV-only roam-amount override for the headless check (the browser preview has no settings). */
let debugRoam: RoamAmount | null = null;

/** Lightweight rendering for Iris Xe-class GPUs. */
const TARGET_FPS = 30;
const MAX_PIXEL_RATIO = 1.25;
const CURSOR_POLL_MS = 100;
const CURSOR_POLL_SLEEP_MS = 500;
/** Cursor counts as "near" within this many px of the window edge. */
const NEAR_PX = 140;

/** Mood → target expression weights (only applied when the model has them). */
function moodExpressions(m: PetMood, flash: boolean): Record<string, number> {
  const base: Record<string, number> = { happy: 0, relaxed: 0, sad: 0, angry: 0, surprised: 0 };
  switch (m) {
    case "happy":
      base.happy = 0.55;
      break;
    case "speaking":
      base.happy = 0.18;
      base.relaxed = 0.1;
      break;
    case "listening":
      base.surprised = 0.12;
      base.relaxed = 0.08;
      break;
    case "thinking":
      base.relaxed = 0.15;
      break;
    case "confused":
      base.surprised = 0.25;
      base.sad = 0.08;
      break;
    case "annoyed":
      base.angry = 0.45;
      break;
    case "sad":
      base.sad = 0.5;
      break;
    case "sleeping":
      base.relaxed = 0.35;
      break;
    case "error":
      base.sad = 0.25;
      base.surprised = 0.12;
      break;
    default:
      // Chill resting face: a hint of a smirk, not a beaming grin.
      base.relaxed = 0.18;
      base.happy = 0.1;
  }
  if (flash) base.happy = Math.max(base.happy, 0.45);
  return base;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const damp = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

type CursorSample = { x: number; y: number; width: number; height: number; inside: boolean; movedAt: number };

const gestureClip = (k: GestureKind): ClipKey =>
  k === "wave" ? "wave" : k === "kiss" ? "kiss" : k === "joy" ? "joyJump" : "jump";

/**
 * VRM + Mixamo clips + procedural life layer:
 *  - postures (stand / sit / lie) with real transitions (Stand_To_Sit, Sit_To_Stand)
 *  - base loops (Breathing_Idle, Happy_Idle, Thinking, Sitting_Idle, Laying_Sleeping)
 *  - one-shots (wave, kiss, jumps, stretch, look-around) that always settle back
 *  - upper-body Talking layer while she speaks
 *  - reactive modes (attend / react / sleep) over the calm activity loop in behaviour.ts
 *  - head/neck look-at following the global cursor, breathing, expressions, mouth
 * Clean neutral lighting: NoToneMapping + white lights (no ACES, no warm/cheek/rim hacks).
 */
export function CompanionVRM({
  mood,
  className,
  modelUrl = "/models/companion.vrm",
  flash = false,
  flashKey = 0,
  roamAmount = "calm",
  roamAllowed = true,
  playful = false,
  reactKey = 0,
  cue = null,
  roamDriver,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const moodRef = useRef(mood);
  const flashRef = useRef(flash);
  const flashKeyRef = useRef(flashKey);
  const roamAmountRef = useRef(roamAmount);
  const roamAllowedRef = useRef(roamAllowed);
  const playfulRef = useRef(playful);
  const reactKeyRef = useRef(reactKey);
  const cueRef = useRef(cue);
  const vrmRef = useRef<VRM | null>(null);
  const roamDriverRef = useRef(roamDriver);
  moodRef.current = mood;
  flashRef.current = flash;
  flashKeyRef.current = flashKey;
  roamAmountRef.current = (import.meta.env.DEV && debugRoam) || roamAmount;
  roamAllowedRef.current = (import.meta.env.DEV && debugRoam !== null) || roamAllowed;
  playfulRef.current = playful;
  reactKeyRef.current = reactKey;
  cueRef.current = cue;
  roamDriverRef.current = roamDriver;

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 40);
    camera.position.set(0, 1.35, 3.4);
    camera.lookAt(0, 0.95, 0);
    camera.up.set(0, 1, 0);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Keep NoToneMapping + neutral white lights — ACES / warm/cheek/rim muddied skins brown
    renderer.toneMapping = THREE.NoToneMapping;
    el.appendChild(renderer.domElement);

    const maxAniso = Math.min(renderer.capabilities.getMaxAnisotropy?.() ?? 4, 4);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x99aabb, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(1.4, 2.6, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.72);
    fill.position.set(-2, 1.4, -1);
    scene.add(fill);
    const bounce = new THREE.DirectionalLight(0xffffff, 0.28);
    bounce.position.set(0.2, 0.6, -2.2);
    scene.add(bounce);

    const root = new THREE.Group();
    scene.add(root);

    let vrm: VRM | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    const actions: Partial<Record<ClipKey, THREE.AnimationAction>> = {};
    const loadedClips = new Set<ClipKey>();
    const failedClips = new Set<ClipKey>();
    const loading = new Map<ClipKey, Promise<boolean>>();
    let current: ClipKey | null = null;
    let frame = 0;
    let disposed = false;
    let paused = false;
    let ready = false;
    let mirror = 1; // VRM0 normalized rig: x/z rotations flip sign
    const available = new Set<string>();
    /** Walk clip ground speed (VRM m/s, measured from the planted foot). */
    let walkGait = 0;
    /** Lying pose: root drop so her back rests on the floor, and body centre along z. */
    let lieDrop = 0;
    let lieCenterZ = 0;

    // --- behaviour state ---------------------------------------------------
    let t = 0;
    let mode: Mode = "activity";
    let modeUntil = 0;
    let posture: Posture = "stand";
    let activity: ActivityId = "idle";
    let actUntil = rand(8, 14);
    let lastVariation: ActivityId | null = null;
    let idleBase: "idle" | "happyIdle" = "idle";
    let turnBackAt = 0;
    let strollsInRow = 0;
    let forceStrollNext = false;
    let stroll: Stroll | null = null;
    let shot: Shot | null = null;
    let transition: Transition | null = null;
    let pendingCue: { kind: GestureKind; at: number } | null = null;
    // Flash: requested → (stop / stand) → playing; cover-up jumps to lowering.
    let flashTop: FlashTop | null = null;
    let flashRig: FlashRig | null = null;
    let flashReq: { at: number } | null = null;
    let flashAct: { start: number; covered: boolean } | null = null;
    let flashWasOn = flashRef.current;
    let flashRaise = 0;
    let lastWaveAt = -1e9;
    let greetAt = -1;
    let lastInteractT = 0;
    let talkW = 0;
    /** Body yaw from deliberate turns (stroll heading, turn-in-place). */
    const bodyTurn = new Tween();
    /** 0 = upright framing, 1 = lying (root turned side-on, dropped, camera pulled back). */
    const lieTween = new Tween();
    let lieSide: 1 | -1 = 1;
    let lastLie = -1;
    let driftYaw = 0;
    let modelHeight = 1.5;
    const camTarget = new THREE.Vector3(0, 0.95, 0);
    let reactFrom = -10;
    let lastReactKey = reactKeyRef.current;
    let lastMood: PetMood = moodRef.current;
    let blinkUntil = 0;
    let nextBlink = 1.5;
    let glanceSide = 1;
    const expr: Record<string, number> = {};
    // smoothed procedural look
    let lookYaw = 0;
    let lookPitch = 0;
    let sleepBlend = 0;
    /** DEV-only: force a mood without the app (headless checks). */
    let debugMood: PetMood | null = null;
    const effMood = (): PetMood => debugMood ?? moodRef.current;

    const cursor: CursorSample = { x: 0, y: 0, width: 1, height: 1, inside: false, movedAt: -1e9 };

    const resize = () => {
      const w = el.clientWidth || 320;
      const h = el.clientHeight || 480;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // --- clips -----------------------------------------------------------------
    const crossfade = (to: ClipKey, fade = 0.5) => {
      const next = actions[to];
      if (!next || to === "talk") return false;
      if (to === current && next.isRunning() && !next.paused) return true;
      const prev = current ? actions[current] : undefined;
      next.reset().setEffectiveWeight(1).fadeIn(fade).play();
      if (prev && prev !== next) prev.fadeOut(fade);
      current = to;
      return true;
    };

    const idleKey = (): ClipKey => (actions[idleBase] ? idleBase : "idle");
    /** The loop she returns to after any one-shot or transition. */
    const baseClip = (): ClipKey => {
      if (posture === "lie") return actions.sleep ? "sleep" : actions.sit ? "sit" : idleKey();
      if (posture === "sit") return actions.sit ? "sit" : idleKey();
      if (effMood() === "thinking" && actions.think) return "think";
      return idleKey();
    };
    const settleBase = (fade = 0.5) => crossfade(baseClip(), fade);

    const rootLocal = new THREE.Vector3();
    const PROBE_BONES: VRMHumanBoneName[] = ["hips", "head", "chest", "leftHand", "rightHand", "leftFoot", "rightFoot", "leftLowerLeg", "rightLowerLeg", "leftLowerArm", "rightLowerArm"];
    /**
     * Sanity-check a retargeted clip on the live rig (between frames): NaNs,
     * limbs flying off (explosion) or a stuck T-pose → drop it from the pool.
     */
    const validateClip = (k: ClipKey, clip: THREE.AnimationClip): string | null => {
      const v = vrm;
      if (!v) return "no model";
      const tmp = new THREE.AnimationMixer(v.scene);
      const act = tmp.clipAction(clip);
      act.play();
      let problem: string | null = null;
      let tposeHits = 0;
      let minY = Infinity;
      let zMin = Infinity;
      let zMax = -Infinity;
      const hp = new THREE.Vector3();
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const spine = new THREE.Vector3();
      const samples = [0.1, 0.35, 0.6, 0.9];
      for (const u of samples) {
        tmp.setTime(clip.duration * u);
        v.humanoid.update();
        v.scene.updateMatrixWorld(true);
        const hips = v.humanoid.getRawBoneNode("hips");
        const neck = v.humanoid.getRawBoneNode("neck") ?? v.humanoid.getRawBoneNode("head");
        if (!hips || !neck) return "missing hips/neck";
        root.worldToLocal(hips.getWorldPosition(hp));
        root.worldToLocal(neck.getWorldPosition(spine)).sub(hp).normalize();
        for (const n of PROBE_BONES) {
          const node = v.humanoid.getRawBoneNode(n);
          if (!node) continue;
          root.worldToLocal(node.getWorldPosition(rootLocal));
          if (!Number.isFinite(rootLocal.x + rootLocal.y + rootLocal.z)) problem = "NaN pose";
          else if (rootLocal.distanceTo(hp) > modelHeight * 1.2) problem = `${n} flies off`;
          minY = Math.min(minY, rootLocal.y);
          zMin = Math.min(zMin, rootLocal.z);
          zMax = Math.max(zMax, rootLocal.z);
        }
        let horiz = 0;
        for (const side of ["left", "right"] as const) {
          const up = v.humanoid.getRawBoneNode(`${side}UpperArm`);
          const lo = v.humanoid.getRawBoneNode(`${side}LowerArm`);
          if (!up || !lo) continue;
          up.getWorldPosition(a);
          lo.getWorldPosition(b);
          if (Math.abs(b.sub(a).normalize().dot(spine)) < 0.2) horiz++;
        }
        if (horiz === 2) tposeHits++;
      }
      act.stop();
      tmp.uncacheRoot(v.scene);
      if (!problem && tposeHits === samples.length) problem = "stuck in T-pose";
      if (!problem && k === "sleep") {
        lieDrop = -(minY - modelHeight * 0.04);
        lieCenterZ = (zMin + zMax) / 2;
      }
      return problem;
    };

    /** Start loading a clip (once). True if it's ready right now. */
    const ensureClip = (k: ClipKey): boolean => {
      if (actions[k]) return true;
      if (failedClips.has(k) || loading.has(k) || !vrm || !mixer || disposed) return false;
      const v = vrm;
      const def = CLIPS[k];
      const job = (async () => {
        for (const url of def.urls) {
          try {
            const clip = await loadMixamoAnimation(url, v, {
              root: def.root,
              measureGait: def.measureGait,
              onlyBones: def.upperBody ? UPPER_BODY_BONES : undefined,
            });
            if (disposed || !mixer || vrm !== v) return false;
            const bad = def.upperBody ? null : validateClip(k, clip);
            if (bad) {
              console.warn(`[pet] clip "${k}" (${url}) dropped: ${bad}`);
              continue;
            }
            const act = mixer.clipAction(clip);
            if (def.once) {
              const reps = def.repeat ?? 1;
              act.setLoop(reps > 1 ? THREE.LoopRepeat : THREE.LoopOnce, reps);
              act.clampWhenFinished = true;
            } else {
              act.setLoop(THREE.LoopRepeat, Infinity);
            }
            if (k === "walk") walkGait = clipGaitSpeed(clip);
            actions[k] = act;
            loadedClips.add(k);
            return true;
          } catch (err) {
            console.warn(`[pet] clip "${k}" (${url}) failed to load/retarget`, err);
          }
        }
        failedClips.add(k);
        return false;
      })().finally(() => loading.delete(k));
      loading.set(k, job);
      return false;
    };

    const prefetch = async () => {
      for (const k of PREFETCH) {
        if (disposed) return;
        if (actions[k] || failedClips.has(k)) continue;
        ensureClip(k);
        await loading.get(k);
        await new Promise<void>((r) => window.setTimeout(r, PREFETCH_GAP_MS));
      }
    };

    // --- one-shots, postures ------------------------------------------------
    /** LoopOnce + clamp, then crossfade back to the base loop. Never while walking. */
    const startShot = (
      k: ClipKey,
      o: { fadeIn?: number; fadeOut?: number; maxDur?: number; timeScale?: number; interruptible?: boolean; onDone?: () => void } = {},
    ) => {
      const act = actions[k];
      if (!act) {
        ensureClip(k);
        return false;
      }
      act.timeScale = o.timeScale ?? 1;
      if (!crossfade(k, o.fadeIn ?? 0.45)) return false;
      const len = (act.getClip().duration * (CLIPS[k].repeat ?? 1)) / act.timeScale;
      shot = {
        key: k,
        end: t + Math.min(len, o.maxDur ?? Infinity),
        fadeOut: o.fadeOut ?? 0.5,
        interruptible: !!o.interruptible,
        onDone: o.onDone,
      };
      return true;
    };
    const playShot = (k: ClipKey, o: Parameters<typeof startShot>[1] = {}) =>
      !stroll && !transition && posture === "stand" && startShot(k, o);

    const endShot = (fade: number) => {
      const s = shot;
      if (!s) return;
      shot = null;
      s.onDone?.();
      if (!shot && !transition && current === s.key) settleBase(fade);
    };

    const sitDown = (onDone?: () => void) => {
      const a = actions.sitDown;
      if (!a || !actions.sit || !actions.standUp || posture !== "stand") return false;
      shot = null;
      if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.5);
      crossfade("sitDown", 0.5);
      transition = {
        kind: "sitDown",
        end: t + a.getClip().duration - 0.35,
        onDone: () => {
          posture = "sit";
          crossfade("sit", 0.45);
          onDone?.();
        },
      };
      return true;
    };

    const standUp = (onDone?: () => void) => {
      if (posture !== "sit") {
        onDone?.();
        return;
      }
      const a = actions.standUp;
      if (!a) {
        posture = "stand";
        settleBase(0.8);
        onDone?.();
        return;
      }
      crossfade("standUp", 0.4);
      transition = {
        kind: "standUp",
        end: t + a.getClip().duration - 0.4,
        onDone: () => {
          posture = "stand";
          crossfade(baseClip(), 0.5);
          onDone?.();
        },
      };
    };

    const lieDown = () => {
      if (posture === "lie") return;
      if (posture === "stand") {
        // Sit first so lying back reads naturally; without sit clips doze standing.
        if (sitDown(() => effMood() === "sleeping" && lieDown())) return;
        if (!actions.sleep) return;
      }
      if (!actions.sleep) return; // seated doze (procedural head droop)
      lieSide = Math.random() < 0.5 ? 1 : -1;
      crossfade("sleep", 2.0);
      lieTween.set(1, t, 2.2);
      transition = { kind: "lieDown", end: t + 2.2, onDone: () => (posture = "lie") };
    };

    const getUp = (onDone?: () => void) => {
      if (posture === "lie") {
        lieTween.set(0, t, 1.8);
        const toSit = !!(actions.sit && actions.standUp);
        crossfade(toSit ? "sit" : idleKey(), 1.6);
        transition = {
          kind: "getUp",
          end: t + 1.8,
          onDone: () => {
            posture = toSit ? "sit" : "stand";
            if (toSit) standUp(onDone);
            else onDone?.();
          },
        };
        return;
      }
      if (posture === "sit") standUp(onDone);
      else onDone?.();
    };

    const enterMode = (next: Mode, duration: number) => {
      mode = next;
      modeUntil = t + duration;
    };

    const queueCue = (kind: GestureKind) => {
      if (kind === "wave" && t - lastWaveAt < WAVE_COOLDOWN) return;
      pendingCue = { kind, at: t };
      lastInteractT = t;
      ensureClip(gestureClip(kind));
    };

    // --- cursor polling (global cursor via Rust; DOM fallback in browser preview) ---
    let cursorTimer = 0;
    let rustCursor = true;
    const onMouseMove = (e: MouseEvent) => {
      if (rustCursor) return;
      const nx = e.clientX;
      const ny = e.clientY;
      if (Math.abs(nx - cursor.x) + Math.abs(ny - cursor.y) > 2) cursor.movedAt = t;
      cursor.x = nx;
      cursor.y = ny;
      cursor.width = window.innerWidth;
      cursor.height = window.innerHeight;
      cursor.inside = true;
    };
    window.addEventListener("mousemove", onMouseMove);
    const pollCursor = async () => {
      if (disposed) return;
      if (!paused && rustCursor) {
        try {
          const c = await invoke<{ x: number; y: number; width: number; height: number; inside: boolean }>("cursor_relative");
          if (Math.abs(c.x - cursor.x) + Math.abs(c.y - cursor.y) > 2) cursor.movedAt = t;
          cursor.x = c.x;
          cursor.y = c.y;
          cursor.width = c.width || 1;
          cursor.height = c.height || 1;
          cursor.inside = c.inside;
        } catch {
          rustCursor = false; // not in Tauri → DOM events
        }
      }
      if (disposed) return;
      cursorTimer = window.setTimeout(() => void pollCursor(), mode === "sleep" ? CURSOR_POLL_SLEEP_MS : CURSOR_POLL_MS);
    };
    void pollCursor();

    const cursorNear = () => {
      const { x, y, width, height } = cursor;
      const near = x > -NEAR_PX && y > -NEAR_PX && x < width + NEAR_PX && y < height + NEAR_PX;
      return near && t - cursor.movedAt < 4;
    };
    const hovering = () => cursor.inside && t - cursor.movedAt < 3;

    // --- load model + startup clips ------------------------------------------
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    void (async () => {
      try {
        const gltf = await loader.loadAsync(modelUrl);
        if (disposed) return;
        const loaded = gltf.userData.vrm as VRM | undefined;
        if (!loaded) throw new Error("No VRM in model");

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        try {
          VRMUtils.combineSkeletons(gltf.scene);
        } catch {
          /* optional */
        }
        if (loaded.meta?.metaVersion === "0") {
          VRMUtils.rotateVRM0(loaded);
          mirror = -1;
        }
        loaded.scene.traverse((o) => {
          o.frustumCulled = false;
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) {
            if (!mat) continue;
            const m = mat as THREE.MeshStandardMaterial;
            for (const texKey of ["map", "normalMap", "emissiveMap"] as const) {
              const tex = m[texKey];
              if (tex && "anisotropy" in tex) {
                tex.anisotropy = maxAniso;
                tex.needsUpdate = true;
              }
            }
          }
        });

        loaded.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(loaded.scene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        loaded.scene.position.x -= center.x;
        loaded.scene.position.z -= center.z;
        loaded.scene.position.y -= box.min.y;

        const h = Math.max(size.y, 1.2);
        modelHeight = h;
        camera.position.set(0, h * 0.58, h * 2.05);
        camTarget.set(0, h * 0.48, 0);
        camera.lookAt(camTarget);
        camera.updateProjectionMatrix();

        root.add(loaded.scene);
        vrm = loaded;
        vrmRef.current = loaded;
        flashTop = new FlashTop(loaded);
        flashRig = new FlashRig(loaded, flashTop);
        console.info("[pet] flash:", flashTop.mode, flashTop.reason, flashTop.topNames);
        mixer = new THREE.AnimationMixer(loaded.scene);

        const em = loaded.expressionManager;
        for (const n of ["happy", "relaxed", "sad", "angry", "surprised", "aa", "oh", "ih", "blink"]) {
          if (em?.getExpression(n)) available.add(n);
        }

        const startup = CLIP_KEYS.filter((k) => CLIPS[k].startup);
        startup.forEach((k) => ensureClip(k));
        await Promise.all(startup.map((k) => loading.get(k)));
        if (disposed || !mixer) return;
        crossfade("idle", 0.01);
        ready = true;
        console.info("[pet] ready v", PET_VRM_VERSION, modelUrl, "clips:", [...loadedClips], "expr:", [...available]);
        if (!greetedThisSession) {
          greetedThisSession = true;
          greetAt = t + 1.5;
          ensureClip("wave");
        }
        void prefetch().then(() => {
          if (!disposed) console.info("[pet] clips loaded:", [...loadedClips], failedClips.size ? `dropped: ${[...failedClips]}` : "");
        });
      } catch (err) {
        console.error("[pet] load failed", err);
      }
    })();

    // --- procedural bones ---------------------------------------------------
    const PROC_BONES: VRMHumanBoneName[] = ["head", "neck", "upperChest", "chest", "spine", "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm"];
    const qTmp = new THREE.Quaternion();
    const eTmp = new THREE.Euler();
    const bone = (n: VRMHumanBoneName) => vrm?.humanoid.getNormalizedBoneNode(n) ?? null;
    const addRot = (n: VRMHumanBoneName, x: number, y: number, z: number) => {
      const b = bone(n);
      if (!b) return;
      eTmp.set(x * mirror, y, z * mirror, "YXZ");
      b.quaternion.multiply(qTmp.setFromEuler(eTmp));
    };
    const lookTarget = new THREE.Vector3();

    const setExpr = (n: string, v: number) => {
      if (available.has(n)) vrm?.expressionManager?.setValue(n, v);
    };

    // --- strolls ---------------------------------------------------------------

    /** Walk clip's sideways foot speed on screen at timeScale 1 (logical px/s). */
    const naturalWalkPx = () => {
      const fovRad = (camera.fov * Math.PI) / 180;
      const dist = camera.position.distanceTo(camTarget);
      const pxPerMetre = (el.clientHeight || 580) / (2 * dist * Math.tan(fovRad / 2));
      // Fallback: a calm female walk covers ≈ 0.7 body-heights/s.
      const mps = walkGait > 0 ? walkGait : modelHeight * 0.7;
      return mps * pxPerMetre;
    };

    const startIdle = (dwell: number) => {
      activity = "idle";
      actUntil = t + dwell;
      if (!shot && !transition && posture === "stand" && current !== idleKey()) crossfade(idleKey(), 0.6);
      if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.6);
    };

    const fullIdle = () => {
      strollsInRow = 0;
      const next = pickIdleBase(loadedClips, effMood() === "happy");
      if (next !== idleBase) {
        idleBase = next;
        if (next === "happyIdle") ensureClip("happyIdle");
      }
      startIdle(randIn(ROAM_PROFILES[roamAmountRef.current].idleDwell));
    };

    const strollInterrupted = () => {
      const m = effMood();
      const emotional = m === "happy" || m === "annoyed" || m === "sad" || m === "confused" || m === "error";
      return (
        m === "speaking" ||
        m === "listening" ||
        m === "thinking" ||
        m === "sleeping" ||
        !!flashReq ||
        !roamAllowedRef.current ||
        roamAmountRef.current === "off" ||
        pendingCue !== null ||
        reactKeyRef.current !== lastReactKey ||
        (m !== lastMood && emotional)
      );
    };

    const beginStroll = (opts: { icon?: boolean; forced?: Stroll["forced"]; pounce?: boolean } = {}) => {
      const driver = roamDriverRef.current?.current;
      if (!driver || !actions.walk || posture !== "stand") return false;
      const s: Stroll = {
        phase: "measure",
        phaseAt: t,
        phaseUntil: t + 3,
        dir: 1,
        motion: null,
        yaw: 0,
        timeScale: 0.6,
        cruise: 0,
        pos: 0,
        vel: 0,
        stopFromVel: 0,
        interrupted: false,
        dropped: false,
        fadedOut: false,
        pounce: !!opts.pounce,
        forced: opts.forced,
      };
      stroll = s;
      activity = opts.icon ? "visitIcon" : "stroll";
      void (async () => {
        let room: Awaited<ReturnType<RoamDriver["begin"]>> = null;
        try {
          room = await driver.begin();
        } catch {
          room = null;
        }
        const release = () => {
          if (room) driver.end();
        };
        if (s.dropped || disposed || stroll !== s) {
          release();
          return;
        }
        const amount = roamAmountRef.current;
        let plan: { dir: 1 | -1; distance: number } | null = null;
        if (room && !s.interrupted) {
          if (s.forced) plan = s.forced;
          else if (opts.icon) {
            const visit = await visitDesktopIcon(room.centerX ?? 0, room, amount);
            if (visit) {
              plan = { dir: visit.dir, distance: visit.distance };
              s.pounce = visit.action === "pounce";
            }
          } else plan = planStroll(amount, room);
        }
        if (!plan || s.dropped || stroll !== s) {
          release();
          if (stroll === s) {
            stroll = null;
            fullIdle();
          }
          return;
        }
        const prof = ROAM_PROFILES[amount === "off" ? "calm" : amount];
        const gait = solveGait(prof.cruiseSpeed, naturalWalkPx(), prof.targetTimeScale);
        s.dir = plan.dir;
        s.motion = makeStrollMotion(plan.distance, prof.cruiseSpeed, prof.rampTime);
        s.cruise = prof.cruiseSpeed;
        s.yaw = gait.yaw;
        s.timeScale = gait.timeScale;
        s.phase = "turn";
        s.phaseAt = t;
        bodyTurn.set(s.dir * s.yaw, t, STROLL_TIMING.turn);
      })();
      return true;
    };

    const setWalkRate = (s: Stroll, vel: number) => {
      const a = actions.walk;
      if (!a) return;
      // Feet planted: clip rate tracks actual speed through the ease-in/out.
      a.timeScale = Math.max(0.12, s.timeScale * (vel / Math.max(1, s.cruise)));
    };

    const finishStroll = (s: Stroll) => {
      stroll = null;
      strollsInRow += 1;
      if (!s.interrupted && !s.pounce && shouldChainStroll(roamAmountRef.current, strollsInRow)) {
        forceStrollNext = true;
        startIdle(randIn(ROAM_PROFILES[roamAmountRef.current].chainDwell));
      } else {
        fullIdle();
      }
    };

    /** Advance the stroll choreography: turn → beat → walk → (pounce) → beat → turn back. */
    const advanceStroll = (s: Stroll, dt: number) => {
      const driver = roamDriverRef.current?.current ?? null;
      if (!s.interrupted && strollInterrupted()) {
        s.interrupted = true;
        if (s.phase === "measure") {
          s.dropped = true;
          stroll = null;
          fullIdle();
          return;
        }
        if (s.phase === "turn" || s.phase === "prePause") {
          s.phase = "turnBack";
          s.phaseAt = t;
          bodyTurn.set(0, t, STROLL_TIMING.turn);
        } else if (s.phase === "walk") {
          s.phase = "stopping";
          s.phaseAt = t;
          s.stopFromVel = s.vel;
        } else if (s.phase === "postPause") {
          s.phaseUntil = t;
        }
      }
      switch (s.phase) {
        case "measure":
          if (t > s.phaseUntil) {
            s.dropped = true;
            stroll = null;
            fullIdle();
          }
          return;
        case "turn":
          if (bodyTurn.done(t)) {
            s.phase = "prePause";
            s.phaseAt = t;
            s.phaseUntil = t + randIn(STROLL_TIMING.prePause);
          }
          return;
        case "prePause":
          if (t >= s.phaseUntil && s.motion) {
            s.phase = "walk";
            s.phaseAt = t;
            setWalkRate(s, 0);
            crossfade("walk", STROLL_TIMING.crossfade);
          }
          return;
        case "walk": {
          const m = s.motion!;
          const el2 = t - s.phaseAt;
          const smp = m.sample(el2);
          s.pos = smp.pos;
          s.vel = smp.vel;
          driver?.moveTo(s.dir * s.pos);
          setWalkRate(s, s.vel);
          if (!s.fadedOut && m.duration - el2 <= STROLL_TIMING.crossfade) {
            s.fadedOut = true;
            crossfade(idleKey(), STROLL_TIMING.crossfade);
          }
          if (el2 >= m.duration) {
            driver?.end();
            const jumpKey: ClipKey | null = actions.joyJump ? "joyJump" : actions.jump ? "jump" : null;
            if (s.pounce && jumpKey && startShot(jumpKey, { fadeIn: 0.3 })) {
              s.phase = "pounce";
            } else {
              s.phase = "postPause";
              s.phaseUntil = t + randIn(STROLL_TIMING.postPause);
            }
            s.phaseAt = t;
          }
          return;
        }
        case "stopping": {
          const u = (t - s.phaseAt) / STROLL_TIMING.abortRamp;
          s.vel = s.stopFromVel * (1 - Math.min(1, u * u * (3 - 2 * u)));
          s.pos += s.vel * dt;
          driver?.moveTo(s.dir * s.pos);
          setWalkRate(s, s.vel);
          if (!s.fadedOut) {
            s.fadedOut = true;
            crossfade(idleKey(), STROLL_TIMING.abortRamp);
          }
          if (u >= 1) {
            driver?.end();
            s.phase = "postPause";
            s.phaseAt = t;
            s.phaseUntil = t + 0.25;
          }
          return;
        }
        case "pounce":
          if (!shot || t >= shot.end - shot.fadeOut) {
            endShot(0.5);
            s.phase = "postPause";
            s.phaseAt = t;
            s.phaseUntil = t + randIn(STROLL_TIMING.postPause);
          }
          return;
        case "postPause":
          if (t >= s.phaseUntil) {
            s.phase = "turnBack";
            s.phaseAt = t;
            bodyTurn.set(0, t, STROLL_TIMING.turn);
          }
          return;
        case "turnBack":
          if (bodyTurn.done(t)) finishStroll(s);
          return;
      }
    };

    // --- activities --------------------------------------------------------------
    const startActivity = (next: ActivityId) => {
      if (VARIATIONS.has(next)) lastVariation = next;
      switch (next) {
        case "stroll":
          if (beginStroll()) return;
          fullIdle();
          return;
        case "visitIcon":
          if (beginStroll({ icon: true })) return;
          fullIdle();
          return;
        case "lookAround":
          activity = "lookAround";
          glanceSide *= -1;
          if (playShot("look", { fadeIn: 0.6, fadeOut: 0.6, interruptible: true })) {
            actUntil = shot!.end;
          } else {
            actUntil = t + activityDuration("lookAround"); // procedural head scan
          }
          return;
        case "stretch":
          if (!playShot("stretch", { fadeIn: 0.6, fadeOut: 0.7, interruptible: true })) {
            fullIdle();
            return;
          }
          activity = "stretch";
          actUntil = shot!.end;
          return;
        case "turn": {
          activity = "turn";
          const d = activityDuration("turn");
          actUntil = t + d;
          turnBackAt = t + d - 0.7;
          glanceSide *= -1;
          bodyTurn.set(glanceSide * rand(0.22, 0.4), t, 0.7);
          return;
        }
        case "hop":
          if (!playShot("jump", { fadeIn: 0.35 })) {
            fullIdle();
            return;
          }
          activity = "hop";
          actUntil = shot!.end;
          return;
        case "sit":
          if (!sitDown()) {
            fullIdle();
            return;
          }
          activity = "sit";
          actUntil = t + 2.3 + activityDuration("sit");
          return;
        default:
          fullIdle();
      }
    };

    // --- behaviour tick (own clock, independent of React) -----------------------
    const updateBehaviour = (dt: number) => {
      const m = effMood();
      const engaged = m === "speaking" || m === "listening" || m === "thinking";
      const near = cursorNear();
      const hover = hovering();
      if (engaged || hover || near) lastInteractT = t;

      // Incoming app cues (once per id, even across model swaps).
      const c = cueRef.current;
      if (c && c.id > lastHandledCue) {
        lastHandledCue = c.id;
        queueCue(c.kind);
      }
      if (greetAt > 0 && t >= greetAt) {
        greetAt = -1;
        queueCue("wave");
      }
      // Flash requests (once per key, even across the model swap the app does first).
      const fk = flashKeyRef.current;
      if (fk > lastHandledFlash) {
        lastHandledFlash = fk;
        if (flashRef.current && flashTop && flashTop.mode !== "none") {
          flashReq = { at: t };
          lastInteractT = t;
        }
      }
      if (flashWasOn && !flashRef.current) coverUp();
      flashWasOn = flashRef.current;
      if (flashReq && t - flashReq.at > CUE_TTL) flashReq = null;

      if (pendingCue) {
        // Time spent finishing a stroll / getting up / a non-yielding shot doesn't count.
        if (stroll || transition || flashReq || flashAct || (shot && !shot.interruptible)) pendingCue.at = Math.max(pendingCue.at, t - CUE_TTL + 3);
        else if (t - pendingCue.at > CUE_TTL) pendingCue = null;
      }

      // A stroll always finishes gracefully (eases to a stop, turns back) first.
      if (stroll) {
        advanceStroll(stroll, dt);
        if (stroll) return;
      }
      // Posture transitions run to completion.
      if (transition) {
        if (t < transition.end) return;
        const tr = transition;
        transition = null;
        tr.onDone?.();
        if (transition) return;
      }
      // Flash: stop and stand first (strolls ease out via strollInterrupted, she
      // stands up / gets up), then the pull-up runs to completion uninterrupted.
      // Models whose licence disallows sexual use (or with no separate top) never flash.
      if (flashReq && (!flashTop || flashTop.mode === "none")) flashReq = null;
      if (flashReq && !flashAct) {
        const prep = flashPrep({ posture, strolling: !!stroll, transition: !!transition });
        if (prep === "standUp") standUp();
        else if (prep === "getUp") getUp();
        if (prep !== "ready") return;
        flashReq.at = t;
        if (shot) endShot(0.35);
        shot = null;
        mode = "react";
        modeUntil = t + FLASH_DURATION;
        if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.35);
        crossfade(idleKey(), 0.35);
        flashAct = { start: t, covered: false };
        flashReq = null;
        activity = "idle";
        actUntil = t + FLASH_DURATION + rand(4, 8);
        return;
      }
      if (flashAct) {
        if (t - flashAct.start < FLASH_DURATION) return;
        flashAct = null;
        lastInteractT = t;
        enterMode("react", 0.6);
      }
      // One-shots: settle back when done; idle variations yield to the user.
      if (shot) {
        const yieldNow = shot.interruptible && (engaged || hover || near || pendingCue || m === "sleeping" || reactKeyRef.current !== lastReactKey);
        if (t >= shot.end - shot.fadeOut || yieldNow) endShot(yieldNow ? 0.5 : shot.fadeOut);
        else return;
      }
      if (activity === "turn" && t >= turnBackAt && Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.7);

      // Sleep (app inactivity timer) → lie down (sitting first), wake → get up + small stretch.
      if (m === "sleeping" && !engaged) {
        if (mode !== "sleep") {
          enterMode("sleep", 1e9);
          pendingCue = null;
          if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 1.0);
          lieDown();
          if (!transition && posture === "stand") crossfade(idleKey(), 1.2);
        }
        return;
      }
      if (mode === "sleep") {
        enterMode("react", 0.5);
        reactFrom = t;
        lastMood = m;
        activity = "idle";
        actUntil = t + rand(6, 10);
        getUp(() => {
          const busy = effMood() === "speaking" || effMood() === "listening" || effMood() === "thinking";
          // A queued greeting (user came back) follows a shorter stretch.
          if (!busy) startShot("stretch", { fadeIn: 0.6, fadeOut: 0.8, maxDur: pendingCue ? 2.6 : 3.8, timeScale: 1.1, interruptible: !pendingCue });
        });
        return;
      }

      // Seated: hovering / clicking / talking / a gesture → stand up smoothly first.
      const poked = reactKeyRef.current !== lastReactKey;
      const emotional = m === "happy" || m === "annoyed" || m === "sad" || m === "confused" || m === "error";
      const moodChanged = m !== lastMood;
      if (posture === "sit" && (engaged || hover || poked || pendingCue || (moodChanged && emotional))) {
        activity = "idle";
        actUntil = t + rand(6, 10);
        standUp();
        return;
      }
      if (posture === "lie") {
        getUp();
        return;
      }

      // Gesture cue (wave / kiss / jumps).
      if (pendingCue) {
        const k = gestureClip(pendingCue.kind);
        if (actions[k]) {
          if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.4);
          if (startShot(k, { fadeIn: 0.4, fadeOut: 0.5 })) {
            if (pendingCue.kind === "wave") lastWaveAt = t;
            lastInteractT = t;
            pendingCue = null;
            return;
          }
        } else if (failedClips.has(k)) {
          // Fallbacks: a missing jump becomes a kiss/wave if those exist.
          const alt: GestureKind | null = k === "joyJump" ? "kiss" : k === "kiss" ? "wave" : null;
          pendingCue = alt ? { kind: alt, at: pendingCue.at } : null;
        }
        // else: still loading → wait (TTL above).
      }

      // Reactions: explicit poke (wave hello, else a nod), or an emotional mood change.
      if (poked || (moodChanged && emotional)) {
        lastReactKey = reactKeyRef.current;
        lastMood = m;
        lastInteractT = t;
        enterMode("react", 1.8);
        reactFrom = t;
        if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.5);
        if (poked && t - lastWaveAt > WAVE_COOLDOWN) queueCue("wave");
        return;
      }
      lastMood = m;

      if (mode === "react" && t < modeUntil) return;

      if (engaged || near) {
        if (mode !== "attend") {
          enterMode("attend", 2);
          if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.5);
        }
        modeUntil = t + 2;
        if (m === "thinking") ensureClip("think");
        const want = baseClip();
        if (current !== want) crossfade(want, 0.5);
        return;
      }

      if (mode !== "activity") {
        // Back to her own business: settle for a while first (a seated break carries on).
        mode = "activity";
        if (posture === "sit") actUntil = Math.max(actUntil, t + rand(4, 9));
        else startIdle(rand(4, 9));
        if (current !== baseClip()) settleBase(0.6);
        return;
      }

      if (t < actUntil) return;

      // Activity finished → tidy up, then pick the next one.
      if (posture === "sit") {
        standUp(() => fullIdle());
        return;
      }
      if (activity !== "idle") {
        fullIdle();
        return;
      }
      const amount = roamAmountRef.current;
      const canMove = roamAllowedRef.current && amount !== "off" && !!roamDriverRef.current?.current && !!actions.walk;
      if (forceStrollNext) {
        forceStrollNext = false;
        if (canMove) {
          startActivity("stroll");
          return;
        }
        strollsInRow = 0;
      }
      startActivity(
        pickActivity({
          amount,
          clips: loadedClips,
          canMove,
          strollsInRow,
          lastVariation,
          idleFor: t - lastInteractT,
          playful: playfulRef.current,
        }),
      );
    };

    const updateTalkLayer = (dt: number) => {
      const speaking = effMood() === "speaking";
      if (speaking) ensureClip("talk");
      const a = actions.talk;
      if (!a) return;
      const want = speaking && posture === "stand" && !transition && !stroll && !shot && !flashAct ? 1 : 0;
      talkW = damp(talkW, want, want ? 2.5 : 3.5, dt);
      if (talkW > 0.01) {
        if (!a.isRunning()) a.reset().play();
        a.setEffectiveWeight(talkW * TALK_LAYER_WEIGHT);
      } else if (a.isRunning()) {
        a.stop();
        talkW = 0;
      }
    };

    const applyProcedural = (dt: number) => {
      if (!vrm) return;
      const m = effMood();
      const engaged = m === "speaking" || m === "listening" || m === "thinking";
      const sleeping = mode === "sleep";
      const walking = !!stroll && stroll.phase !== "measure";
      const lie = lieTween.update(t);
      sleepBlend = damp(sleepBlend, sleeping ? 1 : 0, 1.5, dt);
      // Head droop only when there's no lying clip carrying the sleep pose.
      const droop = sleepBlend * (1 - lie);

      // Target look (yaw/pitch, radians) from cursor relative to her head.
      let tYaw = 0;
      let tPitch = 0;
      const headX = cursor.width * 0.5;
      const headY = cursor.height * (posture === "sit" ? 0.4 : 0.22);
      const dx = cursor.x - headX;
      const dy = cursor.y - headY;
      const own = mode === "activity";
      const follow = (mode === "attend" ? 1 : walking || sleeping || transition ? 0 : 0.45) * (1 - lie);
      if (follow > 0 && t - cursor.movedAt < 8) {
        tYaw = clamp(Math.atan2(dx, 700), -0.75, 0.75) * follow;
        tPitch = clamp(Math.atan2(dy, 900), -0.35, 0.45) * follow;
      }
      if (walking && stroll) {
        // Glance where she's heading (the body is only turned ~3/4).
        tYaw += stroll.dir * 0.22;
        tPitch += 0.04;
      } else if (own && activity === "lookAround" && !shot) {
        // Procedural look-around when the clip is missing (slow, unhurried).
        tYaw += Math.sin((t - actUntil) * 0.9) * 0.4 * glanceSide;
        tPitch += Math.sin(t * 0.31) * 0.05;
      } else if (own && follow < 1 && !shot && posture === "stand") {
        tYaw += Math.sin(t * 0.22) * 0.1 * glanceSide;
      }
      if (m === "thinking" && !actions.think) {
        tYaw += -0.25;
        tPitch += -0.15;
      }

      // React: quick nod + tilt (procedural; gestures are clips).
      let nod = 0;
      let tilt = 0;
      const rt = t - reactFrom;
      if (mode === "react" && rt < 1.8 && !shot) {
        const env = Math.sin(Math.min(1, rt / 1.8) * Math.PI);
        nod = Math.sin(rt * 9) * 0.08 * env;
        tilt = 0.12 * env * (m === "confused" ? 1.6 : 1);
      }
      if (m === "confused") tilt += 0.1;
      if (m === "listening") tilt += 0.06;

      lookYaw = damp(lookYaw, tYaw, 3.5, dt);
      lookPitch = damp(lookPitch, tPitch, 3.5, dt);

      const sleepPitch = 0.38 * droop;
      const breathRate = sleeping ? 0.9 : engaged ? 1.9 : 1.5;
      const breath = Math.sin(t * breathRate * Math.PI * 0.5);

      addRot("neck", lookPitch * 0.4 + sleepPitch * 0.5, lookYaw * 0.4, tilt * 0.4);
      addRot("head", lookPitch * 0.6 + nod + sleepPitch * 0.5, lookYaw * 0.6, tilt * 0.6);
      addRot("upperChest", breath * 0.008, lookYaw * 0.12, 0);
      addRot("chest", breath * 0.006 + droop * 0.08, 0, 0);

      // No idle clip at all → don't T-pose: arms down, relaxed elbows.
      if (!actions.idle && current !== "walk") {
        addRot("leftUpperArm", 0, 0, -1.2 + breath * 0.01);
        addRot("rightUpperArm", 0, 0, 1.2 - breath * 0.01);
        addRot("leftLowerArm", 0, -0.15, 0);
        addRot("rightLowerArm", 0, 0.15, 0);
      }

      // Body turn: eased deliberate turns (stroll heading / turn-in-place) plus a
      // slow drift toward the cursor when standing; lying turns her side-on.
      const standing = posture === "stand" && !transition && !sleeping;
      driftYaw = damp(driftYaw, stroll || !standing ? 0 : lookYaw * 0.2 + Math.sin(t * 0.18) * 0.04, 2, dt);
      const lieYaw = lie * lieSide * (Math.PI / 2);
      root.rotation.set(0, bodyTurn.update(t) + driftYaw + lieYaw, 0);
      if (lie !== lastLie) {
        lastLie = lie;
        root.position.set(-lieCenterZ * Math.sin(lieYaw), lieDrop * lie, 0);
        const h = modelHeight;
        const zoom = 1 + LIE_ZOOM * lie;
        camera.position.set(0, h * (0.58 - 0.18 * lie), h * 2.05 * zoom);
        camTarget.set(0, h * (0.48 - 0.24 * lie), 0);
        camera.lookAt(camTarget);
      }

      // Eyes.
      const headNode = bone("head");
      if (headNode && vrm.lookAt) {
        headNode.getWorldPosition(lookTarget);
        lookTarget.x += Math.sin(lookYaw * 1.3) * 1.5;
        lookTarget.y -= Math.sin(lookPitch * 1.3) * 1.5;
        lookTarget.z += 1.5;
        vrm.lookAt.lookAt(lookTarget);
      }
    };

    /** "Cover up": lower from wherever the hem is now (never a snap); cancel a queued flash. */
    function coverUp() {
      flashReq = null;
      if (flashAct && !flashAct.covered) {
        flashAct.covered = true;
        flashAct.start = t - flashCoverUpElapsed(t - flashAct.start);
      }
    }

    const applyFlash = () => {
      if (!vrm || !flashTop) return;
      if (!flashAct || !flashRig) {
        if (flashRaise !== 0) flashTop.setLift(0);
        flashRaise = 0;
        return;
      }
      const f = flashFrame(t - flashAct.start);
      // The top follows where the hands actually are.
      flashRaise = flashRig.apply(f, t, mirror);
      flashTop.setLift(flashRaise);
    };

    const applyExpressions = (dt: number) => {
      if (!vrm?.expressionManager) return;
      const m = effMood();
      const target = moodExpressions(mode === "sleep" ? "sleeping" : m, flashRef.current);
      if (shot?.key === "kiss" || shot?.key === "joyJump") target.happy = Math.max(target.happy ?? 0, 0.5);
      const ff = flashAct ? flashFrame(t - flashAct.start) : null;
      if (ff) {
        // Playful: a cheeky smile as she reaches, full grin + giggle while it's up.
        target.happy = Math.max(target.happy ?? 0, 0.35 + 0.45 * ff.raise);
        target.relaxed = 0.15 * (1 - ff.raise);
        target.surprised = 0;
        target.angry = 0;
        target.sad = 0;
      }
      for (const [n, v] of Object.entries(target)) {
        expr[n] = damp(expr[n] ?? 0, v, 4, dt);
        setExpr(n, expr[n]);
      }
      // Blink (eyes stay shut while asleep).
      if (t > nextBlink) {
        blinkUntil = t + 0.1;
        nextBlink = t + 1.8 + Math.random() * 3.4;
      }
      setExpr("blink", Math.max(t < blinkUntil ? 1 : 0, sleepBlend));
      // Talking mouth driven by speaking state.
      const talking = m === "speaking";
      // Giggle: short mouth bursts through the hold.
      const giggle = ff && ff.hold > 0 ? Math.max(0, Math.sin(ff.hold * Math.PI * 7)) * 0.32 * Math.sin(ff.hold * Math.PI) : 0;
      const mouth = Math.max(giggle, talking ? 0.12 + Math.abs(Math.sin(t * 9.5)) * 0.38 * (0.75 + 0.25 * Math.sin(t * 2.3)) : 0);
      expr.aa = damp(expr.aa ?? 0, mouth, 18, dt);
      setExpr("aa", expr.aa);
      expr.oh = damp(expr.oh ?? 0, talking ? Math.max(0, Math.sin(t * 4.1)) * 0.18 : 0, 12, dt);
      setExpr("oh", expr.oh);
    };

    // --- render loop: capped fps, paused when hidden/minimized ---------------
    const clock = new THREE.Clock();
    const frameInterval = 1 / TARGET_FPS;
    let acc = 0;
    const step = (dt: number) => {
      t += dt;
      if (vrm && mixer && ready) {
        updateBehaviour(dt);
        updateTalkLayer(dt);
        // Reset procedural bones to rest so clip tracks (or nothing) define the base pose.
        for (const n of PROC_BONES) bone(n)?.quaternion.identity();
        mixer.update(dt);
        applyProcedural(dt);
        applyFlash();
        applyExpressions(dt);
        vrm.update(dt);
      }
    };
    const tick = () => {
      frame = requestAnimationFrame(tick);
      acc += clock.getDelta();
      if (acc < frameInterval - 0.002) return;
      const dt = Math.min(acc, 0.1);
      acc = 0;
      step(dt);
      renderer.render(scene, camera);
    };

    const start = () => {
      if (disposed || !paused) return;
      paused = false;
      clock.getDelta(); // drop the time spent hidden
      acc = 0;
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (paused) return;
      paused = true;
      cancelAnimationFrame(frame);
    };
    paused = true;
    start();

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    // Minimized / hidden-to-tray windows don't always flip document.hidden in WebView2.
    let visTimer = 0;
    const checkWindow = async () => {
      try {
        const w = getCurrentWindow();
        const [min, vis] = await Promise.all([w.isMinimized(), w.isVisible()]);
        if (min || !vis || document.hidden) stop();
        else start();
      } catch {
        // browser preview
      }
      if (!disposed) visTimer = window.setTimeout(() => void checkWindow(), 2000);
    };
    void checkWindow();

    // DEV-only hooks for the headless clip/state check (tree-shaken from release builds).
    if (import.meta.env.DEV) {
      const fakeDriver: RoamDriver = {
        begin: async () => ({ left: 600, right: 600, centerX: 800 }),
        moveTo: () => undefined,
        end: () => undefined,
      };
      const dbg = {
        state: () => ({
          ready,
          t: +t.toFixed(2),
          mode,
          posture,
          activity,
          current,
          shot: shot?.key ?? null,
          transition: transition?.kind ?? null,
          stroll: stroll?.phase ?? null,
          talkW: +talkW.toFixed(2),
          lie: +lieTween.value.toFixed(2),
          loaded: [...loadedClips],
          failed: [...failedClips],
          walkGait: +walkGait.toFixed(3),
          gait: solveGait(ROAM_PROFILES.calm.cruiseSpeed, naturalWalkPx(), ROAM_PROFILES.calm.targetTimeScale),
          naturalWalkPx: +naturalWalkPx().toFixed(1),
        }),
        /** Live pose sanity: NaN / explosion / T-pose, root-local, relative to model height. */
        pose: () => {
          if (!vrm) return null;
          const hp = new THREE.Vector3();
          vrm.humanoid.getRawBoneNode("hips")!.getWorldPosition(hp);
          let maxDist = 0;
          let nan = false;
          const v = new THREE.Vector3();
          for (const n of PROBE_BONES) {
            const node = vrm.humanoid.getRawBoneNode(n);
            if (!node) continue;
            node.getWorldPosition(v);
            if (!Number.isFinite(v.x + v.y + v.z)) nan = true;
            maxDist = Math.max(maxDist, v.distanceTo(hp));
          }
          return { nan, maxDist: +(maxDist / modelHeight).toFixed(2), hipsY: +(hp.y / modelHeight).toFixed(2) };
        },
        mood: (mm: PetMood | null) => (debugMood = mm),
        roam: (a: RoamAmount | null) => {
          debugRoam = a;
          roamAmountRef.current = a ?? roamAmount;
          roamAllowedRef.current = a !== null || roamAllowed;
        },
        cue: (k: GestureKind) => queueCue(k),
        /** Play the flash move (bypasses the app; the model must support it). */
        flash: () => {
          flashReq = { at: t };
          return flashTop ? { mode: flashTop.mode, reason: flashTop.reason, tops: flashTop.topNames } : null;
        },
        coverUp: () => coverUp(),
        flashState: () => ({
          mode: flashTop?.mode ?? null,
          req: !!flashReq,
          phase: flashAct ? flashFrame(t - flashAct.start).phase : null,
          elapsed: flashAct ? +(t - flashAct.start).toFixed(2) : null,
          raise: +flashRaise.toFixed(3),
          lift: +(flashTop?.lift ?? 0).toFixed(3),
          posture,
          stroll: stroll?.phase ?? null,
        }),
        /** Turn her (radians) — side views for the headless check. */
        yaw: (r: number) => bodyTurn.set(r, t, 0.01),
        /** Force posture for prep checks. */
        sit: () => sitDown(),
        activity: (a: ActivityId) => {
          if (a === "stroll" || a === "visitIcon") roamDriverRef.current = { current: fakeDriver };
          startActivity(a);
        },
        pounce: (distance = 160) => {
          roamDriverRef.current = { current: fakeDriver };
          return beginStroll({ forced: { dir: 1, distance }, pounce: true });
        },
        load: async () => {
          for (const k of CLIP_KEYS) ensureClip(k);
          await Promise.all([...loading.values()]);
          return { loaded: [...loadedClips], failed: [...failedClips] };
        },
        /** Fast-forward the simulation (no rendering) by `sec` seconds. */
        advance: (sec: number) => {
          const n = Math.ceil(sec * TARGET_FPS);
          for (let i = 0; i < n; i++) step(1 / TARGET_FPS);
          renderer.render(scene, camera);
        },
        pauseLoop: () => stop(),
        canvas: () => renderer.domElement,
      };
      (window as unknown as { __petDebug?: typeof dbg }).__petDebug = dbg;
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(cursorTimer);
      window.clearTimeout(visTimer);
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      if (stroll) {
        stroll.dropped = true;
        if (stroll.phase !== "measure") roamDriverRef.current?.current?.end();
        stroll = null;
      }
      if (mixer) {
        mixer.stopAllAction();
        for (const a of Object.values(actions)) if (a) mixer.uncacheClip(a.getClip());
        if (vrm) mixer.uncacheRoot(vrm.scene);
      }
      vrmRef.current = null;
      if (vrm) {
        root.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
      }
      renderer.dispose();
      if (renderer.domElement.parentElement === el) el.removeChild(renderer.domElement);
    };
  }, [modelUrl]);

  return (
    <div
      ref={mountRef}
      className={className ?? "pet-3d"}
      data-pet-vrm={PET_VRM_VERSION}
      aria-hidden
    />
  );
}
