import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { VRM } from "@pixiv/three-vrm";
import { mixamoVRMRigMap } from "./mixamoVRMRigMap";

/** Load a Mixamo FBX and retarget it onto a VRM humanoid (official three-vrm method). */
export async function loadMixamoAnimation(url: string, vrm: VRM): Promise<THREE.AnimationClip> {
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
      tracks.push(new THREE.VectorKeyframeTrack(`${vrmNodeName}.${propertyName}`, track.times, values));
    }
  }

  if (tracks.length === 0) throw new Error(`Retarget produced 0 tracks for ${url}`);
  return new THREE.AnimationClip("vrmAnimation", clip.duration, tracks);
}
