import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FundingSource } from '../inventory/funding';
import { PlanningModule } from '../planning/planning.module';
import { ForecastingController, FundingSourcesController, SupplyPlanningController } from './forecasting.controllers';
import { DemandForecast, ForecastAccuracy, ForecastAdjustment, Programme, ProgrammeCommodity, Quantification } from './forecasting.entities';
import { ForecastingService } from './forecasting.service';

/** Demand forecasting, accuracy, supply planning, quantification and donor stock. */
@Module({
  imports: [TypeOrmModule.forFeature([ForecastAdjustment, DemandForecast, ForecastAccuracy, Programme, ProgrammeCommodity, Quantification, FundingSource]), PlanningModule],
  controllers: [ForecastingController, SupplyPlanningController, FundingSourcesController],
  providers: [ForecastingService],
  exports: [ForecastingService],
})
export class ForecastingModule {}
