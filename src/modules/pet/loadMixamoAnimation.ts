import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { mixamoVRMRigMap } from "./mixamoVRMRigMap";

/**
 * How to treat the hips (root) translation of a clip:
 *  - "keep":    as authored (in-place idles, jumps — the hop must leave the floor)
 *  - "detrend": remove linear horizontal drift, keep sway (walks: the window carries her)
 *  - "pin":     hold horizontal position at frame 0 (Mixamo sit/stand transitions slide the
 *               hips ~48 cm and their loop partner starts from a different origin)
 */
export type RootMode = "keep" | "detrend" | "pin";

export interface MixamoLoadOptions {
  root?: RootMode;
  /** Keep only these VRM bones (e.g. an upper-body layer for Talking). */
  onlyBones?: ReadonlySet<string>;
  /** Measure the walk's ground speed (stance-foot speed) for foot-locking. */
  measureGait?: boolean;
}

/** VRM metres / s the clip's planted foot travels (walk clips); 0 = unknown. */
const gaitSpeeds = new WeakMap<THREE.AnimationClip, number>();

export function clipGaitSpeed(clip: THREE.AnimationClip): number {
  return gaitSpeeds.get(clip) ?? 0;
}

/** Upper-body VRM bones (spine and up, arms, hands, fingers) for layered clips. */
export const UPPER_BODY_BONES: ReadonlySet<string> = new Set(
  Object.values(mixamoVRMRigMap).filter((b) => !/hips|UpperLeg|LowerLeg|Foot|Toes/.test(b)),
);

function fixRootTrack(track: THREE.VectorKeyframeTrack, mode: RootMode) {
  if (mode === "keep") return;
  const v = track.values;
  const times = track.times;
  const n = times.length;
  if (n < 2) return;
  const t0 = times[0]!;
  const span = times[n - 1]! - t0;
  const x0 = v[0]!;
  const z0 = v[2]!;
  const dx = v[(n - 1) * 3]! - x0;
  const dz = v[(n - 1) * 3 + 2]! - z0;
  for (let i = 0; i < n; i++) {
    const u = span > 0 ? (times[i]! - t0) / span : 0;
    v[i * 3] = v[i * 3]! - dx * u;
    v[i * 3 + 2] = mode === "pin" ? z0 : v[i * 3 + 2]! - dz * u;
  }
}

/**
 * Ground speed of a walk in source units/s: median backward speed of whichever
 * toe is planted, relative to the hips. Works for root-motion and In-Place
 * exports alike (Walking.fbx: 8.74 vs root 8.67 units/s).
 */
