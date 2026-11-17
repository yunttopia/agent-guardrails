// Time helpers (Asia/Seoul).
export type Clock = () => Date;

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function seoulIso(d: Date): string {
  const s = new Date(d.getTime() + SEOUL_OFFSET_MS);
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}T${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}:${pad(s.getUTCSeconds())}+09:00`;
}

export function seoulDate(d: Date): string {
  return seoulIso(d).slice(0, 10);
}

export function seoulDateCompact(d: Date): string {
  return seoulDate(d).replaceAll("-", "");
}

export function seoulMonth(d: Date): `${number}-${number}` {
  return seoulDate(d).slice(0, 7) as `${number}-${number}`;
}

export function budgetPeriod(now: Date): { day: string; month: string } {
  const shifted = new Date(now.getTime() - 4 * 3_600_000);
  const day = seoulDate(shifted);
  return { day, month: day.slice(0, 7) };
}

export function seoulWeekday(d: Date): boolean {
  const day = new Date(d.getTime() + SEOUL_OFFSET_MS).getUTCDay();
  return day >= 1 && day <= 5;
}

export function parseIso(s: string): Date {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`not an ISO time: ${s}`);
  return new Date(t);
}
