import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PetMood } from "../../types";
import { clipRootSpeed, loadMixamoAnimation } from "./loadMixamoAnimation";
import {
  ROAM_PROFILES,
  STROLL_TIMING,
  Tween,
  activityDuration,
  makeStrollMotion,
  pickActivity,
  planStroll,
  rand,
  randIn,
  shouldChainStroll,
  solveGait,
  type ActivityId,
  type ClipKey,
  type RoamAmount,
  type RoamDriver,
  type StrollMotion,
} from "./behaviour";

interface Props {
  mood: PetMood;
  className?: string;
  modelUrl?: string;
  /** When true, hide CLOTH materials so the nude/lingerie body shows. */
  flash?: boolean;
  /** How much she wanders. "off" = never walks (idle / look / turn still run). */
  roamAmount?: RoamAmount;
  /** Strolls allowed right now (not paused by hover / chat / tray). */
  roamAllowed?: boolean;
  /** Bump to trigger a one-shot reaction (wave / nod). */
  reactKey?: number;
  /** Host that moves the transparent Tauri window during a stroll. */
  roamDriver?: MutableRefObject<RoamDriver | null>;
}

/**
 * Clips. Only Idle.fbx + Walking.fbx ship today; everything else is optional and
 * picked up automatically if dropped into public/animations/ later. Missing clips
 * fall back to procedural motion (look-at, breathing, nods, sleep pose).
 */
const ANIM: Record<ClipKey, readonly string[]> = {
  idle: ["/animations/Happy_Idle.fbx", "/animations/Idle.fbx"],
  look: ["/animations/Looking_Around.fbx"],
  walk: ["/animations/Walking.fbx"],
  wave: ["/animations/Waving.fbx"],
  talk: ["/animations/Talking_2.fbx"],
  think: ["/animations/Thinking.fbx"],
  sit: ["/animations/Sitting.fbx"],
  sleep: ["/animations/Sleeping.fbx"],
  stretch: ["/animations/Stretch.fbx", "/animations/Stretching.fbx"],
  jump: ["/animations/Jump.fbx"],
  pounce: ["/animations/Pounce.fbx"],
};
/** Clips that play once (everything else loops). */
const ONE_SHOT: ReadonlySet<ClipKey> = new Set<ClipKey>(["wave", "stretch", "jump", "pounce"]);
/** Clips whose root motion is pinned so the window (not the clip) carries her. */
const IN_PLACE: ReadonlySet<ClipKey> = new Set<ClipKey>(["walk", "jump", "pounce"]);

export const PET_VRM_VERSION = 18;

/** Reactive modes override the self-directed activity loop (see behaviour.ts). */
type Mode = "activity" | "attend" | "react" | "sleep";
type StrollPhase = "measure" | "turn" | "prePause" | "walk" | "stopping" | "postPause" | "turnBack";
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
}

/** Lightweight rendering for Iris Xe-class GPUs. */
const TARGET_FPS = 30;
const MAX_PIXEL_RATIO = 1.25;
const CURSOR_POLL_MS = 100;
const CURSOR_POLL_SLEEP_MS = 500;
/** Cursor counts as "near" within this many px of the window edge. */
const NEAR_PX = 140;

const CLOTH_RE =
  /CLOTH|SHOES|SOCK|ONEPIECE|TOPS|BOTTOMS|SKIRT|BRA|PANTY|LINGERIE|BIKINI|SWIM|UNDERWEAR|下着|服|靴|衣装|パンツ|ブラ/i;
const KEEP_BODY_RE = /FACE|BODY|SKIN|HAIR|EYE|TOOTH|MOUTH|NAIL|舌|肌|髪|顔/i;

type MatState = { visible: boolean; transparent: boolean; opacity: number; depthWrite: boolean };

