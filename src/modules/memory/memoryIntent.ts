import { clearMemory, deleteMemory, listMemories, rememberFact } from "./memoryApi";

export type MemoryIntent =
  | { kind: "remember"; fact: string }
  | { kind: "list" }
  | { kind: "forget"; needle: string }
  | { kind: "clear" };

const REMEMBER = /^(?:please\s+)?(?:remember|save(?:\s+this)?(?:\s+fact)?|don't forget)(?:\s+that)?\s+[:\-–]?\s*(.+)$/i;
const LIST =
  /^(?:please\s+)?(?:list(?:\s+your)?\s+memories|what do you remember(?:\s+about\s+me)?|what have you remembered(?:\s+about\s+me)?|show(?:\s+me)?(?:\s+your)?\s+memories|what do you know about me|what(?:'s| is) in your memory|tell me what you (?:remember|know) about me)\s*[?.!]*$/i;
const FORGET =
  /^(?:please\s+)?(?:forget|delete memory|don't remember|erase)\s+(?:that\s+|the\s+fact\s+)?(.+)$/i;
const CLEAR = /^(?:please\s+)?(?:forget everything|clear(?:\s+your)?\s+memory|wipe memories)$/i;

export function parseMemoryIntent(text: string): MemoryIntent | null {
  const t = text
    .trim()
    .replace(/^(?:hey|ok|okay|yo)\b[\s,]*(?:nova\b[\s,]*)?/i, "")
    .replace(/^nova\b[\s,]*/i, "")
    .replace(/^(?:can you|could you)\s+/i, "")
    .trim();
  if (!t) return null;
  if (CLEAR.test(t)) return { kind: "clear" };
  if (LIST.test(t)) return { kind: "list" };
  const forget = t.match(FORGET);
  if (forget?.[1]) return { kind: "forget", needle: forget[1].trim() };
  const remember = t.match(REMEMBER);
  if (remember?.[1]) return { kind: "remember", fact: remember[1].trim() };
  return null;
}

/** A fact worth remembering automatically, from a clear first-person statement. */
export interface AutoFact {
  fact: string;
  /** Replace older facts with this prefix (one name, one hometown…). */
  replacePrefix?: string;
}

const clean = (s: string) =>
  s
    .trim()
    .replace(/[.!…]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

const AUTO_RULES: { re: RegExp; make: (m: RegExpMatchArray) => AutoFact | null }[] = [
  {
    re: /\b(?:my name is|call me)\s+([a-z][a-z'\-]{1,20}(?:\s+[a-z][a-z'\-]{1,20})?)\b/i,
    make: (m) => {
      const n = clean(m[1] ?? "");
      if (!n || /^(not|just|a|an|the|so|very)\b/i.test(n)) return null;
      const name = n.replace(/\b\w/g, (c) => c.toUpperCase());
      return { fact: `User's name is ${name}`, replacePrefix: "User's name is" };
    },
  },
  {
    re: /^(?:i'm|i am)\s+(\d{2})\s*(?:years old|yo|y\/o)?$/i,
    make: (m) => ({ fact: `User's age is ${m[1]}`, replacePrefix: "User's age is" }),
  },
  {
    re: /\bi (?:live in|am from|'m from)\s+([^,.!?]{2,40})/i,
    make: (m) => ({ fact: `User lives in / is from ${clean(m[1] ?? "")}`, replacePrefix: "User lives in / is from" }),
  },
  {
    re: /\bmy (?:favou?rite)\s+([a-z ]{2,24}?)\s+is\s+([^,.!?]{2,40})/i,
    make: (m) => {
      const what = clean(m[1] ?? "").toLowerCase();
      return { fact: `User's favorite ${what} is ${clean(m[2] ?? "")}`, replacePrefix: `User's favorite ${what} is` };
    },
  },
  {
    re: /\bi (?:really |kinda |kind of )?(like|love|enjoy|hate|can't stand)\s+([^,.!?]{2,48})/i,
    make: (m) => {
      const verb = (m[1] ?? "").toLowerCase();
      const what = clean(m[2] ?? "");
      // Skip "I like that" / "I love you" style chatter — not a stable fact.
      if (/^(it|that|this|these|those|you|u|ur|your|them|him|her|when|how|what|it when|to think)\b/i.test(what)) return null;
      const v = verb === "can't stand" ? "hates" : verb === "enjoy" ? "enjoys" : `${verb}s`;
      return { fact: `User ${v} ${what}` };
    },
  },
  {
    re: /\bmy birthday is\s+([^,.!?]{3,30})/i,
    make: (m) => ({ fact: `User's birthday is ${clean(m[1] ?? "")}`, replacePrefix: "User's birthday is" }),
  },
];

/**
 * Lightweight automatic memory: regex only, no extra LLM calls. Only clear
 * first-person statements (not questions) produce a fact.
 */
export function extractAutoFacts(text: string): AutoFact[] {
  const t = text.trim();
  if (!t || t.length > 300 || /\?\s*$/.test(t)) return [];
  const out: AutoFact[] = [];
  for (const rule of AUTO_RULES) {
    const m = t.match(rule.re);
    if (!m) continue;
    const f = rule.make(m);
    if (f && f.fact.length <= 120) out.push(f);
  }
  return out.slice(0, 2);
}

export async function handleMemoryIntent(intent: MemoryIntent): Promise<string> {
  switch (intent.kind) {
    case "remember": {
      const saved = await rememberFact(intent.fact);
      return `Got it — I'll remember: “${saved.fact}”.`;
    }
    case "list": {
      const facts = await listMemories();
      if (facts.length === 0) return "Honestly? Nothing yet. Tell me stuff and I'll keep it.";
      const spoken = facts.slice(-10).map((f) => toSecondPerson(f.fact));
      const list = spoken.length === 1 ? spoken[0] : `${spoken.slice(0, -1).join(", ")}, and ${spoken[spoken.length - 1]}`;
      return `I remember ${list}.${facts.length > 10 ? ` Plus ${facts.length - 10} older things.` : ""}`;
    }
    case "forget": {
      const before = await listMemories();
      const needle = intent.needle.toLowerCase().replace(/^(?:that|about|the fact that)\s+/, "").replace(/^(?:i|my)\s+/, "").replace(/[.!?]+$/, "");
      const match =
        before.find((f) => f.id === intent.needle) ??
        before.find((f) => f.fact.toLowerCase().includes(needle));
      if (!match) return `I couldn't find a memory matching “${intent.needle}”.`;
      await deleteMemory(match.id);
      return `Forgotten: “${match.fact}”.`;
    }
    case "clear": {
      await clearMemory();
      return "All local memories are gone.";
    }
  }
}

const VERBS: Record<string, string> = {
  likes: "like", loves: "love", hates: "hate", enjoys: "enjoy", lives: "live", works: "work", has: "have",
  is: "are", wants: "want", plays: "play", watches: "watch", prefers: "prefer", needs: "need", goes: "go", was: "were",
};

/** "Frank's sister is Mia" → "your sister is Mia"; "User likes jazz" → "you like jazz". */
export function toSecondPerson(fact: string): string {
  let f = fact.trim().replace(/[.]+$/, "");
  f = f.replace(/^(?:User|Frank)'s\b/i, "your").replace(/^(?:User|Frank)\s+(\w+)/i, (_, v: string) => `you ${VERBS[v.toLowerCase()] ?? v}`);
  f = f.replace(/\b(?:Frank|the user)'s\b/gi, "your").replace(/\b(?:Frank|the user)\b/gi, "you");
  return f.charAt(0).toLowerCase() + f.slice(1);
}
