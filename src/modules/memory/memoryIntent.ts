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
