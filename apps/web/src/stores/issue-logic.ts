import type { PlanLine } from '../api/stores-types';

/** One candidate batch/bin of a line with the quantity the storekeeper will pick. */
export interface PickRow {
  key: string;
  batchId: string;
  binId: string | null;
  binCode: string | null;
  batchNo: string;
  expiryDate: string | null;
  available: number;
  /** FEFO suggestion. */
  suggested: number;
  quantity: number;
  /** Code that confirmed this pick, if scanned. */
  scannedCode?: string;
}

export interface LineState {
  line: PlanLine;
  rows: PickRow[];
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
export const pickKey = (batchId: string, binId: string | null) => `${batchId}|${binId ?? ''}`;

/** Every usable candidate, pre-filled with the FEFO suggestion. */
export function initialState(lines: PlanLine[]): LineState[] {
  return lines
    .filter((l) => l.outstandingQty > 0)
    .map((line) => ({
      line,
      rows: line.candidates.map((c) => {
        const s = line.picks.find((p) => p.batchId === c.batchId && p.binId === c.binId);
        return {
          key: pickKey(c.batchId, c.binId),
          batchId: c.batchId,
          binId: c.binId,
          binCode: c.binCode,
          batchNo: c.batchNo,
          expiryDate: c.expiryDate,
          available: c.available,
          suggested: s?.quantity ?? 0,
          quantity: s?.quantity ?? 0,
        };
      }),
    }));
}

export const lineTotal = (s: LineState) => round4(s.rows.reduce((t, r) => t + r.quantity, 0));

/**
 * True when the chosen quantities differ from what FEFO would pick for the
 * same total (rows are in FEFO order). Needs override permission + reason;
 * the server applies the same rule.
 */
export function overridesFefo(state: LineState[]): boolean {
  return state.some((s) => {
    let left = lineTotal(s);
    return s.rows.some((r) => {
      const fefo = round4(Math.min(r.available, Math.max(0, left)));
      left = round4(left - fefo);
      return round4(r.quantity) !== fefo;
    });
  });
}

/**
 * Confirms a pick from a scan: a batch number confirms that batch's pick; an
 * item barcode/GTIN/code confirms the item's first unconfirmed pick.
 * Returns the new state and what was confirmed (or null when nothing matched).
 */
export function applyScan(state: LineState[], raw: string): { state: LineState[]; matched: { lineNo: number; batchNo: string } | null } {
  const code = raw.trim().toLowerCase();
  if (!code) return { state, matched: null };
  const open = (r: PickRow) => r.quantity > 0 && !r.scannedCode;
  let target: { li: number; ri: number } | null = null;
  state.forEach((s, li) =>
    s.rows.forEach((r, ri) => {
      if (!target && open(r) && r.batchNo.toLowerCase() === code) target = { li, ri };
    }),
  );
  if (!target) {
    state.forEach((s, li) => {
      const ids = [s.line.barcode, s.line.gtin, s.line.itemCode].filter(Boolean).map((v) => String(v).toLowerCase());
      if (!target && ids.includes(code)) {
        const ri = s.rows.findIndex(open);
        if (ri >= 0) target = { li, ri };
      }
    });
  }
  if (!target) return { state, matched: null };
  const { li, ri } = target as { li: number; ri: number };
  const next = state.map((s, i) => (i !== li ? s : { ...s, rows: s.rows.map((r, j) => (j === ri ? { ...r, scannedCode: raw.trim() } : r)) }));
  return { state: next, matched: { lineNo: state[li].line.lineNo, batchNo: state[li].rows[ri].batchNo } };
}

export const allConfirmed = (state: LineState[]) => state.every((s) => s.rows.every((r) => r.quantity === 0 || !!r.scannedCode));

/** Request body for POST /store-requisitions/:id/issues. */
export function issueBody(state: LineState[]) {
  return state
    .filter((s) => lineTotal(s) > 0)
    .map((s) => ({
      requisitionLineId: s.line.requisitionLineId,
      picks: s.rows.filter((r) => r.quantity > 0).map((r) => ({ batchId: r.batchId, binId: r.binId, quantity: r.quantity, scannedCode: r.scannedCode })),
    }));
}
