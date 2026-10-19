import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { Permissions } from '@sil/shared';
import { RequirePermissions } from '../../common/decorators';
import { CreateTaxCategoryDto, CreateTaxRateDto, UpdateTaxCategoryDto } from './tax.dto';
import { TaxService } from './tax.service';

class CloseRateDto {
  @IsDateString({ strict: true }) effectiveTo: string;
}

class RateQueryDto {
  @IsOptional() @IsDateString({ strict: true }) date?: string;
}

@ApiTags('tax')
@Controller('tax')
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @Get('categories')
  @RequirePermissions(Permissions.CATALOG_READ)
  list() {
    return this.tax.listCategories();
  }

  @Get('categories/:id')
  @RequirePermissions(Permissions.TAX_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tax.getCategory(id);
  }

  @Get('categories/:id/rate')
  @RequirePermissions(Permissions.TAX_READ)
  async rate(@Param('id', ParseUUIDPipe) id: string, @Query() q: RateQueryDto) {
    return { ratePercent: await this.tax.rateFor(id, q.date) };
  }

  @Post('categories')
  @RequirePermissions(Permissions.TAX_MANAGE)
  create(@Body() dto: CreateTaxCategoryDto) {
    return this.tax.createCategory(dto);
  }

  @Patch('categories/:id')
  @RequirePermissions(Permissions.TAX_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaxCategoryDto) {
    return this.tax.updateCategory(id, dto);
  }

  @Post('rates')
  @RequirePermissions(Permissions.TAX_MANAGE)
  addRate(@Body() dto: CreateTaxRateDto) {
    return this.tax.addRate(dto);
  }

  @Patch('rates/:id/close')
  @RequirePermissions(Permissions.TAX_MANAGE)
  closeRate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseRateDto) {
    return this.tax.closeRate(id, dto.effectiveTo);
  }
}
