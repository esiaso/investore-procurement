import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogModule } from '../catalog/catalog.module';
import { NumberingModule } from '../numbering/numbering.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { UsersModule } from '../users/users.module';
import { AgenciesService } from './agencies.service';
import { ContractsService } from './contracts.service';
import { PROCUREMENT_ENTITIES } from './entities';
import { KpisService } from './kpis.service';
import { PerformanceService } from './performance.service';
import { PlansService } from './plans.service';
import { PortalService } from './portal.service';
import {
  AgenciesController,
  ContractsController,
  DeliveryController,
  KpisController,
  PerformanceController,
  PlansController,
  PortalController,
  SourcingController,
  TendersController,
} from './procurement.controllers';
import { ProcurementJobs } from './procurement.jobs';
import { TendersService } from './tenders.service';

/** Strategic procurement: annual plans, sourcing, tenders, contracts, supplier performance, agencies, portal, KPIs. */
@Module({
  imports: [TypeOrmModule.forFeature(PROCUREMENT_ENTITIES), NumberingModule, PurchasingModule, SuppliersModule, CatalogModule, UsersModule],
  controllers: [PlansController, SourcingController, TendersController, ContractsController, PerformanceController, AgenciesController, DeliveryController, KpisController, PortalController],
  providers: [PlansService, TendersService, ContractsService, PerformanceService, AgenciesService, PortalService, KpisService, ProcurementJobs],
  exports: [PlansService, ContractsService],
})
export class ProcurementModule {}