function measureStanceSpeed(asset: THREE.Group, clip: THREE.AnimationClip): number {
  const hips = asset.getObjectByName("mixamorigHips") ?? asset.getObjectByName("mixamorig:Hips");
  const toes = ["LeftToeBase", "RightToeBase"]
    .map((n) => asset.getObjectByName(`mixamorig${n}`) ?? asset.getObjectByName(`mixamorig:${n}`))
    .filter((o): o is THREE.Object3D => !!o);
  if (!hips || toes.length !== 2 || clip.duration <= 0) return 0;
  const mixer = new THREE.AnimationMixer(asset);
  mixer.clipAction(clip).play();
  const N = 120;
  const dt = clip.duration / N;
  const h = new THREE.Vector3();
  const w = new THREE.Vector3();
  const rows: { y: number; z: number }[][] = [];
  for (let i = 0; i <= N; i++) {
    mixer.setTime(i * dt);
    asset.updateMatrixWorld(true);
    hips.getWorldPosition(h);
    rows.push(toes.map((tt) => (tt.getWorldPosition(w), { y: w.y, z: w.z - h.z })));
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(asset);
  let minY = Infinity;
  for (const r of rows) for (const s of r) minY = Math.min(minY, s.y);
  const tol = Math.abs(hips.position.y) * 0.03;
  const speeds: number[] = [];
  for (let k = 0; k < 2; k++) {
    for (let i = 1; i <= N; i++) {
      const a = rows[i - 1]![k]!;
      const b = rows[i]![k]!;
      if (b.y < minY + tol) speeds.push(-(b.z - a.z) / dt);
    }
  }
  if (speeds.length < 4) return 0;
  speeds.sort((a, b) => a - b);
  return Math.abs(speeds[Math.floor(speeds.length / 2)]!);
}

/** Load a Mixamo FBX and retarget it onto a VRM humanoid (official three-vrm method). */
export async function loadMixamoAnimation(
  url: string,
  vrm: VRM,
  opts: MixamoLoadOptions = {},
): Promise<THREE.AnimationClip> {
  const loader = new FBXLoader();
  const asset = await loader.loadAsync(url);
  const clip =
    THREE.AnimationClip.findByName(asset.animations, "mixamo.com") ?? asset.animations[0];
  if (!clip) throw new Error(`No animation clip in ${url}`);

  const tracks: THREE.KeyframeTrack[] = [];
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const _quatA = new THREE.Quaternion();

  const hips =
    asset.getObjectByName("mixamorigHips") ?? asset.getObjectByName("mixamorig:Hips");
  if (!hips) throw new Error("FBX is not a Mixamo rig (missing mixamorigHips)");

  // Rest pose height, read before any sampling moves the bones.
  const motionHipsHeight = hips.position.y;
  const vrmHipsY = vrm.humanoid.normalizedRestPose.hips?.position?.[1];
  if (vrmHipsY == null || !motionHipsHeight) {
    throw new Error("Could not scale hips height for Mixamo retarget");
  }
  const hipsPositionScale = vrmHipsY / motionHipsHeight;
  const vrm0 = vrm.meta?.metaVersion === "0";

  // Rest rotations must be captured before measureStanceSpeed() poses the rig.
  const rest = new Map<string, { inv: THREE.Quaternion; parent: THREE.Quaternion }>();
  asset.updateMatrixWorld(true);
  asset.traverse((o) => {
    if (!o.parent) return;
    rest.set(o.name, {
      inv: o.getWorldQuaternion(new THREE.Quaternion()).invert(),
      parent: o.parent.getWorldQuaternion(new THREE.Quaternion()),
    });
  });
  const stance = opts.measureGait ? measureStanceSpeed(asset, clip) : 0;

  for (const track of clip.tracks) {
    const [mixamoRigName, propertyName] = track.name.split(".");
    const mappedName = (mixamoRigName ?? "").replace(/^mixamorig:/, "mixamorig");
    const vrmBoneName = mixamoVRMRigMap[mappedName];
    if (!vrmBoneName || !propertyName) continue;
    if (opts.onlyBones && !opts.onlyBones.has(vrmBoneName)) continue;

    const vrmNodeName = vrm.humanoid.getNormalizedBoneNode(vrmBoneName as VRMHumanBoneName)?.name;
    const r = rest.get(mixamoRigName ?? "") ?? rest.get(mappedName);
    if (!vrmNodeName || !r) continue;
    restRotationInverse.copy(r.inv);
    parentRestWorldRotation.copy(r.parent);

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        const flat = values.slice(i, i + 4);
        _quatA.fromArray(flat);
        _quatA.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        _quatA.toArray(flat);
        for (let j = 0; j < 4; j++) values[i + j] = flat[j]!;
      }
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${vrmNodeName}.${propertyName}`,
          track.times,
          values.map((v, i) => (vrm0 && i % 2 === 0 ? -v : v)),
        ),
      );
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      if (vrmBoneName !== "hips" || propertyName !== "position") continue; // only the root translates
      const values = track.values.map((v, i) => (vrm0 && i % 3 !== 1 ? -v : v) * hipsPositionScale);
      const out = new THREE.VectorKeyframeTrack(`${vrmNodeName}.${propertyName}`, track.times, values);
      fixRootTrack(out, opts.root ?? "keep");
      tracks.push(out);
    }
  }

  if (tracks.length === 0) throw new Error(`Retarget produced 0 tracks for ${url}`);
  const result = new THREE.AnimationClip(url.split("/").pop() ?? "vrmAnimation", clip.duration, tracks);
  if (stance > 0) gaitSpeeds.set(result, stance * Math.abs(hipsPositionScale));
  return result;
}
