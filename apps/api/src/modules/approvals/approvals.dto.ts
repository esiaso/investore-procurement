import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApproverType } from '@sil/shared';

export class ApprovalStepDto {
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ enum: ApproverType }) @IsEnum(ApproverType) approverType: ApproverType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
}

export class SaveWorkflowDto {
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9_-]{2,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ example: 'PO' }) @IsString() @MaxLength(20) documentType: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsNumber() @Min(0) minAmount?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsNumber() @Min(0) maxAmount?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() departmentId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() itemCategoryId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() priority?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiProperty({ type: [ApprovalStepDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ApprovalStepDto)
  steps: ApprovalStepDto[];
}

export class ApprovalDecisionDto {
  @ApiPropertyOptional({ description: 'Required to reject or return' }) @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

export class CreateDelegationDto {
  @ApiPropertyOptional({ description: 'Default: yourself (others need approvals.manage)' }) @IsOptional() @IsUUID() fromUserId?: string;
  @ApiProperty() @IsUUID() toUserId: string;
  @ApiProperty() @IsDateString({ strict: true }) startsOn: string;
  @ApiProperty() @IsDateString({ strict: true }) endsOn: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class MarkReadDto {
  @ApiPropertyOptional({ type: [String], description: 'Default: all' }) @IsOptional() @IsArray() @IsUUID('all', { each: true }) ids?: string[];
}

export class ChainQueryDto {
  @ApiProperty() @IsString() @MaxLength(20) type: string;
  @ApiProperty() @IsUUID() id: string;
}
