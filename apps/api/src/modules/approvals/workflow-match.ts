export interface WorkflowCandidate {
  id: string;
  code: string;
  documentType: string;
  minAmount: number | null;
  maxAmount: number | null;
  departmentId: string | null;
  itemCategoryId: string | null;
  priority: number;
  isActive: boolean;
}

export interface MatchInput {
  documentType: string;
  amount: number;
  departmentId?: string | null;
  /** Item categories on the document (any match counts). */
  itemCategoryIds?: string[];
}

/** Amount band is [min, max): min inclusive, max exclusive. */
export function inBand(amount: number, min: number | null, max: number | null): boolean {
  return amount >= (min ?? 0) && (max === null || amount < max);
}

/**
 * Picks the workflow for a document: same type, amount in band, department and
 * category filters satisfied; most specific first (department and category
 * each add one), then highest priority, then code for determinism.
 */
export function selectWorkflow<T extends WorkflowCandidate>(workflows: T[], input: MatchInput): T | null {
  const categories = new Set(input.itemCategoryIds ?? []);
  const matches = workflows.filter(
    (w) =>
      w.isActive &&
      w.documentType === input.documentType &&
      inBand(input.amount, w.minAmount, w.maxAmount) &&
      (w.departmentId === null || w.departmentId === input.departmentId) &&
      (w.itemCategoryId === null || categories.has(w.itemCategoryId)),
  );
  const specificity = (w: T) => (w.departmentId ? 1 : 0) + (w.itemCategoryId ? 1 : 0);
  matches.sort((a, b) => specificity(b) - specificity(a) || b.priority - a.priority || a.code.localeCompare(b.code));
  return matches[0] ?? null;
}
