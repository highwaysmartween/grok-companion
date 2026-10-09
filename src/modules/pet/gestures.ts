import type { GestureKind } from "./behaviour";

const FLIRTY_RE =
  /\b(kiss(es|ing)?|mwah|babe|cutie|handsome|darling|sweetheart|wink(s|ing)?|tease|teasing|flirt\w*|miss(ed)? you|love you|you'?re cute|come here|blush\w*)\b|😘|😉|😏/i;
const EXCITED_RE =
  /(!{2,}|\b(yay|woo+|omg|let'?s go+|can'?t wait|so (happy|excited|proud)|best (day|news)|hell yes|finally)\b)/i;

/**
 * Body-language for a finished reply. Very excited → Joyful_Jump, flirty or
 * warm → occasionally Blow_A_Kiss. Returns null most of the time on purpose:
 * gestures on every line would feel robotic.
 */
export function gestureForReply(text: string, mood: string, rng: () => number = Math.random): GestureKind | null {
  if (EXCITED_RE.test(text)) return rng() < 0.7 ? "joy" : null;
  if (FLIRTY_RE.test(text)) return rng() < 0.55 ? "kiss" : null;
  if (mood === "happy") return rng() < 0.2 ? "kiss" : null;
  return null;
}
