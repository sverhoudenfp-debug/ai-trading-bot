"use client";

// ── Gedeelde presentatie-componenten voor het dashboard ──────────────────
// Puur weergave: geen business-logica, geen data-ophaal-logica (die zit in
// status-store). Alle cijfers komen uit de bestaande endpoints.

import { useCallback, useEffect, useRef, useState } from "react";

/* ── formatters ── */
export const eur = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined ? "—" : `${v >= 0 ? "€" : "−€"}${Math.abs(v).toFixed(dp)}`;
export const pct = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined ? "—" : `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(dp)}%`;
export const signed = (v: number | null | undefined, suffix = "", dp = 2) =>
  v === null || v === undefined ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}${suffix}`;
export const dur = (min: number | null | undefined) => {
  if (min === null || min === undefined) return "—";
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.floor(min / 60)}u ${Math.round(min % 60)}m`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}u`;
};
export const ago = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}u`;
  return `${Math.floor(s / 86400)}d`;
};
export const dt = (iso: string | null | undefined) =>
  !iso ? "—" : new Date(iso).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });

/* ── panel ── */
export function Panel({ title, note, children, className }: {
  title?: string; note?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={"panel" + (className ? " " + className : "")}>
      {title && <h2 className="panel-title">{title}{note !== undefined && <span className="panel-note">{note}</span>}</h2>}
      {children}
    </section>
  );
}

/* ── badge met dot ── */
export type BadgeTone = "green" | "red" | "amber" | "cyan" | "neutral";
export function Badge({ tone, children, dot = true }: { tone: BadgeTone; children: React.ReactNode; dot?: boolean }) {
  return <span className={`badge ${tone}`}>{dot && <span className="dot" />}{children}</span>;
}

export function pnlClass(v: number | null | undefined) {
  if (v === null || v === undefined) return "dim";
  return v > 0 ? "pos" : v < 0 ? "neg" : "dim";
}

/* ── KPI tile ── */
export function Kpi({ label, value, sub, tone }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  tone?: "pos" | "neg" | null;
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className={"kpi-value" + (tone === "pos" ? " pos" : tone === "neg" ? " neg" : "")}>{value}</span>
      {sub !== undefined && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

/* ── states ── */
export function Loading({ h = 90 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h }} />;
}
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="state-box">
      <span className="big">{title}</span>
      {hint && <span className="dim">{hint}</span>}
    </div>
  );
}
export function ErrorState({ retry }: { retry?: () => void }) {
  return (
    <div className="state-box">
      <span className="big">Kan data niet laden</span>
      <span>De API reageert niet — de trading-engine draait gewoon door.</span>
      {retry && <button onClick={retry}>Opnieuw proberen</button>}
    </div>
  );
}

/* ── generieke fetch-hook: loading / error / retry / interval ── */
export function useJson<T>(url: string | null, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const urlRef = useRef(url);
  urlRef.current = url;

  const load = useCallback(async () => {
    if (!urlRef.current) return;
    try {
      const r = await fetch(urlRef.current);
      const j = await r.json();
      if (j && !j.error) { setData(j as T); setError(false); }
      else setError(true);
    } catch { setError(true); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
    if (intervalMs) {
      const t = setInterval(load, intervalMs);
      return () => clearInterval(t);
    }
  }, [url, intervalMs, load]);

  return { data, error, loading, retry: load };
}

/* ── sparkline (SVG, kleine chart) ── */
export function Sparkline({ values, w = 150, h = 34, tone = "auto" }: {
  values: number[]; w?: number; h?: number; tone?: "auto" | "green" | "red";
}) {
  if (!values || values.length < 2) return <span className="faint">—</span>;
  const min = Math.min(...values); const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) =>
    `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`);
  const up = values[values.length - 1] >= values[0];
  const color = tone === "auto" ? (up ? "var(--green)" : "var(--red)") : tone === "green" ? "var(--green)" : "var(--red)";
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.4} />
    </svg>
  );
}

/* ── equity chart (SVG: area + hwm + tooltip) ─────────────────────────────
   points: [{t, eq}] — echte equity-reeks uit /api/paper/trades aggregates */
