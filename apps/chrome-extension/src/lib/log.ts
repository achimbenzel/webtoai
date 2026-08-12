/**
 * Capture log.
 *
 * Every degradation gets a code here as well as on the node, because the two
 * answer different questions: the node says "this rectangle is wrong", the log
 * says "47 elements were dropped for this reason". Nothing may be skipped or
 * approximated without going through this.
 */

export type LogLevel = "info" | "warn" | "unsupported";

export interface LogEntry {
  level: LogLevel;
  /** Machine-readable, matches the codes listed in docs/LIMITATIONS.md. */
  code: string;
  /** Element that triggered it, when there is one. */
  nodeName?: string;
  detail?: string;
}

export interface LogSummaryRow {
  code: string;
  level: LogLevel;
  count: number;
  examples: string[];
}

const EXAMPLE_LIMIT = 5;

export class CaptureLog {
  private readonly entries: LogEntry[] = [];

  add(level: LogLevel, code: string, nodeName?: string, detail?: string): void {
    const entry: LogEntry = { level, code };
    if (nodeName !== undefined) entry.nodeName = nodeName;
    if (detail !== undefined) entry.detail = detail;
    this.entries.push(entry);
  }

  unsupported(code: string, nodeName?: string, detail?: string): void {
    this.add("unsupported", code, nodeName, detail);
  }

  warn(code: string, nodeName?: string, detail?: string): void {
    this.add("warn", code, nodeName, detail);
  }

  info(code: string, nodeName?: string, detail?: string): void {
    this.add("info", code, nodeName, detail);
  }

  /** Records a batch of reason codes coming out of the CSS parsers. */
  addReasons(reasons: readonly string[], nodeName?: string, level: LogLevel = "warn"): void {
    for (const reason of reasons) this.add(level, reason, nodeName);
  }

  all(): readonly LogEntry[] {
    return this.entries;
  }

  /** Grouped by code, most frequent first — this is what the report shows. */
  summary(): LogSummaryRow[] {
    const rows = new Map<string, LogSummaryRow>();
    for (const entry of this.entries) {
      const existing = rows.get(entry.code);
      if (existing === undefined) {
        rows.set(entry.code, {
          code: entry.code,
          level: entry.level,
          count: 1,
          examples: entry.nodeName === undefined ? [] : [entry.nodeName],
        });
        continue;
      }
      existing.count += 1;
      if (entry.nodeName !== undefined && existing.examples.length < EXAMPLE_LIMIT) {
        existing.examples.push(entry.nodeName);
      }
    }
    return [...rows.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }
}
