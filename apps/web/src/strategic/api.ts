import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Supplier } from '../api/purchasing-types';
import type { Department, Item, Store } from '../api/types';

/** Types for slice 7 (forecasting, plans, tenders, contracts, supplier performance, portal). */

export interface SourcingMethodRule {
  code: string;
  label: string;
  minAmount: number | null;
  maxAmount: number | null;
  minBidders: number;
  requiresJustification: boolean;
  isActive: boolean;
}

export function useSourcingMethods() {
  return useQuery({ queryKey: ['/sourcing/methods'], queryFn: () => api<SourcingMethodRule[]>('/sourcing/methods'), staleTime: 300_000 });
}

/** Label for a method code from the configured list. */
export function methodLabel(rules: SourcingMethodRule[] | undefined, code: string | null | undefined) {
  if (!code) return '';
  return rules?.find((r) => r.code === code)?.label ?? code;
}

// ------------------------------------------------------------------ forecasting

export interface DemandForecast {
  id: string;
  storeId: string;
  store?: Store;
  itemId: string;
  item?: Item;
  method: string;
  startMonth: string;
  history: number[];
  baseline: number[];
  adjusted: number[];
  adjustments: { id: string; reasonCode: string; factor: number; months: string[] }[];
  backtestMape: number | null;
  position: number;
  demandOverCover: number;
  safetyStock: number;
  suggestedQty: number;
  generatedAt: string;
}

export interface ForecastDetail extends DemandForecast {
  months: string[];
  historyMonths: string[];
  accuracy: { month: string; forecastQty: number; actualQty: number; ape: number | null; method: string }[];
}

export interface AccuracyReport {
  overall: { pairs: number; mape: number | null };
  byMethod: { method: string; pairs: number; mape: number | null }[];
  worst: { code: string; name: string; store: string; mape: number; months: number }[];
}

export interface ForecastAdjustment {
  id: string;
  storeId: string | null;
  itemId: string | null;
  item?: Item | null;
  categoryId: string | null;
  reasonCode: string;
  description: string;
  factor: number;
  fromMonth: string;
  toMonth: string | null;
  isActive: boolean;
}

export interface SupplyPlanRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  uom: string;
  amc: number;
  forecastMonthly: number;
  onHand: number;
  available: number;
  onOrder: number;
  inTransit: number;
  pipeline: number;
  monthsOfStock: number | null;
  pipelineMonthsOfStock: number | null;
  minMonths: number;
  maxMonths: number;
  status: 'STOCK_OUT' | 'BELOW_MIN' | 'BELOW_MIN_COVERED' | 'ABOVE_MAX' | 'OK';
  leadTimeDays: number;
  unitCost: number;
}

export interface OrderSchedule {
  item: SupplyPlanRow;
  months: { month: string; demand: number; opening: number; arrival: number; closing: number; monthsOfStock: number | null }[];
  orders: { orderBy: string; arrivalMonth: string; quantity: number }[];
}

export interface Programme {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  commodities?: { id: string; itemId: string; item?: Item; unitsPerPatientMonth: number; regimenSharePercent: number; protocolNotes: string | null }[];
}

export interface QuantificationLine {
  itemId: string;
  itemCode: string;
  itemName: string;
  morbidityQty: number;
  consumptionQty: number;
  amc: number;
  differencePercent: number | null;
  available: number;
  finalQty: number;
  toProcure: number;
}

export interface Quantification {
  id: string;
  programmeId: string;
  programme?: Programme;
  storeId: string | null;
  title: string;
  periodMonths: number;
  targetPopulation: number;
  coveragePercent: number;
  wastagePercent: number;
  method: string;
  lines: QuantificationLine[];
  notes: string | null;
  createdAt: string;
}

export interface FundingSource {
  id: string;
  code: string;
  name: string;
  donor: string | null;
  programmeId: string | null;
  allowSale: boolean;
  allowedStoreIds: string[];
  allowedDepartmentIds: string[];
  notes: string | null;
  isActive: boolean;
}