export function EquityChart({ points, start }: { points: { t: string; eq: number }[]; start: number }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(900);
  const h = 240;

  useEffect(() => {
    if (!boxRef.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(280, e[0].contentRect.width)));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, []);

  if (!points || points.length < 1) return <EmptyState title="Nog geen equity-geschiedenis" hint="De curve ontstaat zodra de eerste trades sluiten." />;

  const all = [start, ...points.map((p) => p.eq)];
  const min = Math.min(...all); const max = Math.max(...all);
  const span = max - min || 1;
  const padL = 6; const padR = 6; const padB = 16;
  const X = (i: number) => padL + (i / Math.max(1, points.length - 1)) * (w - padL - padR);
  const Y = (v: number) => (h - padB) - ((v - min) / span) * (h - padB - 8);

  // high water mark
  let hwm = start; const hwmPts: string[] = [];
  const eqPts: string[] = [];
  points.forEach((p, i) => { hwm = Math.max(hwm, p.eq); hwmPts.push(`${X(i)},${Y(hwm)}`); eqPts.push(`${X(i)},${Y(p.eq)}`); });

  const area = `M${X(0)},${Y(start)} ` + eqPts.map((pt, i) => `L${pt}`).join(" ") + ` L${X(points.length - 1)},${h - padB} L${X(0)},${h - padB} Z`;
  const upTrend = points.length ? points[points.length - 1].eq >= start : true;
  const lineColor = upTrend ? "var(--green)" : "var(--red)";
  const areaColor = upTrend ? "rgba(52,211,153,0.07)" : "rgba(248,113,113,0.06)";

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round(((x - padL) / Math.max(1, w - padL - padR)) * (points.length - 1));
    const p = points[Math.max(0, Math.min(points.length - 1, idx))];
    if (tipRef.current) {
      tipRef.current.style.display = "block";
      tipRef.current.style.left = `${X(Math.max(0, Math.min(points.length - 1, idx)))}px`;
      tipRef.current.style.top = `${Y(p.eq)}px`;
      tipRef.current.textContent = `${dt(p.t)} · ${eur(p.eq)}`;
    }
  };
  const onLeave = () => { if (tipRef.current) tipRef.current.style.display = "none"; };

  return (
    <div className="chart-box" ref={boxRef}>
      <div className="chart-legend">
        <span className="legend-chip"><i style={{ background: lineColor }} />equity (na fees)</span>
        <span className="legend-chip"><i style={{ background: "var(--text-faint)" }} />high water mark</span>
        <span className="legend-chip" style={{ marginLeft: "auto" }}>start {eur(start)} · huidig {eur(points[points.length - 1].eq)} · laagste {eur(min)}</span>
      </div>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} onMouseMove={onMove} onMouseLeave={onLeave}>
        {/* gridlines */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={padL} x2={w - padR} y1={f * (h - padB)} y2={f * (h - padB)} stroke="var(--border-soft)" strokeWidth={1} />
        ))}
        <path d={area} fill={areaColor} />
        <polyline points={hwmPts.join(" ")} fill="none" stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="3 4" />
        <polyline points={eqPts.join(" ")} fill="none" stroke={lineColor} strokeWidth={1.7} />
        {/* start-referentielijn */}
        <line x1={padL} x2={w - padR} y1={Y(start)} y2={Y(start)} stroke="var(--border)" strokeWidth={1} />
      </svg>
      <div className="eq-tooltip" ref={tipRef} />
    </div>
  );
}

/* ── lifecycle-status → badge-kleur (alleen statussen die de backend kent) ── */
export function statusTone(s: string): BadgeTone {
  if (["PAPER_ACTIVE", "PAPER_APPROVED", "RESEARCH_CANDIDATE"].includes(s)) return "green";
  if (["FAILED", "ROLLED_BACK", "REJECTED"].includes(s)) return "red";
  if (["VALIDATION_EARLY", "VALIDATION_PROGRESS", "VALIDATION_READY", "VALIDATION_PENDING",
    "PAPER_CANDIDATE", "WAITING_FOR_CANARY_SLOT", "PAPER_VALIDATING", "TESTING"].includes(s)) return "amber";
  return "neutral";
}

/* ── meter (huidig vs limiet) ── */
export function Meter({ ratio, warn = 0.7, crit = 0.9 }: { ratio: number; warn?: number; crit?: number }) {
  const r = Math.max(0, Math.min(1, ratio));
  return (
    <div className="meter"><i style={{ width: `${r * 100}%` }} className={r >= crit ? "crit" : r >= warn ? "warn" : ""} /></div>
  );
}
