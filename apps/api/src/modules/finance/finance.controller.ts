import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '@sil/shared';
import { RequirePermissions } from '../../common/decorators';
import { CurrencyDto, ExchangeRateDto, GlAccountDto, GlAccountQueryDto, ProjectDto, RateQueryDto } from './finance.dto';
import { FinanceService } from './finance.service';

const P = Permissions;

@ApiTags('finance')
@Controller()
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  /** Anyone signed in reads the chart of accounts (to code requisitions). */
  @Get('gl-accounts') @RequirePermissions()
  glAccounts(@Query() q: GlAccountQueryDto) {
    return this.finance.glAccounts(q);
  }

  @Post('gl-accounts') @RequirePermissions(P.GL_MANAGE)
  createGlAccount(@Body() dto: GlAccountDto) {
    return this.finance.saveGlAccount(null, dto);
  }

  @Put('gl-accounts/:id') @RequirePermissions(P.GL_MANAGE)
  updateGlAccount(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GlAccountDto) {
    return this.finance.saveGlAccount(id, dto);
  }

  /** Adds / refreshes accounts from the connected QuickBooks company. */
  @Post('gl-accounts/import-quickbooks') @HttpCode(200) @RequirePermissions(P.GL_MANAGE)
  importGl() {
    return this.finance.importFromQuickBooks();
  }

  @Get('projects') @RequirePermissions()
  projects(@Query('active') active?: string) {
    return this.finance.projects(active === 'true');
  }

  @Post('projects') @RequirePermissions(P.PROJECTS_MANAGE)
  createProject(@Body() dto: ProjectDto) {
    return this.finance.saveProject(null, dto);
  }

  @Put('projects/:id') @RequirePermissions(P.PROJECTS_MANAGE)
  updateProject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProjectDto) {
    return this.finance.saveProject(id, dto);
  }

  @Get('currencies') @RequirePermissions()
  currencies() {
    return this.finance.currencies();
  }

  @Put('currencies') @RequirePermissions(P.FX_MANAGE)
  saveCurrency(@Body() dto: CurrencyDto) {
    return this.finance.saveCurrency(dto);
  }

  @Get('exchange-rates') @RequirePermissions()
  rates(@Query() q: RateQueryDto) {
    return this.finance.rates(q.currency);
  }

  @Put('exchange-rates') @RequirePermissions(P.FX_MANAGE)
  saveRate(@Body() dto: ExchangeRateDto) {
    return this.finance.saveRate(dto);
  }
}
