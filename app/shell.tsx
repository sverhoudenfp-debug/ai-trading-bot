"use client";

// ── Shell: vaste zijbalk + gedeelde topbalk voor alle pagina's ───────────
// Navigatie: Dashboard (live pot/coins/grafieken), AI-Zoektocht (wat de
// AI-agent elke minuut ziet en voorstelt) en Orders (complete historie).

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/", label: "DASHBOARD", icon: "◧", hint: "pot · coins · grafieken" },
  { href: "/ai", label: "AI-ZOCHTTOCHT", icon: "◎", hint: "scans · voorstellen · strategieën" },
  { href: "/orders", label: "ORDERS", icon: "≡", hint: "complete trade-historie" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [clock, setClock] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString("nl-NL")), 1000);
    setClock(new Date().toLocaleTimeString("nl-NL"));
    return () => clearInterval(t);
  }, []);

  return (
    <div className="shell">
      <aside className={"sidebar" + (open ? " open" : "")}>
        <Link href="/" className="brand" onClick={() => setOpen(false)}>
          <span className="logo">◤</span>
          <div>
            <div className="brand-name">AI TRADING <span>SYSTEM</span></div>
            <div className="brand-sub">mission control</div>
          </div>
        </Link>
        <nav className="sidenav">
          {NAV.map((n) => {
            const active = path === n.href;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={"sidenav-item" + (active ? " active" : "")}
                onClick={() => setOpen(false)}
              >
                <span className="sni-icon">{n.icon}</span>
                <span className="sni-label">{n.label}</span>
                <span className="sni-hint">{n.hint}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <span className="heartbeat"><i /> LIVE</span>
          <span className="sfoot-phase">FASE 2 · PAPER</span>
          <span className="sfoot-note">leerproject — geen echt geld</span>
        </div>
      </aside>
      <div className="content">
        <header className="topbar slim">
          <button className="sidenav-toggle" onClick={() => setOpen((o) => !o)}>☰</button>
          <div className="topbar-title">
            {NAV.find((n) => n.href === path)?.label ?? "DASHBOARD"}
            <span className="heartbeat" style={{ marginLeft: 12 }}><i /> AI-agent actief</span>
          </div>
          <span className="clock">{clock}</span>
        </header>
        {children}
      </div>
      {open && <div className="sidenav-backdrop" onClick={() => setOpen(false)} />}
    </div>
  );
}
