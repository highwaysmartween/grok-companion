/**
 * v1.2 everyday tools, parsed locally (instant, no LLM round-trip):
 * time / date, alarms, timers, reminders (+ list / cancel), opening allow-listed
 * sites and apps. Anything we don't recognise goes to the brain, which can still
 * ask for an action with an <action>{…}</action> tag (see runAction).
 */
import { invoke } from "@tauri-apps/api/core";

export interface Alarm {
  id: string;
  kind: "alarm" | "timer" | "reminder";
  dueMs: number;
  label: string;
}

export interface OpenResult {
  status: "opened" | "confirm" | "unknown";
  target: string;
  label: string;
}

export type ToolIntent =
  | { kind: "time" }
  | { kind: "date" }
  | { kind: "add"; alarmKind: Alarm["kind"]; dueMs: number; label: string }
  | { kind: "list"; filter?: Alarm["kind"] }
  | { kind: "cancel"; target: string }
  | { kind: "open"; name: string };

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, fifty: 50, sixty: 60,
  half: 0.5, ninety: 90,
};

const toNum = (s: string): number | null => {
  const t = s.toLowerCase().trim();
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  return NUM_WORDS[t] ?? null;
};

/** "10 minutes", "1 hour and 30 minutes", "an hour", "half an hour", "90 seconds". */
export function parseDuration(text: string): number | null {
  const t = text.toLowerCase().replace(/half an hour/g, "30 minutes").replace(/an hour and a half/g, "90 minutes");
  const re = /(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|ninety)\s*(hours?|hrs?|h\b|minutes?|mins?|m\b|seconds?|secs?|s\b)/g;
  let total = 0;
  let found = false;
  for (const m of t.matchAll(re)) {
    const n = toNum(m[1]!);
    if (n == null) continue;
    const unit = m[2]!;
    found = true;
    if (unit.startsWith("h")) total += n * 3600;
    else if (unit.startsWith("m")) total += n * 60;
    else total += n;
  }
  return found && total > 0 ? Math.round(total * 1000) : null;
}

/**
 * Clock time → next occurrence (epoch ms). "7", "7am", "6:30 pm", "18:00",
 * "noon", "midnight", optional "tomorrow". `preferMorning` for wake-ups.
 */
export function parseClock(text: string, now = new Date(), preferMorning = false): number | null {
  const t = text.toLowerCase();
  let h: number;
  let min = 0;
  let mer: "am" | "pm" | null = null;
  if (/\bnoon\b|\bmidday\b/.test(t)) {
    h = 12;
    mer = "pm";
  } else if (/\bmidnight\b/.test(t)) {
    h = 0;
    mer = "am";
  } else {
    // Group 1 = hour, 2 = minutes (optional), 3 = am/pm (optional). Needs "at/for/by",
    // a colon or am/pm so "10 minutes" is never read as a clock time.
    const m =
      t.match(/\b(?:at|for|by|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])(?!\s*(?:min|sec|hour|hr))/) ??
      t.match(/\b(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/) ??
      t.match(/\b(\d{1,2})()\s*(a\.?m\.?|p\.?m\.?)/);
    if (!m) return null;
    h = parseInt(m[1]!, 10);
    min = m[2] ? parseInt(m[2], 10) : 0;
    if (m[3]) mer = m[3].startsWith("a") ? "am" : "pm";
    else if (/tonight|this evening|in the evening|at night/.test(t)) mer = "pm";
    else if (/in the morning|this morning/.test(t)) mer = "am";
  }
  if (h > 23 || min > 59) return null;
  const tomorrow = /\btomorrow\b/.test(t);
  const at = (hh: number, dayOffset: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hh, min, 0, 0);
    return d.getTime();
  };
  let hours: number[];
  if (h > 12 || h === 0 || mer) {
    let hh = h;
    if (mer === "pm" && h < 12) hh = h + 12;
    if (mer === "am" && h === 12) hh = 0;
    hours = [hh];
  } else if (preferMorning) {
    hours = [h === 12 ? 0 : h];
  } else if (h >= 1 && h <= 6) {
    // "remind me at 5" means 5 PM, not 5 in the morning.
    hours = [h + 12];
  } else {
    hours = h === 12 ? [12, 0] : [h, h + 12];
  }
  const nowMs = now.getTime();
  let best: number | null = null;
  for (const hh of hours) {
    for (const off of tomorrow ? [1] : [0, 1]) {
      const ms = at(hh, off);
      if (ms > nowMs + 30_000) {
        if (best == null || ms < best) best = ms;
        break;
      }
    }
  }
  return best;
}

