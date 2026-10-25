import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CommitteeRole, ContractType, DeliveryStage, EvaluationStage, SanctionType, SupplierSubmissionType } from '@sil/shared';

const QTY = { maxDecimalPlaces: 4 } as const;
const MONEY = { maxDecimalPlaces: 4 } as const;
const FY = /^\d{4}(\/\d{2})?$/;

// ------------------------------------------------------------------ plans

export class PlanLineDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional({ description: 'Required without an item (services, works, new items)' }) @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiProperty({ description: 'Base units' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiProperty() @IsNumber(MONEY) @Min(0) estimatedUnitCost: number;
  @ApiProperty({ description: 'Budget vote head' }) @IsString() @MaxLength(40) voteHead: string;
  @ApiPropertyOptional({ description: 'Default: recommended for the line value' }) @IsOptional() @IsString() @MaxLength(40) sourcingMethod?: string;
  @ApiProperty() @IsInt() @Min(1) @Max(4) plannedQuarter: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CreatePlanDto {
  @ApiProperty({ example: '2026' }) @Matches(FY) financialYear: string;
  @ApiProperty() @IsUUID() departmentId: string;
  @ApiProperty() @IsString() @MaxLength(300) title: string;
  @ApiProperty({ type: [PlanLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PlanLineDto) lines: PlanLineDto[];
}

export class UpdatePlanDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) title?: string;
  @ApiProperty({ type: [PlanLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PlanLineDto) lines: PlanLineDto[];
}

export class RevisePlanDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) reason: string;
  @ApiProperty({ type: [PlanLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PlanLineDto) lines: PlanLineDto[];
}

export class ConsolidateDto {
  @ApiProperty() @Matches(FY) financialYear: string;
}

export class PlanQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(FY) financialYear?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) status?: string;
}

export class RecommendQueryDto {
  @ApiProperty() @Type(() => Number) @IsNumber() @Min(0) amount: number;
  @ApiPropertyOptional({ description: 'Comma-separated item ids (framework coverage)' }) @IsOptional() @IsString() @MaxLength(4000) itemIds?: string;
}

// ------------------------------------------------------------------ tenders

export class TenderLineDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiProperty() @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) specification?: string;
}

export class CriterionDto {
  @ApiProperty({ enum: [EvaluationStage.PRELIMINARY, EvaluationStage.TECHNICAL] }) @IsIn([EvaluationStage.PRELIMINARY, EvaluationStage.TECHNICAL]) stage: EvaluationStage;
  @ApiProperty() @IsString() @MaxLength(300) name: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100) weight?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(100) maxScore?: number;
}

export class CreateTenderDto {
  @ApiProperty() @IsString() @MaxLength(300) title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @ApiProperty({ example: 'OPEN_TENDER' }) @IsString() @MaxLength(40) method: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() requisitionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() planLineId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiProperty() @IsNumber(MONEY) @Min(0) estimatedValue: number;
  @ApiProperty() @IsDateString() closingAt: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber(MONEY) @Min(0) bidSecurityAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(730) bidValidityDays?: number;
  @ApiPropertyOptional({ description: '0 = lowest evaluated price' }) @IsOptional() @IsInt() @Min(0) @Max(100) technicalWeight?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100) technicalPassMark?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) invitedSupplierIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) justification?: string;
  @ApiProperty({ type: [TenderLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TenderLineDto) lines: TenderLineDto[];
  @ApiPropertyOptional({ type: [CriterionDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CriterionDto) criteria?: CriterionDto[];
}

export class IssueDocumentDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber(MONEY) @Min(0) fee?: number;
}

export class ClarificationDto {
  @ApiPropertyOptional({ description: 'Staff recording a question on behalf of a supplier' }) @IsOptional() @IsUUID() supplierId?: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(4000) question: string;
}

export class AnswerDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(4000) answer: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAddendum?: boolean;
  @ApiPropertyOptional({ description: 'For a new addendum' }) @IsOptional() @IsString() @MaxLength(4000) question?: string;
}

export class BidLineDto {
  @ApiProperty() @IsUUID() tenderLineId: string;
  @ApiProperty({ description: 'Per base unit, excl. VAT' }) @IsNumber(MONEY) @Min(0) unitPrice: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) offeredBrand?: string;
}

