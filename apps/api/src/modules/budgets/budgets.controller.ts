import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags, PartialType, OmitType } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { BudgetEnforcement, Permissions } from '@sil/shared';
import { RequirePermissions } from '../../common/decorators';
import { BudgetsService } from './budgets.service';

class CreateBudgetDto {
  @ApiProperty() @IsUUID() departmentId: string;
  @ApiProperty({ example: 'PHARMA' }) @Matches(/^[A-Z0-9_-]{2,40}$/) voteHead: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) description?: string;
  @ApiPropertyOptional({ description: 'Default: current FY' }) @IsOptional() @IsString() @MaxLength(20) financialYear?: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount: number;
  @ApiPropertyOptional({ enum: BudgetEnforcement }) @IsOptional() @IsEnum(BudgetEnforcement) enforcement?: BudgetEnforcement;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class UpdateBudgetDto extends PartialType(OmitType(CreateBudgetDto, ['departmentId', 'voteHead', 'financialYear'] as const)) {}
class BudgetQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() financialYear?: string;
}

@ApiTags('budgets')
@Controller('budgets')
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  /** Budget positions: amount, committed, actual, available. */
  @Get() @RequirePermissions(Permissions.BUDGETS_READ)
  list(@Query() q: BudgetQueryDto) {
    return this.budgets.positions(q);
  }

  /** Budgets a requisition can be charged to (any purchasing user). */
  @Get('options') @RequirePermissions(Permissions.PURCHASING_READ)
  async options(@Query() q: BudgetQueryDto) {
    const fy = q.financialYear ?? (await this.budgets.currentFinancialYear());
    return (await this.budgets.positions({ departmentId: q.departmentId, financialYear: fy })).map((b) => ({
      id: b.id,
      departmentId: b.departmentId,
      voteHead: b.voteHead,
      financialYear: b.financialYear,
      label: `${b.voteHead} · ${b.departmentName} · FY ${b.financialYear}`,
    }));
  }

  @Get(':id/entries') @RequirePermissions(Permissions.BUDGETS_READ)
  entries(@Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.entries(id);
  }

  @Post() @RequirePermissions(Permissions.BUDGETS_MANAGE)
  create(@Body() dto: CreateBudgetDto) {
    return this.budgets.create(dto);
  }

  @Patch(':id') @RequirePermissions(Permissions.BUDGETS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBudgetDto) {
    return this.budgets.update(id, dto);
  }
}
