import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import type { FlashFrame } from "./behaviour";

/**
 * "Flash": a real pull-the-top-up move instead of hiding clothes.
 *
 *  - FlashRig: procedural two-bone IK on the VRM normalized humanoid
 *    (left/right UpperArm → LowerArm → Hand, plus spine / chest / head),
 *    hands grab the hem at the waist and lift it to the collarbone.
 *  - FlashTop: the top's own vertices are rolled up in the vertex shader
 *    (bind space, before skinning) to follow the hands: everything below the
 *    rising "roll line" is compressed into a bunched band just under it.
 *    The skirt / pants / shoes never move.
 *  - VRoid exports delete the body polygons hidden under clothes, so a
 *    skin-coloured fill is built from the top's own torso triangles (pulled
 *    slightly inward) and shown only while the top is up — no see-through hole.
 *
 * Model support:
 *  - "deform": allows sexual use (VRM meta) and has a separate top primitive.
 *  - "hide":   allows sexual use, top found but no usable bind data → the top is
 *              hidden exactly when the hands pass the chest (fallback c).
 *  - "pose":   allows sexual use and wears no top at all (e.g. a nude base body)
 *              → just the arms / pose / giggle; nothing to lift, no stand-in torso.
 *  - "none":   the model's licence disallows sexual use → no flash at all.
 */
export type FlashMode = "deform" | "hide" | "pose" | "none";

/** Upper-body clothing (VRoid "Tops", generic names). Skirts / pants / one-pieces are never touched. */
const TOP_RE = /TOPS|SHIRT|JACKET|COAT|HOODIE|SWEATER|BLOUSE|CAMI|トップス|上着|シャツ/i;
const NOT_TOP_RE = /SKIN|BODY|FACE|HAIR|EYE|BOTTOMS|SKIRT|PANTS|SHORTS|SHOES|SOCK|ONEPIECE|ACCESSORY|ボトムス|スカート|靴/i;

export const isTopMaterialName = (name: string) => TOP_RE.test(name) && !NOT_TOP_RE.test(name);

export function allowsSexualUse(vrm: VRM): boolean {
  const m = vrm.meta as unknown as Record<string, unknown> | undefined;
  if (!m) return false;
  if (m.metaVersion === "1") return m.allowExcessivelySexualUsage === true;
  return m.sexualUssageName === "Allow";
}

interface Landmarks {
  /** Waist split: top vertices above this roll up, below stay (dress skirts). */
  splitY: number;
  /** Highest point the hem is pulled to (collarbone / armpit line). */
  rollMaxY: number;
  neckY: number;
  cx: number;
  cz: number;
  /** Torso half-width (sleeves outside are left alone). */
  halfW: number;
  /** +1 if the model faces +Z in bind space (VRM1), -1 for VRM0. */
  fz: number;
  hipsY: number;
  armpitY: number;
  /** Spine axis (y, z) samples, bottom → top. */
  axis: [number, number][];
  /** Spine bone chain with bind heights (fill skinning). */
  chain: [VRMHumanBoneName, number][];
}

