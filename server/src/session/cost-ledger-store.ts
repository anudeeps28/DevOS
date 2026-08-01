// Cost Ledger Store — the SOLE reader/writer of the `cost_ledger` table.
//
// Mirrors session-store.ts: a thin, prepared-statement wrapper over one table.
// All SQL is prepared and parameterized — never string-concatenated.

import type { DatabaseHandle } from '../db/database.js';

/** Fields accepted when inserting a new cost ledger row. */
export interface CostLedgerInsert {
  readonly sessionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly at: number;
}

/** Aggregate cost/usage figures since local midnight of the reference time. */
export interface CostUsageAggregate {
  readonly costTodayUsd: number;
  readonly inputTokensToday: number;
  readonly outputTokensToday: number;
  readonly sinceEpochMs: number;
}

/** Public surface of the cost ledger store. */
export interface CostLedgerStore {
  readonly insert: (row: CostLedgerInsert) => void;
  readonly costToday: (now?: number) => CostUsageAggregate;
}

/** Raw shape of the `costToday` aggregate query result. */
interface CostAggregateDbRow {
  readonly c: number;
  readonly i: number;
  readonly o: number;
}

const SQL_INSERT = `INSERT INTO cost_ledger(session_id, input_tokens, output_tokens, cost_usd, at)
VALUES(@session_id, @input_tokens, @output_tokens, @cost_usd, @at)`;

const SQL_COST_TODAY = `SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
FROM cost_ledger WHERE at >= ?`;

function assertNonEmpty(value: string, field: string, op: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`CostLedgerStore.${op}: a non-empty ${field} is required.`);
  }
}

/**
 * Create a CostLedgerStore bound to an open database handle. The returned object is
 * the only component permitted to read or write the `cost_ledger` table.
 */
export function createCostLedgerStore(db: DatabaseHandle): CostLedgerStore {
  const insertStmt = db.raw.prepare(SQL_INSERT);
  const costTodayStmt = db.raw.prepare(SQL_COST_TODAY);

  const insert = (row: CostLedgerInsert): void => {
    assertNonEmpty(row.sessionId, 'session id', 'insert');
    try {
      insertStmt.run({
        session_id: row.sessionId,
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        cost_usd: row.costUsd,
        at: row.at,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `CostLedgerStore.insert: failed to insert cost row for session "${row.sessionId}": ${cause}`,
      );
    }
  };

  const costToday = (now: number = Date.now()): CostUsageAggregate => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const sinceEpochMs = d.getTime();
    try {
      const row = costTodayStmt.get(sinceEpochMs) as CostAggregateDbRow;
      return Object.freeze<CostUsageAggregate>({
        costTodayUsd: row.c,
        inputTokensToday: row.i,
        outputTokensToday: row.o,
        sinceEpochMs,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`CostLedgerStore.costToday: failed to read cost ledger: ${cause}`);
    }
  };

  return Object.freeze<CostLedgerStore>({ insert, costToday });
}
