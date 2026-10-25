import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryModule } from '../inventory/inventory.module';
import { NumberingModule } from '../numbering/numbering.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { ColdChainService } from './cold-chain.service';
import { ComplaintsService } from './complaints.service';
import { DisposalsService } from './disposals.service';
import { QUALITY_ENTITIES } from './entities';
import { HoldsService } from './holds.service';
import { QualityHooks } from './quality.hooks';
import { ColdChainController, ComplaintsController, DisposalsController, HoldsController, RecallsController } from './quality.controllers';
import { RecallsService } from './recalls.service';

/** Quality and safety of stock: holds, cold chain, complaints, recalls and disposal. */
@Module({
  imports: [TypeOrmModule.forFeature(QUALITY_ENTITIES), NumberingModule, InventoryModule, PurchasingModule],
  controllers: [HoldsController, ColdChainController, ComplaintsController, RecallsController, DisposalsController],
  providers: [HoldsService, ColdChainService, ComplaintsService, RecallsService, DisposalsService, QualityHooks],
  exports: [HoldsService, ColdChainService, DisposalsService],
})
export class QualityModule {}
