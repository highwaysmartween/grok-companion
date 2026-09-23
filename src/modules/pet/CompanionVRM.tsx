import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { VRM } from "@pixiv/three-vrm";
import type { PetMood } from "../../types";
import { loadMixamoAnimation } from "./loadMixamoAnimation";

interface Props {
  mood: PetMood;
  className?: string;
  modelUrl?: string;
  /** When true, hide CLOTH materials so the nude/lingerie body shows. */
  flash?: boolean;
  /**
   * Fired when a roam walk segment starts/ends so the host can move the
   * transparent Tauri window across the desktop (CompanionVRM itself only
   * plays the walk clip + facing).
   */
  onWalkStart?: (opts: { facing: 1 | -1; durationMs: number }) => void;
  onWalkEnd?: () => void;
}

const ANIM = {
  idle: "/animations/Happy_Idle.fbx",
  idleFallback: "/animations/Idle.fbx",
  look: "/animations/Looking_Around.fbx",
  walk: "/animations/Walking.fbx",
  wave: "/animations/Waving.fbx",
  talk: "/animations/Talking_2.fbx",
  think: "/animations/Thinking.fbx",
} as const;

export const PET_VRM_VERSION = 16;

type ClipKey = "idle" | "look" | "walk" | "wave" | "talk" | "think";

const CLOTH_RE =
  /CLOTH|SHOES|SOCK|ONEPIECE|TOPS|BOTTOMS|SKIRT|BRA|PANTY|LINGERIE|BIKINI|SWIM|UNDERWEAR|下着|服|靴|衣装|パンツ|ブラ/i;
const KEEP_BODY_RE = /FACE|BODY|SKIN|HAIR|EYE|TOOTH|MOUTH|NAIL|舌|肌|髪|顔/i;

