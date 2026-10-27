import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  MinLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RequisitionPriority } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';
import { WitnessDto } from '../inventory/inventory.dto';

const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);
const QTY = { maxDecimalPlaces: 4 } as const;

export class DocListQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() purchaseOrderId?: string;
}

export class ReasonDto {
  @ApiProperty() @IsString() @MaxLength(1000) reason: string;
}

// ------------------------------------------------------------------ requisitions

export class RequisitionLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ description: 'Base units' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional({ description: 'Per base unit; default: last cost or catalogue price' }) @IsOptional() @IsNumber(QTY) @Min(0) estimatedUnitPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CreateRequisitionDto {
  @ApiProperty() @IsUUID() departmentId: string;
  @ApiProperty({ description: 'Store the goods are for' }) @IsUUID() storeId: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() budgetId?: string | null;
  @ApiPropertyOptional({ enum: RequisitionPriority }) @IsOptional() @IsEnum(RequisitionPriority) priority?: RequisitionPriority;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) requiredBy?: string | null;
  @ApiProperty() @IsString() @MaxLength(2000) justification: string;
  @ApiPropertyOptional({ description: 'Sourcing method code (setting procurement.sourcingMethods); default: the recommended one' }) @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(40) sourcingMethod?: string | null;
  @ApiPropertyOptional({ description: 'Required for methods such as direct procurement' }) @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(2000) sourcingJustification?: string | null;
  @ApiProperty({ type: [RequisitionLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => RequisitionLineDto)
  lines: RequisitionLineDto[];
}

// ------------------------------------------------------------------ RFQs

export class CreateRfqDto {
  @ApiPropertyOptional({ description: 'Approved requisition to quote for' }) @IsOptional() @IsUUID() requisitionId?: string;
  @ApiProperty() @IsString() @MaxLength(300) title: string;
  @ApiProperty() @IsDateString({ strict: true }) closingDate: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @IsUUID('all', { each: true }) supplierIds: string[];
  @ApiPropertyOptional({ type: [RequisitionLineDto], description: 'Only when not from a requisition' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RequisitionLineDto)
  lines?: RequisitionLineDto[];
}

export class QuotationLineDto {
  @ApiProperty() @IsUUID() rfqLineId: string;
  @ApiProperty({ description: 'Per base unit (stock) or per unit of the line (non-stock), excl. VAT, in the quotation currency' }) @IsNumber(QTY) @Min(0) unitPrice: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(QTY) @Min(0) quantityOffered?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) offeredBrand?: string;
}

export class RecordQuotationDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) supplierReference?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) validUntil?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) deliveryDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() compliant?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) complianceNotes?: string;
  @ApiPropertyOptional({ description: 'Currency of the prices (default: base currency)' }) @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [QuotationLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => QuotationLineDto)
  lines: QuotationLineDto[];
}

export class AwardLineDto {
  @ApiProperty() @IsUUID() rfqLineId: string;
  @ApiProperty() @IsUUID() quotationLineId: string;
}

