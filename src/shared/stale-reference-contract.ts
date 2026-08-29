/** The shape of the one review finding that is not derivable from the diff.
 *
 * Kept in `shared/` rather than beside the server code that produces it for a
 * single reason: the finding is read by the heuristic panel in the browser,
 * and the panel must not reach into a module that spawns `git`. The producer
 * lives in `server/stale-references.ts` and re-exports these types, so there
 * is still one name for the contract. */
export interface StaleReference {
  symbol: string;
  filePath: string;
  line: number;
  /** The matching line, trimmed, so an obvious false positive can be dismissed
   * without opening the file. */
  text: string;
}

export interface StaleReferenceReport {
  /** The changed declarations that were searched for. Reported so an empty
   * result reads as "asked and found nothing" rather than "not checked". */
  symbols: string[];
  references: StaleReference[];
  /** Symbols with at least one reference left outside the patch. */
  staleSymbols: string[];
  /** True when a cap was hit, so a trimmed report never reads as complete. */
  truncated: boolean;
}

export const EMPTY_STALE_REFERENCE_REPORT: StaleReferenceReport = { symbols: [], references: [], staleSymbols: [], truncated: false };
