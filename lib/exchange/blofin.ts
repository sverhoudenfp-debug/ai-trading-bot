// ── Blofin demo (paper-live) adapter ────────────────────────────────────
// Spiegelt de paper-trades van de bot naar het demo-account op Blofin
// (demo-trading-openapi.blofin.com). Altijd LONG-ONLY, hefboom 1x, cross
// margin: economisch gelijk aan spot, maar met een echte matching-engine.
// Alle bedragen zijn virtueel — dit blijft fase 2.

import crypto from "crypto";

const HOST = process.env.BLOFIN_DEMO_HOST ?? "https://demo-trading-openapi.blofin.com";

const API_KEY = process.env.BLOFIN_API_KEY ?? "";
const SECRET = process.env.BLOFIN_SECRET_KEY ?? "";
const PASSPHRASE = process.env.BLOFIN_PASSPHRASE ?? "";

export const blofinConfigured = Boolean(API_KEY && SECRET && PASSPHRASE);
export const blofinLive = blofinConfigured && (process.env.PAPER_LIVE ?? "") === "blofin";

// Bitvavo EUR-paar → Blofin USDT-instrument
export const BLOFIN_INST: Record<string, string> = {
  "BTC-EUR": "BTC-USDT",
  "ETH-EUR": "ETH-USDT",
  "SOL-EUR": "SOL-USDT",
  "XRP-EUR": "XRP-USDT",
};

interface Instrument {
  instId: string;
  contractValue: string; // 1 contract = ctVal coin (bijv. BTC: 0.001)
  lotSize: string;
  minSize: string;
}

let instrumentsCache: { at: number; data: Instrument[] } | null = null;

function sign(path: string, method: string, ts: string, nonce: string, body: string) {
  const prehash = `${path}${method}${ts}${nonce}${body}`;
  const hex = crypto.createHmac("sha256", SECRET).update(prehash).digest("hex");
  return Buffer.from(hex, "utf8").toString("base64");
}

async function blofin<T>(method: string, path: string, body?: unknown): Promise<T> {
  const ts = Date.now().toString();
  const nonce = crypto.randomUUID();
  const bodyStr = body ? JSON.stringify(body) : "";
  const res = await fetch(HOST + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": API_KEY,
      "ACCESS-SIGN": sign(path, method, ts, nonce, bodyStr),
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-NONCE": nonce,
      "ACCESS-PASSPHRASE": PASSPHRASE,
    },
    body: bodyStr || undefined,
    cache: "no-store",
  });
  const json = await res.json();
  if (json.code !== "0") throw new Error(`Blofin: ${json.msg} (${path})`);
  return json.data as T;
}

export async function getInstruments(): Promise<Instrument[]> {
  if (instrumentsCache && Date.now() - instrumentsCache.at < 3600_000) {
    return instrumentsCache.data;
  }
  const res = await fetch(`${HOST}/api/v1/market/instruments`, { cache: "no-store" });
  const json = await res.json();
  if (json.code !== "0") throw new Error("Blofin: instrumenten ophalen mislukt");
  instrumentsCache = { at: Date.now(), data: json.data as Instrument[] };
  return instrumentsCache.data;
}

export interface BlofinBalance {
  equityUsd: number;
  ts: string;
}

export async function getBalance(): Promise<BlofinBalance> {
  const d = await blofin<{ totalEquity: string; ts: string }>("GET", "/api/v1/account/balance");
  return { equityUsd: Number(d.totalEquity), ts: new Date(Number(d.ts)).toISOString() };
}

export interface BlofinPosition {
  instId: string;
  positions: string; // aantal contracts
  averagePrice: string;
  markPrice: string;
  unrealizedPnl: string;
}

export async function getPositions(): Promise<BlofinPosition[]> {
  return blofin<BlofinPosition[]>("GET", "/api/v1/account/positions");
}

/** Zet hefboom op 1x (cross) voor een instrument. */
export async function setLeverage1x(instId: string): Promise<void> {
  await blofin("POST", "/api/v1/account/set-leverage", {
    instId,
    leverage: "1",
    marginMode: "cross",
  });
}

/** Rond een coin-bedrag (bijv. 0.0032 BTC) af naar geldige contracts. */
export async function contractsFor(instId: string, coinAmount: number): Promise<number> {
  const list = await getInstruments();
  const inst = list.find((i) => i.instId === instId);
  if (!inst) throw new Error(`Blofin: onbekend instrument ${instId}`);
  const ctVal = Number(inst.contractValue);
  const lot = Number(inst.lotSize);
  const min = Number(inst.minSize);
  const contracts = Math.floor(coinAmount / ctVal / lot) * lot;
  return contracts >= min ? Number(contracts.toFixed(4)) : 0;
}

/** Open een long via market-order (net-modus, 1x). */
export async function marketLong(instId: string, contracts: number): Promise<string> {
  const d = await blofin<{ orderId: string }[]>("POST", "/api/v1/trade/order", {
    instId,
    marginMode: "cross",
    positionMode: "one_way",
    side: "buy",
    orderType: "market",
    size: String(contracts),
  });
  return d[0]?.orderId ?? "";
}

/** Sluit de gehele positie op een instrument (long → sell, short → buy back). */
export async function closePosition(instId: string): Promise<string> {
  const positions = await getPositions();
  const pos = positions.find((p) => p.instId === instId && Number(p.positions) !== 0);
  if (!pos) return "";
  const size = Math.abs(Number(pos.positions));
  const d = await blofin<{ orderId: string }[]>("POST", "/api/v1/trade/order", {
    instId,
    marginMode: "cross",
    positionMode: "one_way",
    side: Number(pos.positions) > 0 ? "sell" : "buy", // long sluiten = sell; short sluiten = buy back
    orderType: "market",
    size: String(size),
  });
  return d[0]?.orderId ?? "";
}

/** Open een short via market-order (sell, net-modus, 1x). */
export async function marketShort(instId: string, contracts: number): Promise<string> {
  const d = await blofin<{ orderId: string }[]>("POST", "/api/v1/trade/order", {
    instId,
    marginMode: "cross",
    positionMode: "one_way",
    side: "sell",
    orderType: "market",
    size: String(contracts),
  });
  return d[0]?.orderId ?? "";
}

/** Health-check: balans + open posities in één aanroep. */
export async function snapshot(): Promise<{
  configured: boolean;
  live: boolean;
  equityUsd: number | null;
  positions: { instId: string; contracts: number; entry: number; mark: number; upl: number }[];
  error?: string;
}> {
  if (!blofinConfigured) return { configured: false, live: false, equityUsd: null, positions: [] };
  try {
    const [bal, pos] = await Promise.all([getBalance(), getPositions()]);
    return {
      configured: true,
      live: blofinLive,
      equityUsd: bal.equityUsd,
      positions: pos.map((p) => ({
        instId: p.instId,
        contracts: Number(p.positions),
        entry: Number(p.averagePrice),
        mark: Number(p.markPrice),
        upl: Number(p.unrealizedPnl),
      })),
    };
  } catch (e) {
    return {
      configured: true,
      live: blofinLive,
      equityUsd: null,
      positions: [],
      error: String(e instanceof Error ? e.message : e),
    };
  }
}