export class BidDto {
  @ApiProperty({ type: [BidLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => BidLineDto) lines: BidLineDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) bidSecurityRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber(MONEY) @Min(0) bidSecurityAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) deliveryDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) technicalProposal?: string;
}

export class StaffBidDto extends BidDto {
  @ApiProperty() @IsUUID() supplierId: string;
}

export class OpenTenderDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @IsString({ each: true }) @MaxLength(200, { each: true }) attendees: string[];
  @ApiPropertyOptional({ type: [String], description: 'Other officers who opened the bids' }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) openedBy?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10000) minutes?: string;
}

export class CommitteeMemberDto {
  @ApiProperty() @IsUUID() userId: string;
  @ApiProperty({ enum: CommitteeRole }) @IsEnum(CommitteeRole) role: CommitteeRole;
}

export class CommitteeDto {
  @ApiProperty({ type: [CommitteeMemberDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CommitteeMemberDto) members: CommitteeMemberDto[];
}

export class DeclarationDto {
  @ApiProperty() @IsBoolean() hasConflict: boolean;
  @ApiProperty({ description: 'Statement (and the nature of any conflict)' }) @IsString() @MinLength(5) @MaxLength(2000) declaration: string;
}

export class ScoreDto {
  @ApiProperty() @IsUUID() criterionId: string;
  @ApiProperty() @IsUUID() bidId: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) score: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

export class ScoresDto {
  @ApiProperty({ type: [ScoreDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ScoreDto) scores: ScoreDto[];
}

export class RecommendDto {
  @ApiProperty({ description: 'Evaluation report / committee recommendation' }) @IsString() @MinLength(10) @MaxLength(20000) report: string;
}

export class OpinionDto {
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(20000) opinion: string;
}

export class SecurityDto {
  @ApiProperty({ example: 'BANK_GUARANTEE' }) @IsString() @MaxLength(40) securityType: string;
  @ApiProperty() @IsString() @MaxLength(100) reference: string;
  @ApiProperty() @IsString() @MaxLength(200) issuer: string;
  @ApiProperty() @IsNumber(MONEY) @Min(0) amount: number;
  @ApiProperty() @IsDateString({ strict: true }) expiresOn: string;
}

export class SignTenderContractDto {
  @ApiProperty({ enum: ContractType }) @IsEnum(ContractType) type: ContractType;
  @ApiProperty() @IsDateString({ strict: true }) startDate: string;
  @ApiProperty() @IsDateString({ strict: true }) endDate: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) deliveryTerms?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) paymentTermsDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) leadTimeDays?: number;
  @ApiProperty() @IsString() @MaxLength(200) supplierSignatory: string;
  @ApiPropertyOptional({ type: SecurityDto }) @IsOptional() @ValidateNested() @Type(() => SecurityDto) security?: SecurityDto;
}

export class ReasonDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(1000) reason: string;
}

export class TenderQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
}

// ------------------------------------------------------------------ contracts

export class ContractLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ description: 'Per base unit, excl. VAT' }) @IsNumber(MONEY) @Min(0) unitPrice: number;
  @ApiPropertyOptional({ description: 'Base units; omit for a price-only line' }) @IsOptional() @IsNumber(QTY) @Min(0) quantity?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) brand?: string;
}