export interface DonorStockRow {
  funding_source: string;
  funder: string | null;
  allow_sale: boolean | null;
  store_id: string;
  store: string;
  item_id: string;
  code: string;
  name: string;
  on_hand: number;
  value: number;
  earliest_expiry: string | null;
  batches: number;
  monthlyUse: number;
  monthsOfStock: number | null;
}

// ------------------------------------------------------------------ plans

export interface PlanLine {
  id: string;
  lineNo: number;
  itemId: string | null;
  item?: Item | null;
  description: string;
  categoryId: string | null;
  quantity: number;
  estimatedUnitCost: number;
  estimatedTotal: number;
  voteHead: string;
  sourcingMethod: string;
  plannedQuarter: number;
  sourceDepartmentIds: string[];
  notes: string | null;
}

export interface Plan {
  id: string;
  number: string;
  financialYear: string;
  departmentId: string | null;
  department?: Department | null;
  title: string;
  status: string;
  version: number;
  wasApproved: boolean;
  totalEstimate: number;
  consolidatedIntoId: string | null;
  revisionReason: string | null;
  lastComment: string | null;
  updatedAt: string;
  lines?: PlanLine[];
}

export interface PlanExecution {
  lines: { lineId: string; lineNo: number; description: string; plannedQty: number; plannedValue: number; procuredQty: number; procuredValue: number; spent: number; executionRate: number | null }[];
  planned: number;
  procured: number;
  spent: number;
  executionRate: number | null;
}

export interface PlanDetail extends Plan {
  versions: { version: number; reason: string | null; approvedBy: string | null; at: string }[];
  approvalHistory: { id: string; document_no: string; status: string; created_at: string; step_name: string | null; action: string | null; comment: string | null; acted_at: string | null; by: string | null }[];
  execution: PlanExecution;
  budgets: { vote_head: string; planned: number; budget: number | null }[];
}

// ------------------------------------------------------------------ tenders

export interface TenderLine {
  id: string;
  lineNo: number;
  itemId: string | null;
  item?: Item | null;
  description: string;
  quantity: number;
  specification: string | null;
}

export interface Criterion {
  id: string;
  stage: 'PRELIMINARY' | 'TECHNICAL' | 'FINANCIAL';
  name: string;
  weight: number;
  maxScore: number;
  sortOrder: number;
}

export interface Tender {
  id: string;
  number: string;
  title: string;
  description: string | null;
  method: string;
  requisitionId: string | null;
  departmentId: string | null;
  status: string;
  estimatedValue: number;
  invitedSupplierIds: string[];
  publishedAt: string | null;
  closingAt: string;
  openedAt: string | null;
  bidSecurityAmount: number;
  bidValidityDays: number;
  technicalWeight: number;
  technicalPassMark: number;
  recommendedBidId: string | null;
  evaluationReport: string | null;
  professionalOpinion: string | null;
  awardedBidId: string | null;
  awardedAt: string | null;
  standstillUntil: string | null;
  contractId: string | null;
  cancellationReason: string | null;
  createdAt: string;
  lines?: TenderLine[];
}

export interface TenderBid {
  id: string;
  supplierId: string;
  supplier?: string;
  submittedAt: string;
  status: string;
  viaPortal: boolean;
  bidSecurityRef: string | null;
  totalPrice?: number;
  deliveryDays?: number | null;
  technicalProposal?: string | null;
  technicalScore?: number | null;
  financialScore?: number | null;
  combinedScore?: number | null;
  rank?: number | null;
  lines?: { tenderLineId: string; unitPrice: number; offeredBrand: string | null }[];
}

export interface TenderDetail extends Tender {
  sealed: boolean;
  bids: TenderBid[];
  documents: { supplierId: string; supplier?: string; issuedAt: string; fee: number }[];
  clarifications: { id: string; supplierId: string | null; question: string; answer: string | null; isAddendum: boolean; answeredAt: string | null; createdAt: string }[];
  opening: { openedAt: string; attendees: string[]; openedBy: string[]; readouts: { bidId: string; supplier: string; totalPrice: number; bidSecurity: string | null; late: boolean }[]; minutes: string | null } | null;
  criteria: Criterion[];
  members: { id: string; userId: string; fullName: string; role: string; declaredAt: string | null; hasConflict: boolean | null }[];
  isMember: boolean;
}

