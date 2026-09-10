"use client";

// ── Shell: vaste zijbalk + gedeelde topbalk voor alle pagina's ───────────
// Presentatielaag: leest alléén publieke status-endpoints (geen secrets).
// De PAPER-status is overal zichtbaar — dit systeem handelt NIET live.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useStatus } from "./status-store";
import { ago } from "./ui";

const NAV = [
  { href: "/", label: "OVERVIEW", icon: "◧" },
  { href: "/trades", label: "TRADES", icon: "≡" },
  { href: "/strategies", label: "STRATEGIES", icon: "◈" },
  { href: "/research", label: "RESEARCH", icon: "◎" },
  { href: "/validation", label: "VALIDATION", icon: "✓" },
  { href: "/market", label: "MARKET", icon: "∿" },
  { href: "/risk", label: "RISK", icon: "⛨" },
  { href: "/system", label: "SYSTEM", icon: "⚙" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const status = useStatus();

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { setOpen(false); }, [path]);

  const halted = status?.pot?.halted ?? false;
  const blofin = status?.blofin;
  const blofinOk = blofin?.live === true;
  const active = !halted;
  const current = NAV.find((n) => n.href === path);

  return (
    <div className="shell-root">
      {open && <div className="backdrop" onClick={() => setOpen(false)} />}
      <aside className={"sidebar" + (open ? " open" : "")}>
        <Link href="/" className="brand">
          <span className="brand-logo">◤</span>
          <div>
            <div className="brand-name">AI TRADING <span>SYSTEM</span></div>
            <div className="brand-sub">paper terminal</div>
          </div>
        </Link>
        <nav className="sidenav">
          {NAV.map((n) => {
            const isActive = path === n.href;
            return (
              <Link key={n.href} href={n.href} className={"navlink" + (isActive ? " active" : "")}>
                <span className="nav-ico">{n.icon}</span>{n.label}
              </Link>
            );
          })}
        </nav>
        <div className="side-foot">
          <div className="foot-row"><span>Modus</span><b>PAPER / DEMO</b></div>
          <div className="foot-row"><span>Status</span>
            {active ? <span className="pos">● ACTIVE</span> : <span className="neg">● HALTED</span>}
          </div>
          <div className="foot-row"><span>BloFin</span>
            {blofinOk ? <span className="pos">● DEMO OK</span> : <span className="faint">—</span>}
          </div>
          <div className="foot-row"><span>Update</span>{status ? ago((status as { __atIso?: string }).__atIso) : "…"}</div>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button className="hamburger" onClick={() => setOpen(!open)} aria-label="Menu">≡</button>
          <span className="topbar-title">{current?.label ?? "AI TRADING SYSTEM"}</span>
          <div className="topbar-right">
            {active
              ? <span className="badge green" key={tick}><span className="dot" />PAPER ACTIVE</span>
              : <span className="badge red" key={tick}><span className="dot" />PAPER HALTED</span>}
            {blofinOk
              ? <span className="badge cyan"><span className="dot" />BLOFIN DEMO CONNECTED</span>
              : blofin ? <span className="badge neutral"><span className="dot" />BLOFIN {blofin.live ? "" : "OFF"}</span> : null}
            <span className="faint mono">last update {status ? ago((status as { __atIso?: string }).__atIso) : "…"}</span>
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