/** Hide/show a material, remembering its original state so "cover up" restores it exactly. */
function hideMat(mat: THREE.Material, visible: boolean) {
  const ud = mat.userData as { __petOrig?: MatState };
  if (!ud.__petOrig) {
    ud.__petOrig = {
      visible: mat.visible,
      transparent: mat.transparent,
      opacity: (mat as THREE.MeshBasicMaterial).opacity ?? 1,
      depthWrite: mat.depthWrite,
    };
  }
  const o = ud.__petOrig;
  if (visible) {
    mat.visible = o.visible;
    mat.transparent = o.transparent;
    (mat as THREE.MeshBasicMaterial).opacity = o.opacity;
    mat.depthWrite = o.depthWrite;
  } else {
    mat.visible = false;
  }
  mat.needsUpdate = true;
}

/** Hide cloth meshes/materials. Body/face/hair stay. */
function setClothVisible(root: THREE.Object3D, visible: boolean) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const meshName = mesh.name || "";
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const nameHit = CLOTH_RE.test(meshName) && !KEEP_BODY_RE.test(meshName);
    if (nameHit) {
      mesh.visible = visible;
      for (const mat of mats) if (mat) hideMat(mat, visible);
      return;
    }
    for (const mat of mats) {
      if (!mat?.name || !CLOTH_RE.test(mat.name)) continue;
      if (KEEP_BODY_RE.test(mat.name)) continue;
      hideMat(mat, visible);
    }
  });
}

async function tryLoadClip(urls: readonly string[], vrm: VRM, inPlace: boolean): Promise<THREE.AnimationClip | null> {
  for (const url of urls) {
    try {
      return await loadMixamoAnimation(url, vrm, { inPlace });
    } catch {
      // Missing / not-a-Mixamo file → next candidate, then procedural fallback.
    }
  }
  return null;
}

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

/**
 * VRM + Mixamo clips + procedural life layer:
 *  - behaviour: reactive modes (attend / react / sleep) over a calm activity
 *    loop (idle / look-around / turn / stroll …) defined in behaviour.ts
 *  - head/neck/chest look-at that follows the global cursor
 *  - breathing + weight shift, mood → expressions, talking mouth
 * Clean neutral lighting: NoToneMapping + white lights (no ACES, no warm/cheek/rim hacks).
 */