const FLASH_VERT_DECL = /* glsl */ `
uniform float uFlashLift;
uniform vec4 uFlashA; // splitY, rollMaxY, cx, cz
uniform vec4 uFlashB; // halfW, fz, -, -
varying float vFlashAbove;
`;
const FLASH_VERT_BODY = /* glsl */ `
  vFlashAbove = step(uFlashA.x, transformed.y);
  if (uFlashLift > 0.0005) {
    float y0 = transformed.y;
    float ax = abs(transformed.x - uFlashA.z);
    float mask = (1.0 - smoothstep(uFlashB.x, uFlashB.x + 0.05, ax)) * vFlashAbove;
    float span = max(1e-4, uFlashA.y - uFlashA.x);
    float yr = mix(uFlashA.x, uFlashA.y, uFlashLift);
    if (mask > 0.0 && y0 < yr) {
      // 0 at the roll line … 1 at the original hem (rolled furthest).
      float under = clamp((yr - y0) / span, 0.0, 1.0);
      // Rolled fabric: compressed into a thin band just under the roll line,
      // a little lower for the cloth that travelled furthest (layers stack).
      float ny = yr - 0.01 - (yr - y0) * 0.16;
      vec2 rad = transformed.xz - uFlashA.zw;
      float front = step(0.0, rad.y * uFlashB.y);
      // Bunch: push out so the roll sits proud of the chest it passes over.
      float growX = 1.10 + 0.22 * under;
      float growZ = 1.12 + mix(0.25, 0.85, front) * under;
      vec2 nxz = uFlashA.zw + vec2(rad.x * growX, rad.y * growZ);
      nxz.y += uFlashB.y * 0.012 * front;
      transformed.y = mix(y0, ny, mask);
      transformed.xz = mix(transformed.xz, nxz, mask);
    }
  }
`;
const FLASH_FRAG_DECL = /* glsl */ `
uniform float uFlashLift;
varying float vFlashAbove;
`;
// Triangles that straddle the waist split (bodice ↔ skirt seam) would stretch → drop them.
const FLASH_FRAG_BODY = /* glsl */ `
  if (uFlashLift > 0.0005 && vFlashAbove > 0.01 && vFlashAbove < 0.99) discard;
`;

type Uniforms = {
  uFlashLift: { value: number };
  uFlashA: { value: THREE.Vector4 };
  uFlashB: { value: THREE.Vector4 };
};

