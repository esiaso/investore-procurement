import { selectWorkflow, WorkflowCandidate } from '../src/modules/approvals/workflow-match';
import { threeWayMatch } from '../src/modules/purchasing/matching';
import { rankQuotes } from '../src/modules/purchasing/rfqs.service';

const wf = (over: Partial<WorkflowCandidate>): WorkflowCandidate => ({
  id: over.code ?? 'x',
  code: 'x',
  documentType: 'PO',
  minAmount: null,
  maxAmount: null,
  departmentId: null,
  itemCategoryId: null,
  priority: 0,
  isActive: true,
  ...over,
});

describe('approval routing (unit)', () => {
  const bands = [
    wf({ code: 'PO-1', maxAmount: 500_000 }),
    wf({ code: 'PO-2', minAmount: 500_000, maxAmount: 5_000_000 }),
    wf({ code: 'PO-3', minAmount: 5_000_000 }),
    wf({ code: 'PR-1', documentType: 'PR', maxAmount: 100_000 }),
  ];

  it('routes by amount band with an inclusive lower and exclusive upper bound', () => {
    expect(selectWorkflow(bands, { documentType: 'PO', amount: 0 })?.code).toBe('PO-1');
    expect(selectWorkflow(bands, { documentType: 'PO', amount: 499_999.99 })?.code).toBe('PO-1');
    expect(selectWorkflow(bands, { documentType: 'PO', amount: 500_000 })?.code).toBe('PO-2');
    expect(selectWorkflow(bands, { documentType: 'PO', amount: 5_000_000 })?.code).toBe('PO-3');
    expect(selectWorkflow(bands, { documentType: 'PO', amount: 1e12 })?.code).toBe('PO-3');
  });

  it('matches a currency-specific workflow only for that currency, and prefers it', () => {
    const fx = [...bands, wf({ code: 'PO-USD', currency: 'USD' })];
    expect(selectWorkflow(fx, { documentType: 'PO', amount: 10, currency: 'USD' })?.code).toBe('PO-USD');
    expect(selectWorkflow(fx, { documentType: 'PO', amount: 10, currency: 'KES' })?.code).toBe('PO-1');
    expect(selectWorkflow(fx, { documentType: 'PO', amount: 10 })?.code).toBe('PO-1');
  });

  it('only matches the document type', () => {
    expect(selectWorkflow(bands, { documentType: 'PR', amount: 50 })?.code).toBe('PR-1');
    expect(selectWorkflow(bands, { documentType: 'PR', amount: 100_000 })).toBeNull();
    expect(selectWorkflow(bands, { documentType: 'INV', amount: 1 })).toBeNull();
  });

  it('prefers department- and category-specific workflows', () => {
    const list = [
      ...bands,
      wf({ code: 'PO-CAT', itemCategoryId: 'cns' }),
      wf({ code: 'PO-DEPT', departmentId: 'lab', maxAmount: 1_000_000 }),
      wf({ code: 'PO-BOTH', departmentId: 'lab', itemCategoryId: 'cns' }),
    ];
    expect(selectWorkflow(list, { documentType: 'PO', amount: 10, itemCategoryIds: ['cns'] })?.code).toBe('PO-CAT');
    expect(selectWorkflow(list, { documentType: 'PO', amount: 10, departmentId: 'lab' })?.code).toBe('PO-DEPT');
    expect(selectWorkflow(list, { documentType: 'PO', amount: 10, departmentId: 'lab', itemCategoryIds: ['x', 'cns'] })?.code).toBe('PO-BOTH');
    expect(selectWorkflow(list, { documentType: 'PO', amount: 2_000_000, departmentId: 'lab' })?.code).toBe('PO-2');
  });

  it('ignores inactive workflows and breaks ties by priority', () => {
    const list = [wf({ code: 'A', priority: 1 }), wf({ code: 'B', priority: 5 }), wf({ code: 'C', priority: 9, isActive: false })];
    expect(selectWorkflow(list, { documentType: 'PO', amount: 1 })?.code).toBe('B');
  });
});

describe('three-way match (unit)', () => {
  const base = { poLineId: 'l1', label: 'Line 1', orderedQty: 100, receivedQty: 80, previouslyInvoicedQty: 0, invoicedQty: 80, poUnitPrice: 10, invoiceUnitPrice: 10 };
  const tol = { quantityPct: 0, pricePct: 2 };

  it('matches when quantity and price agree', () => {
    expect(threeWayMatch([base], tol)).toEqual([]);
  });

  it('flags invoicing more than received, counting earlier invoices', () => {
    expect(threeWayMatch([{ ...base, invoicedQty: 81 }], tol).map((v) => v.code)).toEqual(['QTY_EXCEEDS_RECEIVED']);
    expect(threeWayMatch([{ ...base, invoicedQty: 40, previouslyInvoicedQty: 50 }], tol).map((v) => v.code)).toEqual(['QTY_EXCEEDS_RECEIVED']);
    expect(threeWayMatch([{ ...base, receivedQty: 0 }], tol).map((v) => v.code)).toEqual(['NOT_RECEIVED']);
  });

  it('applies the price tolerance both ways', () => {
    expect(threeWayMatch([{ ...base, invoiceUnitPrice: 10.2 }], tol)).toEqual([]);
    expect(threeWayMatch([{ ...base, invoiceUnitPrice: 10.21 }], tol).map((v) => v.code)).toEqual(['PRICE_VARIANCE']);
    expect(threeWayMatch([{ ...base, invoiceUnitPrice: 9.7 }], tol).map((v) => v.code)).toEqual(['PRICE_VARIANCE']);
  });

  it('applies the quantity tolerance', () => {
    expect(threeWayMatch([{ ...base, invoicedQty: 84 }], { quantityPct: 5, pricePct: 0 })).toEqual([]);
    expect(threeWayMatch([{ ...base, invoicedQty: 105, receivedQty: 100 }], { quantityPct: 5, pricePct: 0 })).toEqual([]);
    expect(threeWayMatch([{ ...base, invoicedQty: 106, receivedQty: 106 }], { quantityPct: 5, pricePct: 0 }).map((v) => v.code)).toEqual(['QTY_EXCEEDS_ORDERED']);
  });
});

describe('quotation ranking (unit)', () => {
  it('ranks compliant quotes by price then delivery, non-compliant last', () => {
    const ranked = rankQuotes([
      { id: 'a', unitPrice: 5, compliant: false, deliveryDays: 1 },
      { id: 'b', unitPrice: 8, compliant: true, deliveryDays: 10 },
      { id: 'c', unitPrice: 8, compliant: true, deliveryDays: 3 },
      { id: 'd', unitPrice: 9, compliant: true, deliveryDays: 1 },
    ]);
    expect(ranked.map((q) => q.id)).toEqual(['c', 'b', 'd', 'a']);
    expect(ranked.filter((q) => q.lowestCompliant).map((q) => q.id)).toEqual(['c']);
  });
});