export interface Evaluation {
  members: { id: string; userId: string; role: string; declaredAt: string | null; hasConflict: boolean | null; scoring: boolean }[];
  criteria: Criterion[];
  bids: {
    id: string;
    supplierId: string;
    supplier?: string;
    totalPrice: number;
    responsive: boolean;
    failedCriteria: string[];
    technicalScore: number | null;
    qualified: boolean;
    financialScore: number | null;
    combinedScore: number | null;
    rank: number | null;
  }[];
  complete: boolean;
  missing: { memberId: string; userId: string; bidId: string; criterion: string }[];
  undeclared: string[];
}

// ------------------------------------------------------------------ contracts

export interface ContractLine {
  id: string;
  itemId: string;
  item?: Item & { baseUom?: { code: string } };
  unitPrice: number;
  quantity: number | null;
  brand: string | null;
  calledOffQty: number;
  remainingQty: number | null;
  calledOffValue: number;
}

export interface Contract {
  id: string;
  number: string;
  title: string;
  supplierId: string;
  supplier?: Supplier;
  tenderId: string | null;
  type: 'FIXED' | 'FRAMEWORK';
  status: string;
  startDate: string;
  endDate: string;
  value: number;
  deliveryTerms: string | null;
  paymentTermsDays: number | null;
  leadTimeDays: number | null;
  signedAt: string | null;
  supplierSignatory: string | null;
  terminationReason: string | null;
}

export interface ContractDetail extends Contract {
  lines: ContractLine[];
  securities: { id: string; securityType: string; reference: string; issuer: string; amount: number; expiresOn: string; releasedOn: string | null }[];
  milestones: { id: string; description: string; dueDate: string; completedOn: string | null; notes: string | null }[];
  variations: { id: string; number: string; reason: string; changes: { endDate?: string; value?: number; lines?: { contractLineId?: string; itemId?: string; unitPrice?: number; quantity?: number | null }[] }; valueChange: number; status: string; lastComment: string | null; createdAt: string }[];
  callOffs: { id: string; number: string; status: string; orderDate: string; total: number; store: string }[];
  calledOffValue: number;
  remainingValue: number;
}

// ------------------------------------------------------------------ supplier performance and agencies

export interface Scorecard {
  id: string;
  supplierId: string;
  supplier?: Supplier;
  period: string;
  ordersDue: number;
  grnLines: number;
  invoiceLines: number;
  onTimeRate: number | null;
  inFullRate: number | null;
  otifRate: number | null;
  qualityRejectRate: number | null;
  priceComplianceRate: number | null;
  documentComplianceRate: number | null;
  overallScore: number | null;
}

export interface CorrectiveAction {
  id: string;
  supplierId: string;
  supplier?: Supplier;
  issue: string;
  actionRequired: string;
  dueDate: string | null;
  status: string;
  outcome: string | null;
  createdAt: string;
}

export interface Sanction {
  id: string;
  number: string;
  supplierId: string;
  supplier?: Supplier;
  type: string;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
  lifted: boolean;
  lastComment: string | null;
  createdAt: string;
}

export interface OrderTemplate {
  id: string;
  name: string;
  supplierId: string;
  supplier?: Supplier;
  storeId: string;
  store?: Store;
  departmentId: string;
  budgetId: string | null;
  frequencyMonths: number;
  nextOrderDate: string;
  leadTimeDays: number;
  quantityMode: 'FIXED' | 'SUGGESTED';
  lines: { itemId: string; quantity: number; uomId?: string | null }[];
  isActive: boolean;
  lastOrderedOn: string | null;
}

export interface AgencyOrder {
  id: string;
  number: string;
  status: string;
  orderDate: string;
  expectedDelivery: string | null;
  deliveryStage: string | null;
  acknowledgedAt: string | null;
  total: number;
  supplier: string;
  agency: string;
  store: string;
}

