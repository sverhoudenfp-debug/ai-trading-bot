// ── Anthropic API-client voor de gecombineerde AI-agent ─────────────────
// Minimale, directe client (geen SDK nodig) met:
//   • prompt caching op het vaste systeem-instructie-deel (betaal je maar
//     één keer per 5 min, daarna lees-prijs — ~10x goedkoper)
//   • token-logging naar de tabel agent_runs (voor kosten-inzicht)
// Alleen server-side (never expose the key).

import { AI_MODEL, PRICE_PER_MTOK } from "./config";
import { insertAgentRun } from "./db";

export interface AiUsage {
  input_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens: number;
}

export interface AiCallResult {
  text: string;
  usage: AiUsage;
  costUsd: number;
}

export function estCostUsd(u: {
  input_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens: number;
}): number {
  const fresh = Math.max(0, u.input_tokens - (u.cache_read_input_tokens ?? 0) - (u.cache_creation_input_tokens ?? 0));
  return (
    (fresh / 1e6) * PRICE_PER_MTOK.in +
    ((u.cache_read_input_tokens ?? 0) / 1e6) * PRICE_PER_MTOK.cacheRead +
    ((u.cache_creation_input_tokens ?? 0) / 1e6) * PRICE_PER_MTOK.cacheWrite +
    (u.output_tokens / 1e6) * PRICE_PER_MTOK.out
  );
}

/**
 * Roept Claude Haiku aan. `systemStatic` (strategieën + risicoregels, cachebaar)
 * en `userDynamic` (verse koers-/nieuws-/prestatie-blok) samen.
 */
export async function callClaude(
  systemStatic: string,
  userDynamic: string,
  maxTokens = 1024
): Promise<AiCallResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY niet ingesteld");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system: [
        {
          type: "text",
          text: systemStatic,
          cache_control: { type: "ephemeral" }, // prompt caching voor het vaste deel
        },
      ],
      messages: [{ role: "user", content: userDynamic }],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const usage: AiUsage = {
    input_tokens: data.usage?.input_tokens ?? 0,
    cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
    output_tokens: data.usage?.output_tokens ?? 0,
  };
  const text = (data.content ?? [])
    .filter((c: { type: string }) => c.type === "text")
    .map((c: { text: string }) => c.text)
    .join("\n");
  return { text, usage, costUsd: estCostUsd(usage) };
}

/** AI-aanroep loggen (inclusief kosten-schatting) voor het dashboard. */
export async function logAiRun(r: {
  usage: AiUsage | null;
  costUsd: number;
  proposals: number;
  error?: string;
}): Promise<void> {
  try {
    await insertAgentRun({
      model: AI_MODEL,
      input_tokens: r.usage?.input_tokens ?? 0,
      cache_read_tokens: r.usage?.cache_read_input_tokens ?? 0,
      cache_creation_tokens: r.usage?.cache_creation_input_tokens ?? 0,
      output_tokens: r.usage?.output_tokens ?? 0,
      cost_usd_est: r.costUsd,
      proposals: r.proposals,
      error: r.error ?? null,
    });
  } catch {
    // logging mag de bot nooit breken
  }
}

/** JSON uit een AI-antwoord halen (vergeeft ```haken en voor-tekst). */
export function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("geen JSON in AI-antwoord");
  return JSON.parse(raw.slice(start, end + 1));
}
