import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Trading Bot — Silvijn Verhouden",
  description:
    "AI crypto day-trading bot: backtest-engine, paper trading en dashboard. Fase 1: backtesting op BTC/EUR.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="nl">
      <body>{children}</body>
    </html>
  );
}
