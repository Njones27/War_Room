// Five-field cron (minute hour day-of-month month day-of-week) in local time,
// for satellite schedules. Supports *, lists, ranges and steps; day-of-week
// 0–7 with 0 and 7 both Sunday. Like classic cron, when both day fields are
// restricted a time matches either one.

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Whether the day-of-month / day-of-week fields were "*". */
  anyDay: boolean;
  anyWeekday: boolean;
}

const FIELDS: [min: number, max: number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function field(text: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`Bad cron field "${text}"`);
    const step = m[4] ? Number(m[4]) : 1;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    }
    if (step < 1 || lo < min || hi > max || lo > hi) throw new Error(`Cron field "${text}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A cron schedule has 5 fields: minute hour day month weekday");
  const [mi, h, d, mo, w] = parts.map((p, i) => field(p, FIELDS[i]!));
  if (w!.has(7)) w!.add(0);
  return { minutes: mi!, hours: h!, days: d!, months: mo!, weekdays: w!, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(c: Cron, t: Date): boolean {
  const dom = c.days.has(t.getDate());
  const dow = c.weekdays.has(t.getDay());
  if (c.anyDay && c.anyWeekday) return true;
  if (c.anyDay) return dow;
  if (c.anyWeekday) return dom;
  return dom || dow;
}

/** The first matching minute strictly after `from` (ms epoch), or null if none within ~4 years. */
export function nextCronRun(expr: string, from: number): number | null {
  const c = parseCron(expr);
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from + 4 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!c.months.has(t.getMonth() + 1) || !dayMatches(c, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minutes.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t.getTime();
  }
  return null;
}

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Plain words for common schedules; anything else is shown as the cron itself. */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [mi, h, d, mo, w] = parts as [string, string, string, string, string];
  const num = (s: string) => /^\d+$/.test(s);
  if (mo !== "*") return `Cron ${expr}`;
  if (h === "*" && d === "*" && w === "*") {
    if (mi === "0") return "Every hour";
    if (num(mi)) return `Hourly at :${pad(Number(mi))}`;
    const step = mi.match(/^\*\/(\d+)$/);
    if (step) return `Every ${step[1]} minutes`;
  }
  if (num(mi) && num(h)) {
    const at = `${pad(Number(h))}:${pad(Number(mi))}`;
    if (d === "*" && w === "*") return `Daily at ${at}`;
    if (d === "*" && w === "1-5") return `Weekdays at ${at}`;
    if (d === "*" && num(w)) return `${DAY_NAMES[Number(w) % 7]} at ${at}`;
    if (num(d) && w === "*") return `Monthly on day ${d} at ${at}`;
  }
  return `Cron ${expr}`;
}

export function describeOnce(at: number): string {
  const t = new Date(at);
  const month = t.toLocaleString("en-US", { month: "short" });
  return `Once, ${month} ${t.getDate()} at ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