function hideMat(mat: THREE.Material, visible: boolean) {
  mat.visible = visible;
  mat.transparent = !visible || mat.transparent;
  (mat as THREE.MeshBasicMaterial).opacity = visible ? 1 : 0;
  mat.depthWrite = visible;
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

async function tryLoadClip(url: string, vrm: VRM): Promise<THREE.AnimationClip | null> {
  try {
    return await loadMixamoAnimation(url, vrm);
  } catch (err) {
    console.warn("[pet] clip load failed", url, err);
    return null;
  }
}

/**
 * VRM + Mixamo clips. Roams the desktop regularly (walk clip + window move via
 * onWalkStart). Clean neutral lighting (no muddy tone mapping).
 *
 * FLASH HONESTY:
 * There is NO dedicated Flash.fbx / strip / topless Mixamo clip in
 * public/animations/. A true "pull up top / flash breasts" needs a custom
 * VRMA or Mixamo FBX (e.g. public/animations/Flash.fbx) authored in Blender
 * or Mixamo with arms lifting the garment. Until that file exists we
 * APPROXIMATE: play Waving / Talking_2 / Looking_Around (best upper-body
 * arm motion available) + hard-hide CLOTH + happy expression + spoken line.
 * TODO(user): drop a Flash.fbx (or Flash.vrma) into public/animations/ and
 * wire it as ANIM.flash — do not claim a real flash clip exists until then.
 */
export function CompanionVRM({
  mood,
  className,
  modelUrl = "/models/companion.vrm",
  flash = false,
  onWalkStart,
  onWalkEnd,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const moodRef = useRef(mood);
  const flashRef = useRef(flash);
  const vrmRef = useRef<VRM | null>(null);
  const onWalkStartRef = useRef(onWalkStart);
  const onWalkEndRef = useRef(onWalkEnd);
  const prevFlashRef = useRef(false); // false so mount-with-flash (r18 switch) still fires gesture
  const flashGestureRef = useRef(false);
  moodRef.current = mood;
  flashRef.current = flash;
  onWalkStartRef.current = onWalkStart;
  onWalkEndRef.current = onWalkEnd;

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
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio || 1, 1), 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Keep NoToneMapping + neutral white lights — ACES / warm/cheek/rim muddied skins brown
    renderer.toneMapping = THREE.NoToneMapping;
    el.appendChild(renderer.domElement);

    const maxAniso = Math.min(renderer.capabilities.getMaxAnisotropy?.() ?? 4, 8);

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
    let current: ClipKey = "idle";
    let frame = 0;
    let disposed = false;
    let blinkUntil = 0;
    let nextBlink = 1.5;
    let modeUntil = 2 + Math.random() * 4;
    let lookSide = 1;
    let facing: 1 | -1 = 1;
    let walkNotified = false;

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
      if (to === current && actions[to]?.isRunning()) return;
      const next = actions[to];
      if (!next) return;
      const prev = actions[current];
      next.reset().setEffectiveWeight(1).fadeIn(fade).play();
      if (prev && prev !== next) prev.fadeOut(fade);
      current = to;
    };

    const playOnce = (key: ClipKey, then: ClipKey = "idle") => {
      const act = actions[key];
      if (!act) {
        crossfade(then);
        return;
      }
      act.reset();
      act.setLoop(THREE.LoopOnce, 1);
      act.clampWhenFinished = true;
      crossfade(key, 0.25);
      const onFinished = (e: { action: THREE.AnimationAction }) => {
        if (e.action !== act) return;
        mixer?.removeEventListener("finished", onFinished);
        act.setLoop(THREE.LoopRepeat, Infinity);
        crossfade(then, 0.35);
      };
      mixer?.addEventListener("finished", onFinished);
    };

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
        }
        loaded.scene.traverse((o) => {
          o.frustumCulled = false;
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) {
            if (!mat) continue;
            const m = mat as THREE.MeshStandardMaterial;
            for (const texKey of [
              "map",
              "normalMap",
              "roughnessMap",
              "metalnessMap",
              "emissiveMap",
              "aoMap",
            ] as const) {
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
        camera.position.set(0, h * 0.58, h * 2.05);
        camera.lookAt(0, h * 0.48, 0);
        camera.updateProjectionMatrix();

        root.add(loaded.scene);
        vrm = loaded;
        vrmRef.current = loaded;
        setClothVisible(loaded.scene, !flashRef.current);
        mixer = new THREE.AnimationMixer(loaded.scene);

        const [idleClip, lookClip, walkClip, waveClip, talkClip, thinkClip] =
          await Promise.all([
            (async () =>
              (await tryLoadClip(ANIM.idle, loaded)) ??
              (await tryLoadClip(ANIM.idleFallback, loaded)))(),
            tryLoadClip(ANIM.look, loaded),
            tryLoadClip(ANIM.walk, loaded),
            tryLoadClip(ANIM.wave, loaded),
            tryLoadClip(ANIM.talk, loaded),
            tryLoadClip(ANIM.think, loaded),
          ]);
        if (disposed || !mixer) return;

        const bind = (key: ClipKey, clip: THREE.AnimationClip | null, loop: boolean) => {
          if (!clip || !mixer) return;
          const a = mixer.clipAction(clip);
          a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
          actions[key] = a;
        };
        bind("idle", idleClip, true);
        bind("look", lookClip, true);
        bind("walk", walkClip, true);
        bind("wave", waveClip, false);
        bind("talk", talkClip, true);
        bind("think", thinkClip, true);

        if (actions.idle) {
          actions.idle.play();
          current = "idle";
        } else if (actions.look) {
          actions.look.play();
          current = "look";
        }
        console.info("[pet] ready v", PET_VRM_VERSION, modelUrl, Object.keys(actions));
        if (flashRef.current) flashGestureRef.current = true;
      } catch (err) {
        console.error("[pet] load failed", err);
      }
    })();

    const clock = new THREE.Clock();
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const m = moodRef.current;

      if (vrm && mixer) {
        // One-shot flash gesture approximation (no Flash.fbx on disk).
        if (flashGestureRef.current) {
          flashGestureRef.current = false;
          const gesture: ClipKey = actions.wave
            ? "wave"
            : actions.talk
              ? "talk"
              : actions.look
                ? "look"
                : "idle";
          if (current === "walk" && walkNotified) {
            walkNotified = false;
            onWalkEndRef.current?.();
          }
          playOnce(gesture, "idle");
          modeUntil = t + 3.5;
        }

        const engaged = m === "speaking" || m === "listening" || m === "thinking";

        if (t > modeUntil && !flashGestureRef.current) {
          if (current === "walk") {
            crossfade(actions.look ? "look" : "idle");
            if (walkNotified) {
              walkNotified = false;
              onWalkEndRef.current?.();
            }
            // Idle / look-around dwell 8–20s between strolls
            modeUntil = t + 8 + Math.random() * 12;
            lookSide *= -1;
          } else if (engaged) {
            if (m === "speaking" && actions.talk) crossfade("talk");
            else if (m === "thinking" && actions.think) crossfade("think");
            else crossfade(actions.look ? "look" : "idle");
            if (walkNotified) {
              walkNotified = false;
              onWalkEndRef.current?.();
            }
            modeUntil = t + 1.2;
          } else {
            // Regular desktop roam: walk often (override old rare-stroll pref)
            const roll = Math.random();
            if (roll < 0.55 && actions.walk) {
              facing = (Math.random() < 0.5 ? 1 : -1) as 1 | -1;
              const durationMs = 3000 + Math.floor(Math.random() * 3000); // 3–6s
              crossfade("walk");
              walkNotified = true;
              onWalkStartRef.current?.({ facing, durationMs });
              modeUntil = t + durationMs / 1000;
            } else if (roll < 0.7 && actions.wave) {
              playOnce("wave", actions.look ? "look" : "idle");
              modeUntil = t + 4 + Math.random() * 3;
            } else if (actions.look) {
              crossfade("look");
              modeUntil = t + 6 + Math.random() * 8;
              lookSide *= -1;
            } else {
              crossfade("idle");
              modeUntil = t + 8 + Math.random() * 8;
            }
          }
        } else if (engaged && current === "walk") {
          // Interrupt roam when user engages
          crossfade(
            m === "speaking" && actions.talk
              ? "talk"
              : m === "thinking" && actions.think
                ? "think"
                : actions.look
                  ? "look"
                  : "idle",
          );
          if (walkNotified) {
            walkNotified = false;
            onWalkEndRef.current?.();
          }
          modeUntil = t + 1.5;
        } else if (engaged) {
          // Keep mood clip sticky while speaking/listening/thinking
          if (m === "speaking" && actions.talk && current !== "talk" && current !== "wave") {
            crossfade("talk");
          } else if (m === "thinking" && actions.think && current !== "think") {
            crossfade("think");
          }
        }

        mixer.update(dt);
        vrm.update(dt);

        if (t > nextBlink) {
          blinkUntil = t + 0.09;
          nextBlink = t + 1.8 + Math.random() * 3.2;
        }
        const em = vrm.expressionManager;
        if (em) {
          em.setValue("blink", t < blinkUntil ? 1 : 0);
          const happyBase =
            m === "happy" || flashRef.current ? 0.58 : m === "speaking" ? 0.4 : 0.28;
          em.setValue("happy", happyBase);
          em.setValue("aa", m === "speaking" ? 0.18 + Math.abs(Math.sin(t * 9)) * 0.4 : 0);
          em.setValue("surprised", m === "listening" ? 0.12 : flashRef.current ? 0.08 : 0);
          em.setValue("angry", 0);
          em.setValue("sad", 0);
        }

        // Face roam direction while walking; soft sway + glance when idle
        if (current === "walk") {
          root.rotation.set(0, facing > 0 ? 0.55 : -0.55, 0);
          vrm.lookAt?.lookAt(new THREE.Vector3(facing * 0.6, 1.05, 1.0));
        } else {
          const sway = Math.sin(t * 0.35) * 0.04;
          root.rotation.set(0, Math.sin(t * 0.18) * 0.08 + sway, sway * 0.3);
          const glanceX =
            engaged ? 0 : Math.sin(t * 0.22) * 0.28 * lookSide;
          vrm.lookAt?.lookAt(new THREE.Vector3(glanceX, 1.05, engaged ? 1.6 : 1.2));
        }
      }

      camera.up.set(0, 1, 0);
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      if (walkNotified) onWalkEndRef.current?.();
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
