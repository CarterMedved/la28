import type { Dataset } from "../lib/load.ts";

export type Severity = "ERROR" | "WARN" | "INFO";

export interface Finding {
  /** Stable suppression key: rule path + row identifier, never a row number. */
  key: string;
  severity: Severity;
  rule: string;
  tab: string;
  rowId: string;
  message: string;
}

export interface RuleContext {
  ds: Dataset;
  /** YYYY-MM-DD — the clock every time-dependent rule reads. */
  refDate: string;
  sentinels: Set<string>;
}

export type Rule = (ctx: RuleContext) => Finding[];

export const finding = (severity: Severity, rule: string, tab: string, rowId: string, message: string, keySuffix = ""): Finding =>
  ({ key: `${rule}/${rowId}${keySuffix}`, severity, rule, tab, rowId, message });

/** Primary-key column per tab, so findings name rows by stable identifier. */
export const idOf = {
  events: (r: Record<string, unknown>) => String(r.olympic_event_id ?? "?"),
  comps: (r: Record<string, unknown>) => String(r.competition_id ?? "?"),
  links: (r: Record<string, unknown>) => String(r.link_id ?? "?"),
  rank: (r: Record<string, unknown>) => String(r.ranking_id ?? "?"),
  standings: (r: Record<string, unknown>) => `${r.ranking_id ?? "?"}#${r.team ?? "?"}`,
  cuts: (r: Record<string, unknown>) => String(r.cut_line_id ?? "?"),
  fixtures: (r: Record<string, unknown>) => String(r.fixture_id ?? "?"),
  qualified: (r: Record<string, unknown>) => `${r.olympic_event_id ?? "?"}#${r.team ?? "?"}`,
} as const;
