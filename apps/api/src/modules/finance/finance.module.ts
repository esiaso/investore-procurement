import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountingModule } from '../accounting/accounting.module';
import { FinanceController } from './finance.controller';
import { Currency, ExchangeRate, GlAccount, Project } from './finance.entities';
import { FinanceService } from './finance.service';

/** Chart of accounts, projects, currencies and exchange rates (non-stock procurement, payments, petty cash). */
@Module({
  imports: [TypeOrmModule.forFeature([GlAccount, Project, Currency, ExchangeRate]), AccountingModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
