/**
 * Token-budgeted context assembler (infra spec §4).
 *
 * Replaces hand-concatenated prompt building: callers describe named sections
 * with priorities and trim policies; the assembler fills them greedily by
 * priority into a token budget, trims per policy, never truncates a floor'd
 * section, and returns a structured report that doubles as the debug view.
 *
 * Deterministic: identical inputs produce identical output. Token estimation
 * is chars/4 — the single estimator for this repo's context budgeting.
 */

export type TrimPolicy = "drop" | "truncate" | "summarize";

export interface ContextSection {
  /** Stable identifier, e.g. "persona", "memory:decisions.md", "inbox". */
  name: string;
  /** Higher fills first. Ties break on insertion order. */
  priority: number;
  content: string;
  /** What to do when the section doesn't fit the remaining budget. */
  trim: TrimPolicy;
  /**
   * Floor'd sections are never truncated or dropped; they always render in
   * full. Use sparingly (persona identity, required instructions).
   */
  floor?: boolean;
}

export interface ContextBudget {
  /** Token budget available to all sections combined. */
  totalTokens: number;
}

export interface AssembledSection {
  name: string;
  tokens: number;
  trimmed: boolean;
}

export interface AssembledContext {
  prompt: string;
  /** Final per-section token usage, in fill order. */
  sections: AssembledSection[];
  /** Names of sections dropped entirely by budget pressure. */
  dropped: string[];
  /** Total tokens used across all rendered sections. */
  usedTokens: number;
  /** The budget that was applied. */
  budgetTokens: number;
}

/** Repo-wide token estimator: chars/4, ceiling. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SUMMARIZE_MARKER = "\n[... summarized — truncated by context budget]";

function truncateToTokenBudget(content: string, tokenBudget: number, marker = ""): string {
  const markerBudget = marker ? estimateTokens(marker) : 0;
  const charBudget = Math.max(0, (tokenBudget - markerBudget) * 4);
  return content.slice(0, charBudget) + marker;
}

/**
 * Fill sections into `budget` greedily by priority and render the final prompt.
 * Sections render in the order supplied — priority governs *who gets tokens*,
 * not document order. A floor'd section always renders in full, even if that
 * exceeds the budget.
 */
export function assembleContext(sections: ContextSection[], budget: ContextBudget): AssembledContext {
  const ordered = sections.map((s, i) => ({ section: s, order: i }));
  // Greedy fill: priority desc, stable by insertion order.
  const fillOrder = [...ordered].sort(
    (a, b) => b.section.priority - a.section.priority || a.order - b.order
  );

  let remaining = Math.max(0, budget.totalTokens);
  const rendered = new Map<number, { text: string; tokens: number; trimmed: boolean }>();
  const dropped: string[] = [];

  for (const { section, order } of fillOrder) {
    const est = estimateTokens(section.content);
    if (section.floor || est <= remaining) {
      rendered.set(order, { text: section.content, tokens: est, trimmed: false });
      remaining = Math.max(0, remaining - est);
      continue;
    }
    switch (section.trim) {
      case "drop":
        dropped.push(section.name);
        break;
      case "truncate": {
        const text = truncateToTokenBudget(section.content, remaining);
        const tokens = Math.min(est, remaining);
        rendered.set(order, { text, tokens, trimmed: true });
        remaining = 0;
        break;
      }
      case "summarize": {
        // No model pass here — deterministic head-truncation with an explicit
        // marker. A summarizing caller can pre-summarize into content instead.
        const text = truncateToTokenBudget(section.content, remaining, SUMMARIZE_MARKER);
        const tokens = Math.min(est, remaining);
        rendered.set(order, { text, tokens, trimmed: true });
        remaining = 0;
        break;
      }
    }
  }

  const parts: string[] = [];
  const finalSections: AssembledSection[] = [];
  let usedTokens = 0;
  for (const { order } of ordered) {
    const r = rendered.get(order);
    if (!r) continue;
    parts.push(r.text);
    finalSections.push({ name: sections[order].name, tokens: r.tokens, trimmed: r.trimmed });
    usedTokens += r.tokens;
  }

  return {
    prompt: parts.join("\n\n"),
    sections: finalSections,
    dropped,
    usedTokens,
    budgetTokens: budget.totalTokens,
  };
}

/** Compact one-line encoding of the report for flat telemetry payloads. */
export function formatAssemblyReport(assembled: AssembledContext): {
  sections: string;
  dropped: string;
  usedTokens: number;
  budgetTokens: number;
} {
  return {
    sections: assembled.sections.map((s) => `${s.name}:${s.tokens}${s.trimmed ? "~" : ""}`).join(","),
    dropped: assembled.dropped.join(","),
    usedTokens: assembled.usedTokens,
    budgetTokens: assembled.budgetTokens,
  };
}
