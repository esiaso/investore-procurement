import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidateNested,
} from 'class-validator';
import { AttributeType, ControlledSchedule, isValidGtin, SalesClass, VedClass } from '@sil/shared';
import { PageQueryDto } from '../../common/pagination';

const CODE = /^[A-Za-z0-9._/-]{1,40}$/;

function IsValidGtin(): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'isValidGtin',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: { message: 'GTIN check digit is invalid' },
      validator: { validate: (v: unknown) => typeof v === 'string' && isValidGtin(v) },
    });
}
const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

// ------------------------------------------------------------------ generics

export class CreateGenericDto {
  @ApiProperty({ example: 'Amoxicillin' }) @IsString() @MaxLength(200) innName: string;
  @ApiPropertyOptional({ example: '500 mg' }) @IsOptional() @IsString() @MaxLength(100) strength?: string | null;
  @ApiPropertyOptional({ example: 'Capsule' }) @IsOptional() @IsString() @MaxLength(100) dosageForm?: string | null;
  @ApiPropertyOptional({ example: 'Oral' }) @IsOptional() @IsString() @MaxLength(60) route?: string | null;
  @ApiPropertyOptional({ example: 'J01CA04' })
  @IsOptional()
  @Transform(emptyToNull)
  @Matches(/^[A-Z]\d{2}([A-Z]([A-Z](\d{2})?)?)?$/, { message: 'Invalid ATC code' })
  atcCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) therapeuticClass?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isKeml?: boolean;
  @ApiPropertyOptional({ enum: ControlledSchedule }) @IsOptional() @IsEnum(ControlledSchedule) controlledSchedule?: ControlledSchedule;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) storageRequirements?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) pregnancyNotes?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) lactationNotes?: string | null;
  @ApiPropertyOptional({ description: 'Dispensing check: contraindicated in pregnancy' }) @IsOptional() @IsBoolean() pregnancyContraindicated?: boolean;
  @ApiPropertyOptional({ description: 'Dispensing check: youngest age in years', nullable: true }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(120) minAgeYears?: number | null;
  @ApiPropertyOptional({ description: 'OTC limit per sale (base units, all brands)', nullable: true }) @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) maxQtyPerSale?: number | null;
  @ApiPropertyOptional({ enum: VedClass, description: 'VED criticality (V / E / D)', nullable: true }) @IsOptional() @IsEnum(VedClass) vedClass?: VedClass | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateGenericDto extends PartialType(CreateGenericDto) {}

export class GenericQueryDto extends PageQueryDto {
  /** Include each generic's mapped brands (items). */
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() includeItems?: boolean;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() keml?: boolean;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() active?: boolean;
}

// ------------------------------------------------------------------ categories

export class AttributeDefinitionDto {
  @ApiProperty() @IsString() @Matches(/^[a-z][a-zA-Z0-9_]*$/) key: string;
  @ApiProperty() @IsString() @MaxLength(200) label: string;
  @ApiProperty({ enum: AttributeType }) @IsEnum(AttributeType) type: AttributeType;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() required?: boolean;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) options?: string[];
}

export class CreateItemCategoryDto {
  @ApiProperty() @IsString() @Matches(CODE) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(emptyToNull) @IsUUID() parentId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDrug?: boolean;
  @ApiPropertyOptional({ type: [AttributeDefinitionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttributeDefinitionDto)
  attributeSchema?: AttributeDefinitionDto[];
  @ApiPropertyOptional({ type: [Number], nullable: true, description: 'Near-expiry alert horizons (days); null = system default' })
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(1, { each: true })
  expiryAlertDays?: number[] | null;
}
export class UpdateItemCategoryDto extends PartialType(CreateItemCategoryDto) {}

// ------------------------------------------------------------------ units

export class CreateUomDto {
  @ApiProperty({ example: 'TAB' }) @IsString() @Matches(CODE) code: string;
  @ApiProperty({ example: 'Tablet' }) @IsString() @MaxLength(100) name: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateUomDto extends PartialType(CreateUomDto) {}

export class CreateUnitConversionDto {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() itemId?: string | null;
  @ApiProperty() @IsUUID() fromUomId: string;
  @ApiProperty() @IsUUID() toUomId: string;
  @ApiProperty({ example: 10 }) @IsNumber({ maxDecimalPlaces: 4 }) @IsPositive() factor: number;
}

export class ConvertQueryDto {
  @ApiProperty() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) quantity: number;
  @ApiProperty() @IsUUID() fromUomId: string;
  @ApiPropertyOptional({ description: 'Defaults to the item base unit' }) @IsOptional() @IsUUID() toUomId?: string;
}

// ------------------------------------------------------------------ items

export class CreateItemDto {
  @ApiPropertyOptional({ description: 'Auto-numbered when omitted' })
  @IsOptional()
  @Transform(emptyToNull)
  @Matches(CODE)
  code?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(emptyToNull) @IsUUID() genericId?: string | null;
  @ApiProperty() @IsUUID() categoryId: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) brandName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) manufacturer?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) ppbRegNo?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) packSize?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @Matches(/^(\d{8}|\d{12}|\d{13}|\d{14})$/, { message: 'GTIN must be 8, 12, 13 or 14 digits' })
  @IsValidGtin()
  gtin?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) barcode?: string | null;
  @ApiProperty() @IsUUID() baseUomId: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1e12) unitPrice: number;
  @ApiPropertyOptional({ enum: SalesClass, nullable: true }) @IsOptional() @Transform(emptyToNull) @IsEnum(SalesClass) salesClass?: SalesClass | null;
  @ApiProperty() @IsUUID() taxCategoryId: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFormulary?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isBatchTracked?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isColdChain?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isControlled?: boolean;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) reorderLevel?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsObject() attributes?: Record<string, string | number | boolean | null>;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateItemDto extends PartialType(CreateItemDto) {}

export class ItemQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() genericId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() formulary?: boolean;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() active?: boolean;
}
