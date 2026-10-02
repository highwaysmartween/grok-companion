import { clearMemory, deleteMemory, listMemories, rememberFact } from "./memoryApi";

export type MemoryIntent =
  | { kind: "remember"; fact: string }
  | { kind: "list" }
  | { kind: "forget"; needle: string }
  | { kind: "clear" };

const REMEMBER = /^(?:please\s+)?(?:remember|save(?:\s+this)?(?:\s+fact)?|don't forget)(?:\s+that)?\s+[:\-–]?\s*(.+)$/i;
const LIST =
  /^(?:please\s+)?(?:list(?:\s+your)?\s+memories|what do you remember|show(?:\s+me)?(?:\s+your)?\s+memories|what do you know about me)\??$/i;
const FORGET =
  /^(?:please\s+)?(?:forget|delete memory|don't remember|erase)\s+(?:that\s+|the\s+fact\s+)?(.+)$/i;
const CLEAR = /^(?:please\s+)?(?:forget everything|clear(?:\s+your)?\s+memory|wipe memories)$/i;

export function parseMemoryIntent(text: string): MemoryIntent | null {
  const t = text.trim();
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
      if (facts.length === 0) return "My pockets are empty. Tell me something to remember.";
      const lines = facts.map((f, i) => `${i + 1}. ${f.fact}`).join("\n");
      return `Here's what I remember:\n${lines}`;
    }
    case "forget": {
      const before = await listMemories();
      const needle = intent.needle.toLowerCase();
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