export interface DeliveryEvent {
  id: string;
  stage: string;
  reference: string | null;
  expectedDate: string | null;
  note: string | null;
  viaPortal: boolean;
  at: string;
}

export interface Kpis {
  period: { from: string; to: string };
  leadTimes: { prToPoDays: number | null; poToGrnDays: number | null; prToGrnDays: number | null; orders: number };
  planExecution: { financialYear: string; planned: number; procured: number; rate: number | null; basis: string };
  savings: { estimate: number; ordered: number; saved: number; percent: number | null };
  spend: {
    total: number;
    underContract: number;
    underContractPercent: number | null;
    bySupplier: { supplier: string; spend: number; orders: number }[];
    byCategory: { category: string; spend: number }[];
    byMethod: { method: string; spend: number; orders: number }[];
  };
  otif: { ordersDue: number; otif: number; percent: number | null };
  forecastAccuracy: { mape: number | null; pairs: number };
  agpo: { category: string; spend: number }[] | null;
}

// ------------------------------------------------------------------ portal

export interface PortalMe {
  supplier: { id: string; code: string; name: string; kraPin: string; email: string | null; phone: string | null; status: string; statusReason: string | null; prequalificationStatus: string | null; prequalifiedUntil: string | null; paymentTermsDays: number | null; bankAccount: string | null };
  documents: { documentType: string; reference: string | null; issuedOn: string | null; expiresOn: string | null }[];
  counts: { rfqs: number; tenders: number; unacknowledgedOrders: number };
}

export interface PortalTenderRow {
  id: string;
  number: string;
  title: string;
  method: string;
  status: string;
  closingAt: string;
  myBid: { status: string; submittedAt: string; totalPrice: number } | null;
}

export interface PortalTender {
  id: string;
  number: string;
  title: string;
  description: string | null;
  method: string;
  status: string;
  closingAt: string;
  bidSecurityAmount: number;
  bidValidityDays: number;
  lines: { id: string; lineNo: number; description: string; quantity: number; specification: string | null }[];
  clarifications: { id: string; question: string; answer: string | null; isAddendum: boolean; mine: boolean; answeredAt: string | null }[];
  myBid: (TenderBid & { lines: { tenderLineId: string; unitPrice: number; offeredBrand: string | null }[] }) | null;
  result: 'AWARDED' | 'NOT_SUCCESSFUL' | null;
}

export interface PortalRfqRow {
  id: string;
  number: string;
  title: string;
  closingDate: string;
  status: string;
  quoted: boolean;
}

export interface PortalRfq {
  id: string;
  number: string;
  title: string;
  closingDate: string;
  status: string;
  lines: { id: string; itemId: string; item?: string; uom?: string; quantity: number }[];
  quotation: { id: string; lines?: { rfqLineId: string; unitPrice: number; quantityOffered: number | null; offeredBrand: string | null }[] } | null;
  awardedLineIds: string[];
}

export interface PortalOrderRow {
  id: string;
  number: string;
  version: number;
  status: string;
  orderDate: string;
  expectedDelivery: string | null;
  total: number;
  currency: string;
  acknowledgedAt: string | null;
  deliveryStage: string | null;
  store?: { id: string; name: string };
}

export interface PortalOrder extends PortalOrderRow {
  lines: { lineNo: number; item?: string; uom?: string; quantity: number; unitPrice: number; lineTotal: number; receivedBaseQty: number; conversionFactor: number }[];
  deliveries: DeliveryEvent[];
}

export interface PortalSubmission {
  id: string;
  type: string;
  purchaseOrderId: string;
  purchaseOrder?: string;
  supplier?: string;
  reference: string;
  documentDate: string;
  amount: number | null;
  fileName: string | null;
  notes: string | null;
  status: string;
  reviewNote: string | null;
  createdAt: string;
}

export interface PortalPayment {
  number: string;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string | null;
  total: number;
  status: string;
  purchaseOrder: string;
  paidOn: string | null;
  paidAmount: number | null;
  paymentReference: string | null;
}
