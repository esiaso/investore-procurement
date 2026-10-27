import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BudgetsModule } from '../budgets/budgets.module';
import { FinanceModule } from '../finance/finance.module';
import { NumberingModule } from '../numbering/numbering.module';
import { StoresModule } from '../stores/stores.module';
import { StaffRequisitionsController } from './staff-requisitions.controller';
import { StaffRequisition, StaffRequisitionLine } from './staff-requisitions.entities';
import { StaffRequisitionsService } from './staff-requisitions.service';

/** Staff / departmental requisitions for goods and services, and their consolidation into purchase requisitions. */
@Module({
  imports: [TypeOrmModule.forFeature([StaffRequisition, StaffRequisitionLine]), NumberingModule, BudgetsModule, FinanceModule, StoresModule],
  controllers: [StaffRequisitionsController],
  providers: [StaffRequisitionsService],
  exports: [StaffRequisitionsService],
})
export class StaffRequisitionsModule {}
