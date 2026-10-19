import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { AlertsService } from './alerts.service';
import { AmcService } from './amc.service';
import { ExpiryService } from './expiry.service';
import { PlanningController } from './planning.controllers';
import { StockAlert, StoreItemSetting } from './planning.entities';
import { PlanningJobs } from './planning.jobs';
import { PlanningService } from './planning.service';
import { ReorderService } from './reorder.service';

/** Stock planning: store item settings, AMC, reorder and expiry engines, alerts, dashboard. */
@Module({
  imports: [TypeOrmModule.forFeature([StoreItemSetting, StockAlert]), InventoryModule, PurchasingModule],
  controllers: [PlanningController],
  providers: [PlanningService, AmcService, ReorderService, ExpiryService, AlertsService, PlanningJobs],
  exports: [AmcService, ReorderService, ExpiryService, AlertsService],
})
export class PlanningModule {}