export function CompanionVRM({
  mood,
  className,
  modelUrl = "/models/companion.vrm",
  flash = false,
  roamAmount = "calm",
  roamAllowed = true,
  reactKey = 0,
  roamDriver,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const moodRef = useRef(mood);
  const flashRef = useRef(flash);
  const roamAmountRef = useRef(roamAmount);
  const roamAllowedRef = useRef(roamAllowed);
  const reactKeyRef = useRef(reactKey);
  const vrmRef = useRef<VRM | null>(null);
  const roamDriverRef = useRef(roamDriver);
  const prevFlashRef = useRef(false); // false so mount-with-flash (r18 switch) still fires gesture
  const flashGestureRef = useRef(false);
  moodRef.current = mood;
  flashRef.current = flash;
  roamAmountRef.current = roamAmount;
  roamAllowedRef.current = roamAllowed;
  reactKeyRef.current = reactKey;
  roamDriverRef.current = roamDriver;

  useEffect(() => {
    const v = vrmRef.current;
    if (!v) return;
    setClothVisible(v.scene, !flash);
    // Rising edge → request a one-shot upper-body gesture (approximation).
    if (flash && !prevFlashRef.current) flashGestureRef.current = true;
    prevFlashRef.current = flash;
  }, [flash]);

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
    let current: ClipKey | null = null;
    let frame = 0;
    let disposed = false;
    let paused = false;
    let mirror = 1; // VRM0 normalized rig: x/z rotations flip sign
    const available = new Set<string>();
    const loadedClips = new Set<ClipKey>();
    /** Walking.fbx root travel before pinning (VRM m/s); drives foot-locking. */
    let walkRootSpeed = 0;

    // --- behaviour state ---------------------------------------------------
    let t = 0;
    let mode: Mode = "activity";
    let modeUntil = 0;
    let activity: ActivityId = "idle";
    let actUntil = rand(8, 14);
    let turnBackAt = 0;
    let strollsInRow = 0;
    let forceStrollNext = false;
    let stroll: Stroll | null = null;
    /** Body yaw from deliberate turns (stroll heading, turn-in-place). */
    const bodyTurn = new Tween();
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

    const crossfade = (to: ClipKey, fade = 0.35) => {
      const next = actions[to];
      if (!next) return false;
      if (to === current && next.isRunning()) return true;
      const prev = current ? actions[current] : undefined;
      next.reset().setEffectiveWeight(1).fadeIn(fade).play();
      if (prev && prev !== next) prev.fadeOut(fade);
      current = to;
      return true;
    };

    const playOnce = (k: ClipKey, then: ClipKey = "idle") => {
      const act = actions[k];
      if (!act) {
        crossfade(then);
        return false;
      }
      act.reset();
      act.setLoop(THREE.LoopOnce, 1);
      act.clampWhenFinished = true;
      crossfade(k, 0.25);
      const onFinished = (e: { action: THREE.AnimationAction }) => {
        if (e.action !== act) return;
        mixer?.removeEventListener("finished", onFinished);
        act.setLoop(THREE.LoopRepeat, Infinity);
        if (current === k) crossfade(actions[then] ? then : "idle", 0.35);
      };
      mixer?.addEventListener("finished", onFinished);
      return true;
    };

    const enterMode = (next: Mode, duration: number) => {
      mode = next;
      modeUntil = t + duration;
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

    // --- load model + clips --------------------------------------------------
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
        setClothVisible(loaded.scene, !flashRef.current);
        mixer = new THREE.AnimationMixer(loaded.scene);

        const em = loaded.expressionManager;
        for (const n of ["happy", "relaxed", "sad", "angry", "surprised", "aa", "oh", "ih", "blink"]) {
          if (em?.getExpression(n)) available.add(n);
        }

        const keys = Object.keys(ANIM) as ClipKey[];
        const clips = await Promise.all(keys.map((k) => tryLoadClip(ANIM[k], loaded, IN_PLACE.has(k))));
        if (disposed || !mixer) return;
        keys.forEach((k, i) => {
          const clip = clips[i];
          if (!clip || !mixer) return;
          const a = mixer.clipAction(clip);
          const loop = !ONE_SHOT.has(k);
          a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
          if (k === "walk") walkRootSpeed = clipRootSpeed(clip);
          actions[k] = a;
          loadedClips.add(k);
        });

        if (actions.idle) crossfade("idle", 0.01);
        else if (actions.look) crossfade("look", 0.01);
        console.info("[pet] ready v", PET_VRM_VERSION, modelUrl, "clips:", Object.keys(actions), "expr:", [...available]);
        if (flashRef.current) flashGestureRef.current = true;
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

    // --- behaviour (runs on its own clock, independent of React) ------------

    /** Walk clip's sideways foot speed on screen at timeScale 1 (logical px/s). */
    const naturalWalkPx = () => {
      const fovRad = (camera.fov * Math.PI) / 180;
      const dist = camera.position.distanceTo(camTarget);
      const pxPerMetre = (el.clientHeight || 580) / (2 * dist * Math.tan(fovRad / 2));
      // Mixamo Walking ≈ 1.1 body-heights/s if the clip had no measurable root motion.
      const mps = walkRootSpeed > 0 ? walkRootSpeed : modelHeight * 1.1;
      return mps * pxPerMetre;
    };

    const startIdle = (dwell: number) => {
      activity = "idle";
      actUntil = t + dwell;
      if (current !== "idle" && current !== "wave") crossfade("idle", 0.6);
      if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.6);
    };

    const fullIdle = () => {
      strollsInRow = 0;
      startIdle(randIn(ROAM_PROFILES[roamAmountRef.current].idleDwell));
    };

    const strollInterrupted = () => {
      const m = moodRef.current;
      const emotional = m === "happy" || m === "annoyed" || m === "sad" || m === "confused" || m === "error";
      return (
        m === "speaking" ||
        m === "listening" ||
        m === "thinking" ||
        m === "sleeping" ||
        !roamAllowedRef.current ||
        roamAmountRef.current === "off" ||
        flashGestureRef.current ||
        reactKeyRef.current !== lastReactKey ||
        (m !== lastMood && emotional)
      );
    };

    const beginStroll = () => {
      const driver = roamDriverRef.current?.current;
      if (!driver || !actions.walk) return false;
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
      };
      stroll = s;
      activity = "stroll";
      void driver.begin().then(
        (room) => {
          if (s.dropped || disposed || stroll !== s) {
            if (room) driver.end();
            return;
          }
          const amount = roamAmountRef.current;
          const plan = room && !s.interrupted ? planStroll(amount, room) : null;
          if (!plan) {
            if (room) driver.end();
            stroll = null;
            fullIdle();
            return;
          }
          const prof = ROAM_PROFILES[amount];
          const gait = solveGait(prof.cruiseSpeed, naturalWalkPx(), prof.targetTimeScale);
          s.dir = plan.dir;
          s.motion = makeStrollMotion(plan.distance, prof.cruiseSpeed, prof.rampTime);
          s.cruise = prof.cruiseSpeed;
          s.yaw = gait.yaw;
          s.timeScale = gait.timeScale;
          s.phase = "turn";
          s.phaseAt = t;
          bodyTurn.set(s.dir * s.yaw, t, STROLL_TIMING.turn);
        },
        () => {
          if (stroll === s) {
            stroll = null;
            fullIdle();
          }
        },
      );
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
      if (!s.interrupted && shouldChainStroll(roamAmountRef.current, strollsInRow)) {
        forceStrollNext = true;
        startIdle(randIn(ROAM_PROFILES[roamAmountRef.current].chainDwell));
      } else {
        fullIdle();
      }
    };

    /** Advance the stroll choreography: turn → beat → walk → beat → turn back. */
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
            crossfade("idle", STROLL_TIMING.crossfade);
          }
          if (el2 >= m.duration) {
            driver?.end();
            s.phase = "postPause";
            s.phaseAt = t;
            s.phaseUntil = t + randIn(STROLL_TIMING.postPause);
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
            crossfade("idle", STROLL_TIMING.abortRamp);
          }
          if (u >= 1) {
            driver?.end();
            s.phase = "postPause";
            s.phaseAt = t;
            s.phaseUntil = t + 0.25;
          }
          return;
        }
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

    const startActivity = (next: ActivityId) => {
      switch (next) {
        case "stroll":
          if (beginStroll()) return;
          fullIdle();
          return;
        case "lookAround":
          activity = "lookAround";
          actUntil = t + activityDuration("lookAround");
          glanceSide *= -1;
          if (actions.look) crossfade("look", 0.6);
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
        case "stretch":
        case "hop": {
          const key: ClipKey = next === "stretch" ? "stretch" : actions.pounce && Math.random() < 0.5 ? "pounce" : "jump";
          const act = actions[key];
          if (!act || !playOnce(key, "idle")) {
            fullIdle();
            return;
          }
          activity = next;
          actUntil = t + act.getClip().duration + 0.4;
          return;
        }
        case "sit":
          if (!crossfade("sit", 0.8)) {
            fullIdle();
            return;
          }
          activity = "sit";
          actUntil = t + activityDuration("sit");
          return;
        case "visitIcon":
          // TODO(visit-icon): run visitDesktopIcon() (behaviour.ts) once icon positions exist.
          fullIdle();
          return;
        default:
          startIdle(randIn(ROAM_PROFILES[roamAmountRef.current].idleDwell));
      }
    };

    const updateBehaviour = (dt: number) => {
      const m = moodRef.current;
      const engaged = m === "speaking" || m === "listening" || m === "thinking";
      const near = cursorNear();

      // A stroll always finishes gracefully (eases to a stop, turns back) before
      // anything else takes over — no snapping mid-step.
      if (stroll) {
        advanceStroll(stroll, dt);
        if (stroll) return;
      }
      if (activity === "turn" && t >= turnBackAt && Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.7);

      if (flashGestureRef.current) {
        flashGestureRef.current = false;
        enterMode("react", 3.5);
        reactFrom = t;
        if (!playOnce("wave", "idle")) {
          if (!crossfade("talk")) crossfade("idle");
        }
        return;
      }

      // Reactions: explicit poke, or an emotional mood change.
      const moodChanged = m !== lastMood;
      const emotional = m === "happy" || m === "annoyed" || m === "sad" || m === "confused" || m === "error";
      if (reactKeyRef.current !== lastReactKey || (moodChanged && emotional && mode !== "sleep")) {
        lastReactKey = reactKeyRef.current;
        lastMood = m;
        enterMode("react", 1.8);
        reactFrom = t;
        if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.5);
        if (m === "happy" || !moodChanged) playOnce("wave", "idle");
        return;
      }
      lastMood = m;

      if (m === "sleeping" && !engaged) {
        if (mode !== "sleep") {
          enterMode("sleep", 1e9);
          if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 1.2);
          if (!crossfade("sleep", 1.2)) if (!crossfade("sit", 1.2)) crossfade("idle", 1.2);
        }
        return;
      }
      if (mode === "sleep") {
        // Woke up: a little nod, then attentive.
        enterMode("react", 1.6);
        reactFrom = t;
        crossfade("idle", 0.8);
        return;
      }

      if (mode === "react" && t < modeUntil) return;

      if (engaged || near) {
        if (mode !== "attend") {
          enterMode("attend", 2);
          if (Math.abs(bodyTurn.target) > 1e-3) bodyTurn.set(0, t, 0.5);
        }
        modeUntil = t + 2;
        const want: ClipKey = m === "speaking" && actions.talk ? "talk" : m === "thinking" && actions.think ? "think" : "idle";
        if (current !== want && current !== "wave") crossfade(want, 0.5);
        return;
      }

      if (mode !== "activity") {
        // Back to her own business: settle for a while first.
        mode = "activity";
        startIdle(rand(4, 9));
        return;
      }

      if (t < actUntil) return;

      // Activity finished → tidy up, then pick the next one.
      if (activity === "sit" || activity === "lookAround") crossfade("idle", 0.8);
      if (activity !== "idle") {
        startIdle(randIn(ROAM_PROFILES[roamAmountRef.current].idleDwell));
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
      startActivity(pickActivity({ amount, clips: loadedClips, canMove, strollsInRow }));
    };

    const applyProcedural = (dt: number) => {
      if (!vrm) return;
      const m = moodRef.current;
      const engaged = m === "speaking" || m === "listening" || m === "thinking";
      const sleeping = mode === "sleep";
      const walking = !!stroll && stroll.phase !== "measure";
      sleepBlend = damp(sleepBlend, sleeping ? 1 : 0, 1.5, dt);

      // Target look (yaw/pitch, radians) from cursor relative to her head.
      let tYaw = 0;
      let tPitch = 0;
      const headX = cursor.width * 0.5;
      const headY = cursor.height * 0.22;
      const dx = cursor.x - headX;
      const dy = cursor.y - headY;
      const own = mode === "activity";
      const follow = mode === "attend" ? 1 : walking || sleeping ? 0 : 0.45;
      if (follow > 0 && t - cursor.movedAt < 8) {
        tYaw = clamp(Math.atan2(dx, 700), -0.75, 0.75) * follow;
        tPitch = clamp(Math.atan2(dy, 900), -0.35, 0.45) * follow;
      }
      if (walking && stroll) {
        // Glance where she's heading (the body is only turned ~3/4).
        tYaw += stroll.dir * 0.22;
        tPitch += 0.04;
      } else if (own && activity === "lookAround" && !actions.look) {
        // Procedural look-around when the clip is missing (slow, unhurried).
        tYaw += Math.sin((t - actUntil) * 0.9) * 0.4 * glanceSide;
        tPitch += Math.sin(t * 0.31) * 0.05;
      } else if (own && follow < 1) {
        tYaw += Math.sin(t * 0.22) * 0.1 * glanceSide;
      }
      if (m === "thinking") {
        tYaw += -0.25;
        tPitch += -0.15;
      }

      // React: quick nod + tilt when there's no Waving clip carrying it.
      let nod = 0;
      let tilt = 0;
      const rt = t - reactFrom;
      if (mode === "react" && rt < 1.8) {
        const env = Math.sin(Math.min(1, rt / 1.8) * Math.PI);
        nod = Math.sin(rt * 9) * 0.08 * env;
        tilt = 0.12 * env * (m === "confused" ? 1.6 : 1);
      }
      if (m === "confused") tilt += 0.1;
      if (m === "listening") tilt += 0.06;

      lookYaw = damp(lookYaw, tYaw, 3.5, dt);
      lookPitch = damp(lookPitch, tPitch, 3.5, dt);

      // Sleep pose: head down, slow breath.
      const sleepPitch = 0.38 * sleepBlend;
      const breathRate = sleeping ? 0.9 : engaged ? 1.9 : 1.5;
      const breath = Math.sin(t * breathRate * Math.PI * 0.5);

      addRot("neck", lookPitch * 0.4 + sleepPitch * 0.5, lookYaw * 0.4, tilt * 0.4);
      addRot("head", lookPitch * 0.6 + nod + sleepPitch * 0.5, lookYaw * 0.6, tilt * 0.6);
      addRot("upperChest", breath * 0.012, lookYaw * 0.12, 0);
      addRot("chest", breath * 0.01 + sleepBlend * 0.08, 0, 0);
      // Weight shift.
      addRot("spine", 0, 0, Math.sin(t * 0.45) * 0.02 * (1 - sleepBlend));

      // No idle clip at all → don't T-pose: arms down, relaxed elbows.
      if (!actions.idle && !actions.look && current !== "walk") {
        addRot("leftUpperArm", 0, 0, -1.2 + breath * 0.01);
        addRot("rightUpperArm", 0, 0, 1.2 - breath * 0.01);
        addRot("leftLowerArm", 0, -0.15, 0);
        addRot("rightLowerArm", 0, 0.15, 0);
      }

      // Body turn: eased deliberate turns (stroll heading / turn-in-place) plus
      // a slow drift toward the cursor when standing.
      driftYaw = damp(driftYaw, stroll || sleeping ? 0 : lookYaw * 0.2 + Math.sin(t * 0.18) * 0.04, 2, dt);
      root.rotation.set(0, bodyTurn.update(t) + driftYaw, 0);

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

    const applyExpressions = (dt: number) => {
      if (!vrm?.expressionManager) return;
      const m = moodRef.current;
      const target = moodExpressions(mode === "sleep" ? "sleeping" : m, flashRef.current);
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
      const mouth = talking ? 0.12 + Math.abs(Math.sin(t * 9.5)) * 0.38 * (0.75 + 0.25 * Math.sin(t * 2.3)) : 0;
      expr.aa = damp(expr.aa ?? 0, mouth, 18, dt);
      setExpr("aa", expr.aa);
      expr.oh = damp(expr.oh ?? 0, talking ? Math.max(0, Math.sin(t * 4.1)) * 0.18 : 0, 12, dt);
      setExpr("oh", expr.oh);
    };

    // --- render loop: capped fps, paused when hidden/minimized ---------------
    const clock = new THREE.Clock();
    const frameInterval = 1 / TARGET_FPS;
    let acc = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      acc += clock.getDelta();
      if (acc < frameInterval - 0.002) return;
      const dt = Math.min(acc, 0.1);
      acc = 0;
      t += dt;

      if (vrm && mixer) {
        updateBehaviour(dt);
        // Reset procedural bones to rest so clip tracks (or nothing) define the base pose.
        for (const n of PROC_BONES) bone(n)?.quaternion.identity();
        mixer.update(dt);
        applyProcedural(dt);
        applyExpressions(dt);
        vrm.update(dt);
      }
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
      mixer?.stopAllAction();
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
