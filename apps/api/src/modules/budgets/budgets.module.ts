import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BudgetsController } from './budgets.controller';
import { Budget, BudgetEntry } from './budgets.entities';
import { BudgetsService } from './budgets.service';

@Module({
  imports: [TypeOrmModule.forFeature([Budget, BudgetEntry])],
  controllers: [BudgetsController],
  providers: [BudgetsService],
  exports: [BudgetsService],
})
export class BudgetsModule {}
