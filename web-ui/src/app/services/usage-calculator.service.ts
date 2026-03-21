import { Injectable } from '@angular/core';
import { StandardizedUsage } from './chat.service';

// ─── March 2026 Price Book ────────────────────────────────────────────────────
// All rates are USD per 1 million tokens.
// Convention: nonCachedInput = input − cached; billed separately at different rates.

const GPT54_THRESHOLD   = 270_000;
const GPT54_TIER1       = { input: 2.50,  output: 15.00, cached: 0.25 };
const GPT54_TIER2       = { input: 5.00,  output: 30.00, cached: 0.50 }; // 2× when total > 270k

const CLAUDE46_THRESHOLD = 200_000;
const CLAUDE46_TIER1     = { input: 3.00,  output: 15.00, cached: 0.30 };
const CLAUDE46_TIER2     = { input: 6.00,  output: 30.00, cached: 0.60 }; // 2× when total > 200k

const GEMINI_PRO_THRESHOLD = 200_000;
const GEMINI_PRO_TIER1     = { input: 2.00,  output: 12.00, cached: 0.20 };
const GEMINI_PRO_TIER2     = { input: 4.00,  output: 18.00, cached: 0.40 };
const GEMINI_FLASH_FLAT    = { input: 0.50,  output:  3.00, cached: 0.05 };

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class UsageCalculatorService {

  constructor() {
    console.log(`[INIT] ${new Date().toISOString()} UsageCalculatorService initialized`);
  }

  /**
   * Calculate the USD cost for a single chat turn from a StandardizedUsage object.
   * Provider and model are already embedded in the usage object.
   */
  calculateCost(usage: StandardizedUsage | null): number {
    console.log(`[INIT] ${new Date().toISOString()} UsageCalculatorService.calculateCost() | provider: ${usage?.provider}`);

    if (!usage) {
      console.log(`[SUCCESS] ${new Date().toISOString()} calculateCost() → 0 (no usage data)`);
      return 0;
    }

    const { input, output, cached, provider } = usage;
    const nonCached = Math.max(0, input - cached);
    const total     = input + output;
    const m         = (usage.model ?? '').toLowerCase();

    let cost = 0;

    if (provider === 'ollama') {
      // ── Ollama — always free (local inference) ──────────────────────────
      cost = 0;
      console.log(`[SUCCESS] ${new Date().toISOString()} calculateCost() Ollama | cost: $0`);

    } else if (provider === 'openai') {
      // ── GPT-5.4 — tier doubles when total > 270k ────────────────────────
      const r = total > GPT54_THRESHOLD ? GPT54_TIER2 : GPT54_TIER1;
      const tier = total > GPT54_THRESHOLD ? 2 : 1;
      cost = (nonCached * r.input + cached * r.cached + output * r.output) / 1_000_000;
      console.log(`[SUCCESS] ${new Date().toISOString()} calculateCost() OpenAI Tier${tier} | cost: $${cost.toFixed(6)}`);

    } else if (provider === 'claude') {
      // ── Claude 4.6 — tier doubles when total > 200k ─────────────────────
      const r = total > CLAUDE46_THRESHOLD ? CLAUDE46_TIER2 : CLAUDE46_TIER1;
      const tier = total > CLAUDE46_THRESHOLD ? 2 : 1;
      cost = (nonCached * r.input + cached * r.cached + output * r.output) / 1_000_000;
      console.log(`[SUCCESS] ${new Date().toISOString()} calculateCost() Claude Tier${tier} | cost: $${cost.toFixed(6)}`);

    } else if (provider === 'gemini') {
      if (m.includes('flash')) {
        // ── Gemini Flash — flat rates ──────────────────────────────────────
        const r = GEMINI_FLASH_FLAT;
        cost = (nonCached * r.input + cached * r.cached + output * r.output) / 1_000_000;
        console.log(`[SUCCESS] ${new Date().toISOString()} calculateCost() Gemini Flash | cost: $${cost.toFixed(6)}`);

      } else if (m.includes('pro')) {
        // ── Gemini Pro — tier when total > 200k ───────────────────────────
        const r = total > GEMINI_PRO_THRESHOLD ? GEMINI_PRO_TIER2 : GEMINI_PRO_TIER1;
        const tier = total > GEMINI_PRO_THRESHOLD ? 2 : 1;
        cost = (nonCached * r.input + cached * r.cached + output * r.output) / 1_000_000;
        console.log(`[SUCCESS] ${new Date().toISOString()} calculateCost() Gemini Pro Tier${tier} | cost: $${cost.toFixed(6)}`);

      } else {
        console.log(`[SUCCESS] ${new Date().toISOString()} calculateCost() → 0 (unknown Gemini model: ${m})`);
      }

    } else {
      console.log(`[SUCCESS] ${new Date().toISOString()} calculateCost() → 0 (unknown provider: ${provider})`);
    }

    return cost;
  }

  /**
   * Calculate tokens-per-second for Ollama responses.
   * Returns 0 for all other providers or if latency is unavailable.
   */
  calcTps(usage: StandardizedUsage): number {
    if (!usage || usage.provider !== 'ollama' || usage.latencyMs <= 0) return 0;
    const tps = Math.round(usage.output / (usage.latencyMs / 1000));
    console.log(`[SUCCESS] ${new Date().toISOString()} calcTps() | ${usage.output} tokens / ${usage.latencyMs}ms = ${tps} tok/s`);
    return tps;
  }

  /** Format a token count for display (e.g. 1200 → "1.2k", 45000 → "45k"). */
  formatTokens(count: number): string {
    if (!count || count === 0) return '0';
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000)     return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return `${count}`;
  }
}
