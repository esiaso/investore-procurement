import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NumberingModule } from '../numbering/numbering.module';
import { UsersModule } from '../users/users.module';
import { AdjustmentsService } from './adjustments.service';
import {
  AdjustmentReason,
  ReturnReason,
  StockAdjustment,
  StockAdjustmentLine,
  StockReceipt,
  StockReceiptLine,
  StockTake,
  StockTakeLine,
  StockTransfer,
  StockTransferAllocation,
  StockTransferLine,
} from './documents.entities';
import {
  AdjustmentsController,
  InventoryController,
  ReceiptsController,
  StockTakesController,
  TransfersController,
} from './inventory.controllers';
import { Batch, ItemStoreCost, StockBalance, StockReservation, StockTransaction, StorePeriodLock } from './inventory.entities';
import { InventoryService } from './inventory.service';
import { ReceiptsService } from './receipts.service';
import { StockTakesService } from './stocktakes.service';
import { TransfersService } from './transfers.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Batch,
      StockBalance,
      StockTransaction,
      ItemStoreCost,
      StorePeriodLock,
      StockReservation,
      AdjustmentReason,
      ReturnReason,
      StockReceipt,
      StockReceiptLine,
      StockAdjustment,
      StockAdjustmentLine,
      StockTransfer,
      StockTransferLine,
      StockTransferAllocation,
      StockTake,
      StockTakeLine,
    ]),
    NumberingModule,
    UsersModule,
  ],
  controllers: [InventoryController, ReceiptsController, AdjustmentsController, TransfersController, StockTakesController],
  providers: [InventoryService, ReceiptsService, AdjustmentsService, TransfersService, StockTakesService],
  exports: [InventoryService],
})
export class InventoryModule {}
