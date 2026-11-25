// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

const dtFmt = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const dayFmt = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "N/A";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

export function duration(sec: number | null | undefined): string {
  if (!sec && sec !== 0) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return "N/A";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? "N/A" : dtFmt.format(d);
}

export function dayLabel(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : dayFmt.format(d);
}