export class AwardRfqDto {
  @ApiProperty({ type: [AwardLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => AwardLineDto)
  awards: AwardLineDto[];
  @ApiPropertyOptional({ description: 'Required when any line is not awarded to the lowest compliant quote' })
  @IsOptional() @IsString() @MaxLength(2000) justification?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) expectedDelivery?: string | null;
  @ApiPropertyOptional({ description: 'LPO / LSO: delivery address or the final user' }) @IsOptional() @IsString() @MaxLength(500) deliveryAddress?: string;
}

export class SendRfqDto {
  @ApiPropertyOptional({ description: 'Required when fewer suppliers are invited than purchasing.rfqMinSuppliers' }) @IsOptional() @IsString() @MaxLength(1000) fewerSuppliersJustification?: string;
}

export class EvaluationSetupDto {
  @ApiProperty({ description: 'Weight of the technical score (0 = price only, 100 = technical only)' }) @IsInt() @Min(0) @Max(100) technicalWeight: number;
  @ApiPropertyOptional({ description: 'Minimum average technical score (default purchasing.rfqPassMark)' }) @IsOptional() @IsInt() @Min(0) @Max(100) passMark?: number;
  @ApiProperty({ type: [String], description: 'Evaluation committee members (each scores every compliant quotation)' }) @IsArray() @ArrayMaxSize(15) @IsUUID('all', { each: true }) committeeUserIds: string[];
}

export class ScoreDto {
  @ApiProperty() @IsUUID() quotationId: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) technicalScore: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

export class EvaluateDto {
  @ApiProperty({ description: 'Recommendation of the evaluation (who and why)' }) @IsString() @MinLength(5) @MaxLength(2000) recommendation: string;
}

// ------------------------------------------------------------------ purchase orders

export class PoLineDto {
  @ApiPropertyOptional({ description: 'Requisition line being ordered' }) @IsOptional() @IsUUID() requisitionLineId?: string;
  @ApiPropertyOptional({ description: 'Required unless requisitionLineId is given' }) @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional({ description: 'Ordering unit (default: base unit)' }) @IsOptional() @IsUUID() uomId?: string;
  @ApiPropertyOptional({ description: 'In ordering units (default: remaining requisition quantity)' }) @IsOptional() @IsNumber(QTY) @Min(0.0001) quantity?: number;
  @ApiPropertyOptional({ description: 'Per ordering unit excl. VAT (default: contract price)' }) @IsOptional() @IsNumber(QTY) @Min(0) unitPrice?: number;
  @ApiPropertyOptional({ description: 'Non-stock lines: tax category (default purchasing.nonStockTaxCategory)' }) @IsOptional() @IsUUID() taxCategoryId?: string;
  @ApiPropertyOptional({ description: 'Non-stock lines: withholding tax % (default purchasing.whtRates)' }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(50) whtRatePercent?: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiPropertyOptional({ description: 'Approved requisition (else: contract-price order)' }) @IsOptional() @IsUUID() requisitionId?: string;
  @ApiPropertyOptional({ description: 'Required without a requisition' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ description: 'Required without a requisition' }) @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() budgetId?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) expectedDelivery?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional({ description: 'Currency (default: base currency)' }) @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @ApiPropertyOptional({ description: 'LPO / LSO: delivery address or the final user' }) @IsOptional() @IsString() @MaxLength(500) deliveryAddress?: string;
  @ApiPropertyOptional({ description: 'Terms and conditions (default purchasing.lpoTerms for non-stock orders)' }) @IsOptional() @IsString() @MaxLength(5000) terms?: string;
  @ApiPropertyOptional({ description: 'Valid until (default: order date + purchasing.lpoValidityDays for non-stock orders)' }) @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) expiresOn?: string | null;
  @ApiProperty({ type: [PoLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PoLineDto)
  lines: PoLineDto[];
}

export class AmendPoLineDto {
  @ApiPropertyOptional({ description: 'Existing line (omit to add a line)' }) @IsOptional() @IsUUID() lineId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() uomId?: string;
  @ApiProperty() @IsNumber(QTY) @Min(0) quantity: number;
  @ApiProperty() @IsNumber(QTY) @Min(0) unitPrice: number;
}

export class AmendPurchaseOrderDto {
  @ApiProperty() @IsString() @MaxLength(1000) reason: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) expectedDelivery?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiProperty({ type: [AmendPoLineDto], description: 'The full new set of lines; lines left out are removed' })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => AmendPoLineDto)
  lines: AmendPoLineDto[];
}

// ------------------------------------------------------------------ GRNs