const clean = (t: string) => t.trim().toLowerCase().replace(/^(hey|ok|okay|yo)\b[\s,]*(nova\b[\s,]*)?/i, "").replace(/^(nova)\b[\s,]*/i, "").replace(/^(can you|could you|please|would you)\s+/i, "").replace(/[?!.]+$/, "").trim();

export function parseToolIntent(raw: string, now = new Date()): ToolIntent | null {
  const t = clean(raw);
  if (!t) return null;

  if (/^(what('?s| is) the time|what time is it|what'?s the time( right)? now|got the time|time check)( right now| now)?$/.test(t)) return { kind: "time" };
  if (/^(what('?s| is) (the |today'?s )?date( today)?|what day is it( today)?|what'?s today)$/.test(t)) return { kind: "date" };

  // List / cancel.
  if (/\b(what|which|any|list|show)\b.*\b(alarms?|timers?|reminders?)\b/.test(t) && !/\b(set|cancel|delete|remove|stop)\b/.test(t)) {
    const f = /timer/.test(t) ? "timer" : /reminder/.test(t) ? "reminder" : /alarm/.test(t) ? "alarm" : undefined;
    return { kind: "list", filter: f };
  }
  if (/\b(cancel|delete|remove|stop|turn off|clear)\b/.test(t) && /\b(alarms?|timers?|reminders?)\b/.test(t)) {
    const kind = /timer/.test(t) ? "timer" : /reminder/.test(t) ? "reminder" : "alarm";
    return { kind: "cancel", target: kind };
  }

  // Timers: "timer 10 minutes", "set a timer for 1 minute", "10 minute timer".
  if (/\btimer\b/.test(t) || /^(count ?down)\b/.test(t)) {
    const d = parseDuration(t);
    if (d) {
      const label = t.match(/\bfor (?:the |my )?([a-z ]{3,30}?)$/)?.[1];
      const lbl = label && !/\d|minute|second|hour/.test(label) ? label : "";
      return { kind: "add", alarmKind: "timer", dueMs: now.getTime() + d, label: lbl };
    }
  }

  // Reminders: "remind me at 5 to call mum", "remind me in 20 minutes to check the oven", "remind me to X at 5".
  const rem = t.match(/^remind me\b(.*)$/);
  if (rem) {
    const rest = rem[1]!;
    const inDur = rest.match(/\bin\s+((?:\d+|an?|one|two|three|four|five|ten|fifteen|twenty|thirty|forty|fifty|half)[^,]*?(?:hours?|hrs?|minutes?|mins?|seconds?|secs?))/);
    const d = inDur ? parseDuration(inDur[1]!) : null;
    const due = d ? now.getTime() + d : parseClock(rest, now);
    if (due) {
      const what = (rest.match(/\b(?:to|that|about)\s+(.+)$/)?.[1] ?? "")
        .replace(/\s*\b(?:at|by)\s+\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?/g, "")
        .replace(/\s*\bin\s+\S+\s+(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/g, "")
        .replace(/\s*\b(tomorrow|tonight|today|this (morning|evening|afternoon))\b/g, "")
        .trim();
      return { kind: "add", alarmKind: "reminder", dueMs: due, label: what || "do the thing" };
    }
  }

  // Alarms: "wake me at 7", "wake me up at 6:30 tomorrow", "set an alarm for 6:30am", "alarm at 7".
  if (/\b(wake me|alarm)\b/.test(t) && !/\bcancel|delete|remove\b/.test(t)) {
    const inDur = t.match(/\bin\s+(.+)$/);
    const d = inDur ? parseDuration(inDur[1]!) : null;
    const preferMorning = /\bwake me\b/.test(t);
    const due = d ? now.getTime() + d : parseClock(t, now, preferMorning);
    if (due) return { kind: "add", alarmKind: "alarm", dueMs: due, label: preferMorning ? "wake up" : "" };
  }

  // Open: "open youtube", "launch spotify", "pull up netflix", "go to reddit.com".
  const open = t.match(/^(?:open|launch|start|pull up|bring up|go to|load|fire up)\s+(?:up\s+)?(.{2,60})$/);
  if (open) return { kind: "open", name: open[1]!.replace(/\s+for me$/, "").trim() };

  return null;
}

// --- formatting ---------------------------------------------------------------

export function fmtClock(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?([ap])\.?m\.?/i, (_, x: string) => ` ${x.toUpperCase()}M`);
  const today = new Date(now);
  const tmr = new Date(now);
  tmr.setDate(tmr.getDate() + 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return `${time} today`;
  if (same(d, tmr)) return `${time} tomorrow`;
  return `${time} on ${d.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" })}`;
}

export function fmtDuration(ms: number): string {
  let s = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h > 1 ? "s" : ""}`);
  if (m) parts.push(`${m} minute${m > 1 ? "s" : ""}`);
  if (s && !h) parts.push(`${s} second${s > 1 ? "s" : ""}`);
  return parts.join(" and ");
}

// --- execution ------------------------------------------------------------------

export const addAlarm = (kind: Alarm["kind"], dueMs: number, label: string) =>
  invoke<Alarm>("alarm_add", { kind, dueMs: Math.round(dueMs), label });
export const listAlarms = () => invoke<Alarm[]>("alarm_list");
export const cancelAlarms = (target: string) => invoke<Alarm[]>("alarm_cancel", { target });
export const openTarget = (name: string, confirmed = false) => invoke<OpenResult>("open_target", { name, confirmed });

export interface ToolOutcome {
  reply: string;
  /** Set when she needs a yes/no before doing it (unknown website). */
  confirmOpen?: string;
}

export async function runToolIntent(intent: ToolIntent, now = new Date()): Promise<ToolOutcome> {
  switch (intent.kind) {
    case "time":
      return { reply: `It's ${now.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?([ap])\.?m\.?/i, (_, x: string) => ` ${x.toUpperCase()}M`)}.` };
    case "date":
      return { reply: `It's ${now.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.` };
    case "add": {
      const a = await addAlarm(intent.alarmKind, intent.dueMs, intent.label);
      if (a.kind === "timer") return { reply: `Timer set for ${fmtDuration(a.dueMs - now.getTime())}.` };
      if (a.kind === "reminder") return { reply: `Okay, I'll remind you to ${a.label} at ${fmtClock(a.dueMs, now)}.` };
      return { reply: `Alarm set for ${fmtClock(a.dueMs, now)}.` };
    }
    case "list": {
      const all = await listAlarms();
      const list = intent.filter ? all.filter((a) => a.kind === intent.filter) : all;
      if (!list.length) return { reply: intent.filter ? `You've got no ${intent.filter}s set.` : "Nothing set. No alarms, timers or reminders." };
      const items = list.slice(0, 6).map((a) =>
        a.kind === "timer"
          ? `a timer with ${fmtDuration(a.dueMs - now.getTime())} left`
          : a.kind === "reminder"
            ? `a reminder to ${a.label} at ${fmtClock(a.dueMs, now)}`
            : `an alarm at ${fmtClock(a.dueMs, now)}`,
      );
      return { reply: `You've got ${items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`}.` };
    }
    case "cancel": {
      const gone = await cancelAlarms(intent.target);
      if (!gone.length) return { reply: `There's no ${intent.target} to cancel.` };
      return { reply: gone.length === 1 ? `Done, cancelled your ${gone[0]!.kind}${gone[0]!.kind === "alarm" ? ` for ${fmtClock(gone[0]!.dueMs, now)}` : ""}.` : `Done, cancelled ${gone.length} ${intent.target}s.` };
    }
    case "open": {
      const r = await openTarget(intent.name);
      const nice = r.label.length <= 3 ? r.label.toUpperCase() : r.label.replace(/\b\w/g, (c) => c.toUpperCase());
      if (r.status === "opened") return { reply: `Opening ${/^https?:/.test(r.label) ? r.label.replace(/^https?:\/\//, "") : nice}.` };
      if (r.status === "confirm") return { reply: `That's not one I know. Want me to open ${r.label.replace(/^https?:\/\//, "")}?`, confirmOpen: r.label };
      return { reply: `I can't open "${intent.name}". I only open sites and apps I know, like YouTube, Spotify or Netflix.` };
    }
  }
}

/** <action>{…}</action> from the brain (things the local parser missed). */
export async function runAction(json: string, now = new Date()): Promise<string | null> {
  let a: { type?: string; seconds?: number; at?: string; label?: string; target?: string };
  try {
    a = JSON.parse(json);
  } catch {
    return null;
  }
  try {
    if (a.type === "timer" && a.seconds && a.seconds > 0) {
      await addAlarm("timer", now.getTime() + a.seconds * 1000, a.label ?? "");
      return null;
    }
    if ((a.type === "alarm" || a.type === "reminder") && a.at) {
      const due = new Date(a.at).getTime();
      if (Number.isFinite(due) && due > now.getTime()) await addAlarm(a.type, due, a.label ?? "");
      return null;
    }
    if (a.type === "open" && a.target) {
      const r = await openTarget(a.target);
      return r.status === "opened" ? null : `Couldn't open ${a.target}.`;
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

export const isYes = (t: string) => /^(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|please|open it|sure thing)\b/i.test(clean(t));
export const isNo = (t: string) => /^(no|nah|nope|don'?t|never ?mind|cancel)\b/i.test(clean(t));
