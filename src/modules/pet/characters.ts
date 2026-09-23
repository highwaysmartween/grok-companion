export interface CharacterModel {
  id: string;
  label: string;
  url: string;
}

/** Desktop anime-girl models already in public/models. */
export const CHARACTER_MODELS: CharacterModel[] = [
  { id: "companion.vrm", label: "r18 (lingerie)", url: "/models/companion.vrm" },
  { id: "companion_02.vrm", label: "Christina (bikini)", url: "/models/companion_02.vrm" },
  { id: "companion_03.vrm", label: "Norykko Tsuruya (bikini)", url: "/models/companion_03.vrm" },
  { id: "companion_04.vrm", label: "NyokoNoUta (bikini)", url: "/models/companion_04.vrm" },
  { id: "catgirl.vrm", label: "Cat-ear girl", url: "/models/catgirl.vrm" },
  { id: "anime_girl.glb", label: "Henita (GLB)", url: "/models/anime_girl.glb" },
];

export function characterUrl(id: string | undefined | null): string {
  const found = CHARACTER_MODELS.find((m) => m.id === id);
  return found?.url ?? CHARACTER_MODELS[0].url;
}

export function nextCharacterId(id: string | undefined | null, dir: 1 | -1): string {
  const i = Math.max(0, CHARACTER_MODELS.findIndex((m) => m.id === id));
  const n = CHARACTER_MODELS.length;
  return CHARACTER_MODELS[(i + dir + n) % n].id;
}
