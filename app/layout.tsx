import type { Metadata } from "next";
import { Orbitron, Rajdhani, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const orbitron = Orbitron({ subsets: ["latin"], weight: ["500", "700", "800"], variable: "--font-orbitron" });
const rajdhani = Rajdhani({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-rajdhani" });
const jbmono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-jbmono" });

export const metadata: Metadata = {
  title: "AI Trading Bot — Silvijn Verhouden",
  description:
    "AI crypto day-trading bot: backtest-engine, paper trading en dashboard. Fase 2: paper-live op Blofin demo, 8 coins, één pot.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="nl" className={`${orbitron.variable} ${rajdhani.variable} ${jbmono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
