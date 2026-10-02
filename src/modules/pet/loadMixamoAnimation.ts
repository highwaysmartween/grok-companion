import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { VRM } from "@pixiv/three-vrm";
import { mixamoVRMRigMap } from "./mixamoVRMRigMap";

/** Root-motion speed (VRM metres / s) measured before a clip was made in-place. */
const rootSpeeds = new WeakMap<THREE.AnimationClip, number>();

/** Horizontal speed the clip's root travelled before it was pinned in place (m/s, 0 if none). */
export function clipRootSpeed(clip: THREE.AnimationClip): number {
  return rootSpeeds.get(clip) ?? 0;
}

/**
 * Remove the linear horizontal drift from a hips position track so the clip
 * plays in place (Mixamo "Walking" without "In Place" travels ~9 units per
 * cycle and then snaps back — that loop-jump is what made her lurch). Keeps
 * the natural sway / bob. Returns the drift speed in source units per second.
 */
function pinRootInPlace(track: THREE.VectorKeyframeTrack): number {
  const v = track.values;
  const times = track.times;
  const n = times.length;
  if (n < 2) return 0;
  const t0 = times[0]!;
  const span = times[n - 1]! - t0;
  if (span <= 0) return 0;
  const dx = v[(n - 1) * 3]! - v[0]!;
  const dz = v[(n - 1) * 3 + 2]! - v[2]!;
  for (let i = 0; i < n; i++) {
    const u = (times[i]! - t0) / span;
    v[i * 3] = v[i * 3]! - dx * u;
    v[i * 3 + 2] = v[i * 3 + 2]! - dz * u;
  }
  return Math.hypot(dx, dz) / span;
}

/** Load a Mixamo FBX and retarget it onto a VRM humanoid (official three-vrm method). */
export async function loadMixamoAnimation(
  url: string,
  vrm: VRM,
  opts: { inPlace?: boolean } = {},
): Promise<THREE.AnimationClip> {
  const loader = new FBXLoader();
  const asset = await loader.loadAsync(url);
  const clip =
    THREE.AnimationClip.findByName(asset.animations, "mixamo.com") ?? asset.animations[0];
  if (!clip) throw new Error(`No animation clip in ${url}`);

  const tracks: THREE.KeyframeTrack[] = [];
  let rootSpeed = 0;
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const _quatA = new THREE.Quaternion();

  const hips =
    asset.getObjectByName("mixamorigHips") ?? asset.getObjectByName("mixamorig:Hips");
  if (!hips) throw new Error("FBX is not a Mixamo rig (missing mixamorigHips)");

  const motionHipsHeight = hips.position.y;
  const vrmHipsY = vrm.humanoid.normalizedRestPose.hips?.position?.[1];
  if (vrmHipsY == null || !motionHipsHeight) {
    throw new Error("Could not scale hips height for Mixamo retarget");
  }
  const hipsPositionScale = vrmHipsY / motionHipsHeight;

  for (const track of clip.tracks) {
    const [mixamoRigName, propertyName] = track.name.split(".");
    const mappedName = (mixamoRigName ?? "").replace(/^mixamorig:/, "mixamorig");
    const vrmBoneName = mixamoVRMRigMap[mappedName];
    if (!vrmBoneName || !propertyName) continue;

    const vrmNodeName = vrm.humanoid.getNormalizedBoneNode(vrmBoneName as never)?.name;
    const mixamoRigNode =
      asset.getObjectByName(mixamoRigName) ?? asset.getObjectByName(mappedName);
    if (!vrmNodeName || !mixamoRigNode?.parent) continue;

    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
    mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);

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
          values.map((v, i) => (vrm.meta?.metaVersion === "0" && i % 2 === 0 ? -v : v)),
        ),
      );
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      const values = track.values.map((v, i) =>
        (vrm.meta?.metaVersion === "0" && i % 3 !== 1 ? -v : v) * hipsPositionScale,
      );
      const out = new THREE.VectorKeyframeTrack(`${vrmNodeName}.${propertyName}`, track.times, values);
      if (opts.inPlace && vrmBoneName === "hips" && propertyName === "position") rootSpeed = pinRootInPlace(out);
      tracks.push(out);
    }
  }

  if (tracks.length === 0) throw new Error(`Retarget produced 0 tracks for ${url}`);
  const result = new THREE.AnimationClip("vrmAnimation", clip.duration, tracks);
  if (rootSpeed > 0) rootSpeeds.set(result, rootSpeed);
  return result;
}
