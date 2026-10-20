import { OrderTemplate, PurchaseOrderDelivery, SupplierSubmission } from './agencies.entities';
import { Contract, ContractLine, ContractMilestone, ContractVariation, PerformanceSecurity } from './contracts.entities';
import { CorrectiveAction, SupplierSanction, SupplierScorecard } from './performance.entities';
import { ProcurementPlan, ProcurementPlanLine, ProcurementPlanVersion } from './plans.entities';
import { Bid, BidLine, BidOpening, EvaluationCriterion, EvaluationMember, EvaluationScore, Tender, TenderClarification, TenderDocumentIssue, TenderLine } from './tenders.entities';

export const PROCUREMENT_ENTITIES = [
  ProcurementPlan,
  ProcurementPlanLine,
  ProcurementPlanVersion,
  Tender,
  TenderLine,
  TenderDocumentIssue,
  TenderClarification,
  Bid,
  BidLine,
  BidOpening,
  EvaluationMember,
  EvaluationCriterion,
  EvaluationScore,
  Contract,
  ContractLine,
  PerformanceSecurity,
  ContractMilestone,
  ContractVariation,
  SupplierScorecard,
  CorrectiveAction,
  SupplierSanction,
  OrderTemplate,
  PurchaseOrderDelivery,
  SupplierSubmission,
];