export class GrnLineDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() poLineId?: string;
  @ApiPropertyOptional({ description: 'Required without a PO line' }) @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) batchNo?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) manufactureDate?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) expiryDate?: string | null;
  @ApiPropertyOptional({ description: 'Delivery unit (default: the PO line unit or base unit)' }) @IsOptional() @IsUUID() uomId?: string;
  @ApiProperty({ description: 'In the delivery unit' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional({ description: 'Per delivery unit (default: PO price)' }) @IsOptional() @IsNumber(QTY) @Min(0) unitPrice?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsUUID() binId?: string | null;
}

export class CreateGrnDto {
  @ApiPropertyOptional({ description: 'Omit for an emergency receipt' }) @IsOptional() @IsUUID() purchaseOrderId?: string;
  @ApiPropertyOptional({ description: 'Required for emergency receipts' }) @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({ description: 'Default: the PO delivery store' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) receivedDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) deliveryNoteNo?: string;
  @ApiPropertyOptional({ description: 'Required for emergency receipts' }) @IsOptional() @IsString() @MaxLength(1000) emergencyReason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional({ description: 'Cold-chain goods: temperature on arrival (°C)' }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(-90) @Max(80) receiptTemperatureC?: number;
  @ApiPropertyOptional({ description: 'Inbound shipment being received' }) @IsOptional() @IsUUID() shipmentId?: string;
  @ApiProperty({ type: [GrnLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => GrnLineDto)
  lines: GrnLineDto[];
}

export class InspectLineDto {
  @ApiProperty() @IsUUID() lineId: string;
  @ApiProperty({ description: 'Base units' }) @IsNumber(QTY) @Min(0) acceptedQty: number;
  @ApiProperty({ description: 'Base units' }) @IsNumber(QTY) @Min(0) rejectedQty: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) rejectionReason?: string;
}

export class InspectGrnDto {
  @ApiPropertyOptional({ type: [InspectLineDto], description: 'Results (first inspector); later inspectors may confirm without lines' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => InspectLineDto)
  lines?: InspectLineDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class PostGrnDto {
  @ApiPropertyOptional({ type: WitnessDto }) @IsOptional() @ValidateNested() @Type(() => WitnessDto) witness?: WitnessDto;
}

export class RegulariseGrnDto {
  @ApiProperty() @IsUUID() purchaseOrderId: string;
}

// ------------------------------------------------------------------ invoices

export class InvoiceLineDto {
  @ApiProperty() @IsUUID() poLineId: string;
  @ApiProperty({ description: 'In the PO line ordering unit' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiProperty({ description: 'Per ordering unit excl. VAT' }) @IsNumber(QTY) @Min(0) unitPrice: number;
  @ApiPropertyOptional({ description: 'Default: PO line tax rate × amount' }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) taxAmount?: number;
}

export class CreateInvoiceDto {
  @ApiProperty() @IsUUID() purchaseOrderId: string;
  @ApiProperty() @IsString() @MaxLength(60) supplierInvoiceNo: string;
  @ApiProperty() @IsDateString({ strict: true }) invoiceDate: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToNull) @IsDateString({ strict: true }) dueDate?: string | null;
  @ApiPropertyOptional({ description: 'KRA eTIMS invoice number (verified in a later release)' }) @IsOptional() @IsString() @MaxLength(60) etimsInvoiceNo?: string;
  @ApiProperty({ type: [InvoiceLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InvoiceLineDto)
  lines: InvoiceLineDto[];
}

export class PayInvoiceDto {
  @ApiProperty() @IsDateString({ strict: true }) paidOn: string;
  @ApiProperty() @IsString() @MaxLength(100) paymentReference: string;
  @ApiProperty({ example: 'EFT' }) @IsString() @MaxLength(40) method: string;
}

// ------------------------------------------------------------------ returns to supplier

export class SupplierReturnLineDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiPropertyOptional({ description: 'Bin the stock is taken from (quarantine bins allowed)' })
  @IsOptional() @Transform(emptyToNull) @IsUUID() binId?: string | null;
  @ApiProperty({ description: 'Base units' }) @IsNumber(QTY) @Min(0.0001) quantity: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class CreateSupplierReturnDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty() @IsString() @MaxLength(40) reasonCode: string;
  @ApiPropertyOptional({ description: 'GRN the goods came on (found automatically when omitted)' }) @IsOptional() @IsUUID() grnId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [SupplierReturnLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SupplierReturnLineDto)
  lines: SupplierReturnLineDto[];
}

export class DispatchSupplierReturnDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) returnDate?: string;
  @ApiPropertyOptional({ type: WitnessDto }) @IsOptional() @ValidateNested() @Type(() => WitnessDto) witness?: WitnessDto;
}

export class CreditNoteDto {
  @ApiProperty() @IsString() @MaxLength(60) creditNoteNo: string;
  @ApiProperty() @IsDateString({ strict: true }) creditNoteDate: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount: number;
}