export class CreateContractDto {
  @ApiProperty() @IsString() @MaxLength(300) title: string;
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiProperty({ enum: ContractType }) @IsEnum(ContractType) type: ContractType;
  @ApiProperty() @IsDateString({ strict: true }) startDate: string;
  @ApiProperty() @IsDateString({ strict: true }) endDate: string;
  @ApiProperty() @IsNumber(MONEY) @Min(0) value: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) deliveryTerms?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) paymentTermsDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) leadTimeDays?: number;
  @ApiProperty({ type: [ContractLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ContractLineDto) lines: ContractLineDto[];
}

export class SignDto {
  @ApiProperty() @IsString() @MaxLength(200) supplierSignatory: string;
}

export class CallOffLineDto {
  @ApiProperty() @IsUUID() contractLineId: string;
  @ApiProperty({ description: 'In the ordering unit (default: base unit)' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() uomId?: string;
}

export class CallOffDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty() @IsUUID() departmentId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() budgetId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) expectedDelivery?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiProperty({ type: [CallOffLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CallOffLineDto) lines: CallOffLineDto[];
}

export class MilestoneDto {
  @ApiProperty() @IsString() @MaxLength(300) description: string;
  @ApiProperty() @IsDateString({ strict: true }) dueDate: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class NoteDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class VariationLineDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() contractLineId?: string;
  @ApiPropertyOptional({ description: 'New line (with unitPrice)' }) @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber(MONEY) @Min(0) unitPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(QTY) @Min(0) quantity?: number | null;
}

export class VariationChangesDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) endDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber(MONEY) @Min(0) value?: number;
  @ApiPropertyOptional({ type: [VariationLineDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VariationLineDto) lines?: VariationLineDto[];
}

export class VariationDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) reason: string;
  @ApiProperty({ type: VariationChangesDto }) @ValidateNested() @Type(() => VariationChangesDto) changes: VariationChangesDto;
}

export class ContractQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) type?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
}

// ------------------------------------------------------------------ performance

export class PeriodDto {
  @ApiProperty({ example: '2026-09' }) @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period: string;
}

export class ScorecardQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period?: string;
}

export class CorrectiveActionDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiProperty() @IsString() @MaxLength(2000) issue: string;
  @ApiProperty() @IsString() @MaxLength(2000) actionRequired: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) dueDate?: string;
}

export class CloseActionDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(2000) outcome: string;
}

export class SanctionDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiProperty({ enum: SanctionType }) @IsEnum(SanctionType) type: SanctionType;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) reason: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) effectiveFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) effectiveTo?: string;
}

export class ActionQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) status?: string;
}

// ------------------------------------------------------------------ agencies / delivery

export class TemplateLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsNumber(QTY) @Min(0) quantity: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() uomId?: string;
}

export class OrderTemplateDto {
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty() @IsUUID() departmentId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() budgetId?: string;
  @ApiProperty() @IsInt() @Min(1) @Max(24) frequencyMonths: number;
  @ApiProperty() @IsDateString({ strict: true }) nextOrderDate: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(365) leadTimeDays?: number;
  @ApiPropertyOptional({ enum: ['FIXED', 'SUGGESTED'] }) @IsOptional() @IsIn(['FIXED', 'SUGGESTED']) quantityMode?: 'FIXED' | 'SUGGESTED';
  @ApiProperty({ type: [TemplateLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TemplateLineDto) lines: TemplateLineDto[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class DeliveryDto {
  @ApiProperty({ enum: DeliveryStage }) @IsEnum(DeliveryStage) stage: DeliveryStage;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) expectedDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

// ------------------------------------------------------------------ portal

export class PortalQuotationLineDto {
  @ApiProperty() @IsUUID() rfqLineId: string;
  @ApiProperty() @IsNumber(MONEY) @Min(0) unitPrice: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(QTY) @Min(0) quantityOffered?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) offeredBrand?: string;
}

export class PortalQuotationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) supplierReference?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) validUntil?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) deliveryDays?: number;
  @ApiProperty({ type: [PortalQuotationLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PortalQuotationLineDto) lines: PortalQuotationLineDto[];
}

export class QuestionDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(4000) question: string;
}

export class AcknowledgeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class SubmissionDto {
  @ApiProperty({ enum: SupplierSubmissionType }) @IsEnum(SupplierSubmissionType) type: SupplierSubmissionType;
  @ApiProperty() @IsString() @MaxLength(60) reference: string;
  @ApiProperty() @IsDateString({ strict: true }) documentDate: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber(MONEY) @Min(0) amount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) fileName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class ReviewSubmissionDto {
  @ApiProperty({ enum: ['CAPTURED', 'REJECTED'] }) @IsIn(['CAPTURED', 'REJECTED']) status: 'CAPTURED' | 'REJECTED';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

// ------------------------------------------------------------------ KPIs

export class KpiQueryDto {
  @ApiProperty() @IsDateString({ strict: true }) from: string;
  @ApiProperty() @IsDateString({ strict: true }) to: string;
}
