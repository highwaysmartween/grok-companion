import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";

/** Mixamo rig names → VRM humanoid bones. Handles both `mixamorigHips` and `mixamorig:Hips`. */
const MIXAMO_VRM: Record<string, VRMHumanBoneName> = {
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigLeftHandThumb1: "leftThumbMetacarpal",
  mixamorigLeftHandThumb2: "leftThumbProximal",
  mixamorigLeftHandThumb3: "leftThumbDistal",
  mixamorigLeftHandIndex1: "leftIndexProximal",
  mixamorigLeftHandIndex2: "leftIndexIntermediate",
  mixamorigLeftHandIndex3: "leftIndexDistal",
  mixamorigLeftHandMiddle1: "leftMiddleProximal",
  mixamorigLeftHandMiddle2: "leftMiddleIntermediate",
  mixamorigLeftHandMiddle3: "leftMiddleDistal",
  mixamorigLeftHandRing1: "leftRingProximal",
  mixamorigLeftHandRing2: "leftRingIntermediate",
  mixamorigLeftHandRing3: "leftRingDistal",
  mixamorigLeftHandPinky1: "leftLittleProximal",
  mixamorigLeftHandPinky2: "leftLittleIntermediate",
  mixamorigLeftHandPinky3: "leftLittleDistal",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigRightHandThumb1: "rightThumbMetacarpal",
  mixamorigRightHandThumb2: "rightThumbProximal",
  mixamorigRightHandThumb3: "rightThumbDistal",
  mixamorigRightHandIndex1: "rightIndexProximal",
  mixamorigRightHandIndex2: "rightIndexIntermediate",
  mixamorigRightHandIndex3: "rightIndexDistal",
  mixamorigRightHandMiddle1: "rightMiddleProximal",
  mixamorigRightHandMiddle2: "rightMiddleIntermediate",
  mixamorigRightHandMiddle3: "rightMiddleDistal",
  mixamorigRightHandRing1: "rightRingProximal",
  mixamorigRightHandRing2: "rightRingIntermediate",
  mixamorigRightHandRing3: "rightRingDistal",
  mixamorigRightHandPinky1: "rightLittleProximal",
  mixamorigRightHandPinky2: "rightLittleIntermediate",
  mixamorigRightHandPinky3: "rightLittleDistal",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
};

function mixamoKey(raw: string): string {
  return raw.replace(/^mixamorig:/, "mixamorig");
}

function findMixamoNode(asset: THREE.Object3D, rawName: string): THREE.Object3D | undefined {
  return (
    asset.getObjectByName(rawName) ??
    asset.getObjectByName(mixamoKey(rawName)) ??
    asset.getObjectByName(rawName.replace("mixamorig", "mixamorig:"))
  );
}

/**
 * Load a Mixamo FBX clip and retarget it onto a VRM humanoid.
 * Based on the official pixiv/three-vrm Mixamo example.
 */
export async function loadMixamoClip(url: string, vrm: VRM): Promise<THREE.AnimationClip | null> {
  const loader = new FBXLoader();
  const asset = await loader.loadAsync(url);
  const clip = THREE.AnimationClip.findByName(asset.animations, "mixamo.com") ?? asset.animations[0];
  if (!clip) return null;

  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const tmp = new THREE.Vector3();

  const hipsNode =
    findMixamoNode(asset, "mixamorigHips") ?? findMixamoNode(asset, "mixamorig:Hips");
  const motionHipsHeight = hipsNode ? Math.abs(hipsNode.position.y) || 1 : 1;
  const vrmHips = vrm.humanoid?.getNormalizedBoneNode("hips");
  const vrmHipsY = vrmHips ? vrmHips.getWorldPosition(tmp).y : 1;
  const vrmRootY = vrm.scene.getWorldPosition(tmp).y;
  const vrmHipsHeight = Math.max(0.2, Math.abs(vrmHipsY - vrmRootY));
  const hipsPositionScale = vrmHipsHeight / motionHipsHeight;
  const flip = vrm.meta?.metaVersion === "0";

  const tracks: THREE.KeyframeTrack[] = [];

  for (const track of clip.tracks) {
    const [rawName, propertyName] = track.name.split(".");
    if (!rawName || !propertyName) continue;
    const vrmBone = MIXAMO_VRM[mixamoKey(rawName)];
    if (!vrmBone) continue;
    const vrmNodeName = vrm.humanoid?.getNormalizedBoneNode(vrmBone)?.name;
    const mixamoRigNode = findMixamoNode(asset, rawName);
    if (!vrmNodeName || !mixamoRigNode) continue;

    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
    if (mixamoRigNode.parent) mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);
    else parentRestWorldRotation.identity();

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i);
        q.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        q.toArray(values, i);
      }
      if (flip) {
        for (let i = 0; i < values.length; i += 2) values[i] = -values[i];
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${vrmNodeName}.${propertyName}`, track.times, values));
    } else if (track instanceof THREE.VectorKeyframeTrack && vrmBone === "hips") {
      const values = track.values.map((v, i) => {
        const axis = i % 3;
        const signed = flip && axis !== 1 ? -v : v;
        return signed * hipsPositionScale;
      });
      tracks.push(new THREE.VectorKeyframeTrack(`${vrmNodeName}.${propertyName}`, track.times, values));
    }
  }

  if (tracks.length === 0) return null;
  return new THREE.AnimationClip("vrmAnimation", clip.duration, tracks);
}