function injectTopShader(mat: THREE.Material, u: Uniforms) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    shader.uniforms.uFlashLift = u.uFlashLift;
    shader.uniforms.uFlashA = u.uFlashA;
    shader.uniforms.uFlashB = u.uFlashB;
    shader.vertexShader = shader.vertexShader
      .replace("void main()", `${FLASH_VERT_DECL}\nvoid main()`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${FLASH_VERT_BODY}`);
    // Discard right at the top of main() (before any lighting work).
    shader.fragmentShader = shader.fragmentShader
      .replace("void main()", `${FLASH_FRAG_DECL}\nvoid main()`)
      .replace(/void main\(\)\s*\{/, (m) => `${m}\n${FLASH_FRAG_BODY}`);
  };
  mat.customProgramCacheKey = () => `${prevKey.call(mat)}|petFlashTop1`;
  mat.needsUpdate = true;
}

/** Bone origin in a skinned mesh's geometry (bind) space. */
function bindPos(mesh: THREE.SkinnedMesh, node: THREE.Object3D | null): THREE.Vector3 | null {
  if (!node) return null;
  const i = mesh.skeleton.bones.indexOf(node as THREE.Bone);
  if (i < 0) return null;
  const m = mesh.skeleton.boneInverses[i]!.clone().invert();
  return new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(mesh.bindMatrixInverse);
}

function landmarks(vrm: VRM, mesh: THREE.SkinnedMesh): Landmarks | null {
  const raw = (n: VRMHumanBoneName) => vrm.humanoid.getRawBoneNode(n);
  const hips = bindPos(mesh, raw("hips"));
  const spine = bindPos(mesh, raw("spine"));
  const chest = bindPos(mesh, raw("chest")) ?? spine;
  const upper = bindPos(mesh, raw("upperChest")) ?? chest;
  const neck = bindPos(mesh, raw("neck"));
  const lua = bindPos(mesh, raw("leftUpperArm"));
  const rua = bindPos(mesh, raw("rightUpperArm"));
  if (!hips || !spine || !chest || !upper || !neck || !lua || !rua) return null;
  const vals = [hips, spine, chest, upper, neck, lua, rua].flatMap((v) => [v.x, v.y, v.z]);
  if (!vals.every(Number.isFinite) || !(neck.y > hips.y + 0.15)) return null;
  const shoulder = Math.abs(lua.x - rua.x) / 2;
  return {
    splitY: spine.y - 0.025,
    rollMaxY: upper.y + 0.42 * (neck.y - upper.y),
    neckY: neck.y,
    cx: (lua.x + rua.x) / 2,
    cz: (hips.z + chest.z) / 2,
    halfW: Math.max(0.12, shoulder + 0.075),
    fz: lua.x >= rua.x ? 1 : -1,
    hipsY: hips.y,
    armpitY: lua.y - 0.04,
    axis: [hips, spine, chest, upper, neck].map((v) => [v.y, v.z] as [number, number]),
    chain: (
      [
        ["hips", hips.y],
        ["spine", spine.y],
        ["chest", chest.y],
        ["upperChest", upper.y],
      ] as [VRMHumanBoneName, number][]
    ).filter(([n]) => !!raw(n)),
  };
}

/** Skin colour of the body near the upper chest (where the body mesh still exists). */
function sampleSkin(vrm: VRM, L: Landmarks): { lit: THREE.Color; shade: THREE.Color | null; source: THREE.Material } | null {
  let best: { mesh: THREE.Mesh; i: number; score: number } | null = null;
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material | undefined;
    if (!mat || !/BODY.*SKIN|SKIN.*BODY|_Body_/i.test(mat.name)) return;
    const pos = mesh.geometry.getAttribute("position");
    const idx = mesh.geometry.index;
    if (!pos || !mesh.geometry.getAttribute("uv")) return;
    const used = idx ? new Set(idx.array as ArrayLike<number> as number[]) : null;
    for (let i = 0; i < pos.count; i++) {
      if (used && !used.has(i)) continue;
      const y = pos.getY(i);
      if (y < L.rollMaxY - 0.04 || y > L.neckY - 0.03) continue;
      if (Math.abs(pos.getX(i) - L.cx) > 0.05) continue;
      const score = (pos.getZ(i) - L.cz) * L.fz;
      if (!best || score > best.score) best = { mesh, i, score };
    }
  });
  if (!best) return null;
  const { mesh, i } = best as { mesh: THREE.Mesh; i: number };
  const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material & {
    map?: THREE.Texture | null;
    color?: THREE.Color;
    shadeColorFactor?: THREE.Color;
    shadeMultiplyTexture?: THREE.Texture | null;
  };
  const uv = mesh.geometry.getAttribute("uv");
  const u = uv.getX(i);
  const v = uv.getY(i);
  const px = (tex: THREE.Texture | null | undefined): THREE.Color | null => {
    const img = tex?.image as CanvasImageSource & { width: number; height: number } | undefined;
    if (!img || !img.width) return null;
    try {
      const c = document.createElement("canvas");
      c.width = 5;
      c.height = 5;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      const x = THREE.MathUtils.euclideanModulo(u, 1) * img.width;
      const y = THREE.MathUtils.euclideanModulo(tex!.flipY ? 1 - v : v, 1) * img.height;
      ctx.drawImage(img, x - 2, y - 2, 5, 5, 0, 0, 5, 5);
      const d = ctx.getImageData(0, 0, 5, 5).data;
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < d.length; k += 4) {
        r += d[k]!;
        g += d[k + 1]!;
        b += d[k + 2]!;
      }
      const n = d.length / 4;
      return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
    } catch {
      return null;
    }
  };
  const fallback = new THREE.Color().setRGB(0.98, 0.86, 0.8, THREE.SRGBColorSpace);
  const lit = (px(src.map) ?? fallback).multiply(src.color ?? new THREE.Color(1, 1, 1));
  const shadeTex = src.shadeMultiplyTexture ? px(src.shadeMultiplyTexture) : null;
  const shade = src.shadeColorFactor ? src.shadeColorFactor.clone().multiply(shadeTex ?? new THREE.Color(1, 1, 1)) : null;
  return { lit, shade, source: src };
}

export class FlashTop {
  readonly mode: FlashMode;
  readonly topNames: string[] = [];
  readonly reason: string;
  private readonly uniforms: Uniforms = {
    uFlashLift: { value: 0 },
    uFlashA: { value: new THREE.Vector4() },
    uFlashB: { value: new THREE.Vector4() },
  };
  private readonly fills: THREE.Mesh[] = [];
  private readonly hideMats: THREE.Material[] = [];
  private hidden = false;
  lift = 0;
  /** Hem / roll-line heights as a fraction of hips→neck (hand targets). */
  hemUp = 0.12;
  rollUp = 0.8;

  constructor(vrm: VRM) {
    const tops: THREE.SkinnedMesh[] = [];
    vrm.scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats[0] && isTopMaterialName(mats[0].name)) {
        tops.push(mesh);
        this.topNames.push(mats[0].name);
      }
    });
    if (!allowsSexualUse(vrm)) {
      this.mode = "none";
      this.reason = "licence disallows sexual use";
      return;
    }
    if (!tops.length) {
      this.mode = "pose";
      this.reason = "no top (nude body) → arm/pose move only";
      return;
    }
    const L = tops[0]!.isSkinnedMesh ? landmarks(vrm, tops[0]!) : null;
    if (!L) {
      this.mode = "hide";
      this.reason = "no bind-space landmarks → timed hide";
      for (const m of tops) for (const mat of [m.material].flat()) this.hideMats.push(mat);
      return;
    }
    this.mode = "deform";
    this.reason = "vertex roll-up";
    this.uniforms.uFlashA.value.set(L.splitY, L.rollMaxY, L.cx, L.cz);
    this.uniforms.uFlashB.value.set(L.halfW, L.fz, 0, 0);
    for (const m of tops) for (const mat of [m.material].flat()) injectTopShader(mat, this.uniforms);

    // Skin fill under the top (VRoid removed the body polygons there).
    const skin = sampleSkin(vrm, L);
    const fill = this.buildFill(vrm, tops[0]!, L, skin);
    if (fill) this.fills.push(fill);
    this.hemUp = (L.splitY - L.hipsY) / (L.neckY - L.hipsY);
    this.rollUp = (L.rollMaxY - L.hipsY) / (L.neckY - L.hipsY);
  }

  /**
   * Smooth skin torso where VRoid deleted the body under the top: a lathe-like
   * shell (height slices × angles) fitted to the remaining body skin and the
   * inside of the top, skinned to hips → spine → chest → upperChest.
   */
  private buildFill(
    vrm: VRM,
    top: THREE.SkinnedMesh,
    L: Landmarks,
    skin: ReturnType<typeof sampleSkin>,
  ): THREE.Mesh | null {
    if (!top.isSkinnedMesh) return null;
    const NS = 18;
    const NA = 40;
    const y0 = L.splitY - 0.05;
    const y1 = L.rollMaxY + 0.015;
    const bodyR: number[][][] = Array.from({ length: NS }, () => Array.from({ length: NA }, () => []));
    const clothR: number[][][] = Array.from({ length: NS }, () => Array.from({ length: NA }, () => []));
    const axisZ = (y: number) => {
      const ys = L.axis;
      if (y <= ys[0]![0]) return ys[0]![1];
      for (let i = 1; i < ys.length; i++) {
        if (y <= ys[i]![0]) {
          const [ya, za] = ys[i - 1]!, [yb, zb] = ys[i]!;
          return za + ((zb - za) * (y - ya)) / Math.max(1e-4, yb - ya);
        }
      }
      return ys[ys.length - 1]![1];
    };
    const bin = (x: number, y: number, z: number) => {
      const si = Math.round(((y - y0) / (y1 - y0)) * (NS - 1));
      if (si < 0 || si >= NS) return null;
      const dx = x - L.cx;
      const dz = (z - axisZ(y)) * L.fz;
      const r = Math.hypot(dx, dz);
      // Arms / shoulders (bind T-pose) are not torso.
      if (r > 0.24 || (y > L.armpitY - 0.03 && Math.abs(dx) > L.halfW - 0.05)) return null;
      const a = Math.atan2(dx, dz); // 0 = front
      const ai = ((Math.round((a / (Math.PI * 2)) * NA) % NA) + NA) % NA;
      return { si, ai, r };
    };
    const sameSpace = (m: THREE.SkinnedMesh) => m.bindMatrix.equals(top.bindMatrix);
    vrm.scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !sameSpace(mesh)) return;
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material | undefined;
      const name = mat?.name ?? "";
      const isBody = /BODY.*SKIN|_Body_/i.test(name);
      const isTop = isTopMaterialName(name);
      if (!isBody && !isTop) return;
      const pos = mesh.geometry.getAttribute("position");
      const idx = mesh.geometry.index;
      const used = idx ? new Set(Array.from(idx.array as ArrayLike<number>)) : null;
      for (let i = 0; i < pos.count; i++) {
        if (used && !used.has(i)) continue;
        const b = bin(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (!b) continue;
        (isBody ? bodyR : clothR)[b.si]![b.ai]!.push(b.r);
      }
    });
    const pct = (arr: number[], q: number) => {
      const a = [...arr].sort((x, y) => x - y);
      return a[Math.min(a.length - 1, Math.floor(q * a.length))]!;
    };
    const R: number[][] = [];
    for (let si = 0; si < NS; si++) {
      R.push([]);
      for (let ai = 0; ai < NA; ai++) {
        const b = bodyR[si]![ai]!;
        const c = clothR[si]![ai]!;
        // Real skin where it still exists, else just inside the top's inner layer.
        R[si]!.push(b.length ? pct(b, 0.5) : c.length >= 2 ? pct(c, 0.12) - 0.01 : NaN);
      }
    }
    // Fill gaps: around each ring, then between rings.
    for (let si = 0; si < NS; si++) {
      const ring = R[si]!;
      if (ring.every((v) => Number.isNaN(v))) continue;
      for (let ai = 0; ai < NA; ai++) {
        if (!Number.isNaN(ring[ai]!)) continue;
        let l = 1, rgt = 1;
        while (Number.isNaN(ring[(ai - l + NA) % NA]!)) l++;
        while (Number.isNaN(ring[(ai + rgt) % NA]!)) rgt++;
        const vl = ring[(ai - l + NA) % NA]!, vr = ring[(ai + rgt) % NA]!;
        ring[ai] = vl + ((vr - vl) * l) / (l + rgt);
      }
    }
    const filled = R.map((ring) => !ring.some((v) => Number.isNaN(v)));
    if (filled.filter(Boolean).length < 3) return null;
    for (let si = 0; si < NS; si++) {
      if (filled[si]) continue;
      let lo = si - 1, hi = si + 1;
      while (lo >= 0 && !filled[lo]) lo--;
      while (hi < NS && !filled[hi]) hi++;
      for (let ai = 0; ai < NA; ai++) {
        const a = lo >= 0 ? R[lo]![ai]! : R[hi]![ai]!;
        const b = hi < NS ? R[hi]![ai]! : a;
        const w = lo >= 0 && hi < NS ? (si - lo) / (hi - lo) : 0;
        R[si]![ai] = a + (b - a) * w;
      }
    }
    // Smooth (keeps the bust, removes frill / lace noise).
    for (let pass = 0; pass < 3; pass++) {
      const S = R.map((ring) => [...ring]);
      for (let si = 0; si < NS; si++) {
        for (let ai = 0; ai < NA; ai++) {
          const n = [R[si]![(ai + 1) % NA]!, R[si]![(ai - 1 + NA) % NA]!];
          if (si > 0) n.push(R[si - 1]![ai]!);
          if (si < NS - 1) n.push(R[si + 1]![ai]!);
          S[si]![ai] = R[si]![ai]! * 0.5 + (n.reduce((x, y) => x + y, 0) / n.length) * 0.5;
        }
      }
      R.splice(0, NS, ...S);
    }

    // Geometry + skinning (piecewise along the spine chain).
    const bones = top.skeleton.bones;
    const chain = L.chain
      .map(([name, y]) => ({ i: bones.indexOf(vrm.humanoid.getRawBoneNode(name) as THREE.Bone), y }))
      .filter((b) => b.i >= 0);
    if (chain.length < 2) return null;
    const pos: number[] = [];
    const si4: number[] = [];
    const sw4: number[] = [];
    for (let si = 0; si < NS; si++) {
      const y = y0 + ((y1 - y0) * si) / (NS - 1);
      const zc = axisZ(y);
      let k = 0;
      while (k < chain.length - 2 && y > chain[k + 1]!.y) k++;
      const a = chain[k]!, b = chain[k + 1]!;
      const s01 = THREE.MathUtils.clamp((y - a.y) / Math.max(1e-4, b.y - a.y), 0, 1);
      const wb = THREE.MathUtils.smoothstep(s01, 0.55, 1) * 0.5;
      for (let ai = 0; ai < NA; ai++) {
        const ang = (ai / NA) * Math.PI * 2;
        const r = Math.max(0.03, R[si]![ai]! - 0.004);
        pos.push(L.cx + Math.sin(ang) * r, y, zc + Math.cos(ang) * r * L.fz);
        si4.push(a.i, b.i, 0, 0);
        sw4.push(1 - wb, wb, 0, 0);
      }
    }
    const index: number[] = [];
    for (let si = 0; si < NS - 1; si++) {
      for (let ai = 0; ai < NA; ai++) {
        const a = si * NA + ai, b = si * NA + ((ai + 1) % NA), c = a + NA, d = b + NA;
        index.push(a, c, b, b, c, d);
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    fg.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si4, 4));
    fg.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw4, 4));
    fg.setIndex(index);
    fg.computeVertexNormals();
    // Winding: make normals face outward.
    const nrm = fg.getAttribute("normal");
    const p0 = new THREE.Vector3(pos[0]! - L.cx, 0, pos[2]! - axisZ(pos[1]!));
    if (nrm.getX(0) * p0.x + nrm.getZ(0) * p0.z < 0) {
      for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
    }

    let mat: THREE.Material;
    const src = skin?.source;
    if (src && skin) {
      const m = src.clone() as THREE.Material & Record<string, unknown>;
      m.name = "PetFlashSkinFill";
      // MToon: plain skin colour, keep the toon shading so it matches the body.
      for (const k of ["map", "shadeMultiplyTexture", "normalMap", "rimMultiplyTexture", "matcapTexture", "emissiveMap", "shadingShiftTexture"]) {
        if (k in m) m[k] = null;
      }
      if (m.color instanceof THREE.Color) (m.color as THREE.Color).copy(skin.lit);
      if (m.shadeColorFactor instanceof THREE.Color && skin.shade) (m.shadeColorFactor as THREE.Color).copy(skin.shade);
      if ("isOutline" in m) m.isOutline = false;
      mat = m;
    } else {
      mat = new THREE.MeshToonMaterial({ color: skin?.lit ?? 0xf6dcd0 });
    }
    mat.side = THREE.FrontSide;
    mat.transparent = false;
    mat.depthWrite = true;
    const fill = new THREE.SkinnedMesh(fg, mat);
    fill.name = "PetFlashSkinFill";
    fill.bind(top.skeleton, top.bindMatrix);
    fill.position.copy(top.position);
    fill.quaternion.copy(top.quaternion);
    fill.scale.copy(top.scale);
    fill.frustumCulled = false;
    fill.visible = false;
    top.parent?.add(fill);
    return fill;
  }

  /** 0 = top down, 1 = rolled up to the collarbone. */
  setLift(u: number) {
    const v = Math.min(1, Math.max(0, u));
    this.lift = v;
    if (this.mode === "deform") {
      this.uniforms.uFlashLift.value = v;
      for (const f of this.fills) f.visible = v > 0.001;
    } else if (this.mode === "hide") {
      // Fallback: the top disappears exactly as the hands pass the chest.
      const hide = v > 0.5;
      if (hide !== this.hidden) {
        this.hidden = hide;
        for (const m of this.hideMats) m.visible = !hide;
      }
    }
  }

  dispose() {
    for (const f of this.fills) {
      f.parent?.remove(f);
      f.geometry.dispose();
      (f.material as THREE.Material).dispose();
    }
    this.fills.length = 0;
  }
}

// --- arms ---------------------------------------------------------------------

const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const vE = new THREE.Vector3();
const vD = new THREE.Vector3();
const vN = new THREE.Vector3();
const qW = new THREE.Quaternion();
const qP = new THREE.Quaternion();
const qD = new THREE.Quaternion();
const qT = new THREE.Quaternion();

/** Rotate `bone` (world space) so the direction from it to `from` points at `to`. */
function aimBone(bone: THREE.Object3D, fromWorld: THREE.Vector3, toWorld: THREE.Vector3) {
  bone.getWorldPosition(vA);
  vB.copy(fromWorld).sub(vA).normalize();
  vC.copy(toWorld).sub(vA).normalize();
  if (vB.lengthSq() < 1e-8 || vC.lengthSq() < 1e-8) return;
  qD.setFromUnitVectors(vB, vC);
  bone.getWorldQuaternion(qW);
  bone.parent!.getWorldQuaternion(qP);
  // local' = parent⁻¹ · Δ · world
  bone.quaternion.copy(qP.invert().multiply(qD).multiply(qW));
  bone.updateMatrixWorld(true);
}

const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"] as const;
const SEGS = ["Metacarpal", "Proximal", "Intermediate", "Distal"] as const;

export class FlashRig {
  private readonly vrm: VRM;
  /** Hand heights as a fraction of hips→neck: hem at the waist, roll line at the collarbone. */
  hemUp = 0.12;
  topUp = 0.8;
  constructor(vrm: VRM, top?: FlashTop) {
    this.vrm = vrm;
    if (top?.mode === "deform") {
      this.hemUp = top.hemUp;
      this.topUp = top.rollUp;
    }
  }
  private n(name: string) {
    return this.vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
  }

  /**
   * Blend the arms toward hands-on-hem (grip) and lift (raise), spine lean and a
   * giggle. Call after the mixer + procedural layer, before vrm.update().
   * Returns the hem height actually reached by the hands (0..1) so the top
   * follows the real hand positions, not the timeline.
   */
  apply(f: FlashFrame, t: number, mirror: number): number {
    const hips = this.n("hips"), neck = this.n("neck");
    const lua = this.n("leftUpperArm"), rua = this.n("rightUpperArm");
    if (!hips || !neck || !lua || !rua || f.grip <= 0) return 0;
    const add = (name: string, x: number, y: number, z: number) => {
      const b = this.n(name);
      if (!b) return;
      b.quaternion.multiply(qT.setFromEuler(new THREE.Euler(x * mirror, y, z * mirror, "YXZ")));
    };
    // Lean back a touch + chest out while the top is up; a little shoulder giggle in the hold.
    const giggle = f.hold > 0 ? Math.sin(f.hold * Math.PI) * Math.sin(t * 21) : 0;
    add("spine", -0.05 * f.raise, 0, 0);
    add("chest", -0.04 * f.raise + 0.012 * giggle, 0, 0);
    add("upperChest", 0.01 * giggle, 0, 0);
    add("head", 0.06 * f.raise - 0.03 * f.grip, 0, 0.1 * f.raise * Math.sin(f.hold * Math.PI));
    this.vrm.scene.parent?.updateMatrixWorld(true);

    // Body frame from the live pose (convention-free: VRM0/VRM1, any yaw).
    const H = hips.getWorldPosition(new THREE.Vector3());
    const N = neck.getWorldPosition(new THREE.Vector3());
    const Rv = lua.getWorldPosition(new THREE.Vector3()).sub(rua.getWorldPosition(new THREE.Vector3())).normalize();
    const U = N.clone().sub(H);
    const len = U.length();
    U.normalize();
    const F = new THREE.Vector3().crossVectors(Rv, U).normalize();
    const point = (up: number, fwd: number, side: number, s: number) =>
      H.clone().addScaledVector(U, up * len).addScaledVector(F, fwd * len).addScaledVector(Rv, side * s * len);
    const hemMid = point(this.hemUp - 0.1, 0, 0, 0);
    const topMid = point(this.topUp - 0.13, 0, 0, 0);

    let reached = 0;
    for (const side of [1, -1] as const) {
      const pre = side > 0 ? "left" : "right";
      const upper = this.n(`${pre}UpperArm`), lower = this.n(`${pre}LowerArm`), hand = this.n(`${pre}Hand`);
      if (!upper || !lower || !hand) continue;
      const hem = point(this.hemUp - 0.1, 0.36, side, 0.22);
      const top = point(this.topUp - 0.13, 0.52, side, 0.27);
      const target = hem.clone().lerp(top, f.raise);
      const q0u = upper.quaternion.clone();
      const q0l = lower.quaternion.clone();
      const q0h = hand.quaternion.clone();

      // Two-bone IK with the elbow out, down and back.
      const A = upper.getWorldPosition(new THREE.Vector3());
      const B = lower.getWorldPosition(new THREE.Vector3());
      const C = hand.getWorldPosition(new THREE.Vector3());
      const a = A.distanceTo(B), b = B.distanceTo(C);
      vD.copy(target).sub(A);
      const d = THREE.MathUtils.clamp(vD.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
      vD.normalize();
      const pole = A.clone().addScaledVector(Rv, side * 0.7 * len).addScaledVector(U, -0.55 * len).addScaledVector(F, -0.25 * len);
      vN.copy(pole).sub(A);
      vN.addScaledVector(vD, -vN.dot(vD)).normalize();
      const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
      vE.copy(A).addScaledVector(vD, a * cosA).addScaledVector(vN, a * Math.sqrt(1 - cosA * cosA));
      aimBone(upper, B, vE);
      lower.getWorldPosition(B);
      hand.getWorldPosition(C);
      aimBone(lower, C, A.clone().addScaledVector(vD, d));
      const qIu = upper.quaternion.clone();
      const qIl = lower.quaternion.clone();
      upper.quaternion.copy(q0u).slerp(qIu, f.grip);
      upper.updateMatrixWorld(true);
      lower.quaternion.copy(q0l).slerp(qIl, f.grip);
      lower.updateMatrixWorld(true);

      // Wrist: palm toward the body, fingers curled round the hem.
      hand.quaternion.copy(q0h);
      add(`${pre}Hand`, 0, -side * 0.5 * f.grip, side * 0.25 * f.grip);
      for (const fn of FINGERS) {
        for (const seg of SEGS) {
          const curl = (fn === "Thumb" ? 0.35 : seg === "Proximal" ? 0.9 : seg === "Intermediate" ? 1.1 : seg === "Distal" ? 0.7 : 0) * f.grip;
          if (curl) add(`${pre}${fn}${seg}`, 0, fn === "Thumb" ? side * curl : 0, fn === "Thumb" ? 0 : -side * curl);
        }
      }
      hand.updateMatrixWorld(true);
      hand.getWorldPosition(C);
      const span = topMid.clone().sub(hemMid);
      reached += THREE.MathUtils.clamp(C.clone().sub(hemMid).dot(span) / span.lengthSq(), 0, 1) / 2;
    }
    return reached;
  }
}
