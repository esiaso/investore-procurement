import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingModule } from '../billing/billing.module';
import { EtimsModule } from '../etims/etims.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NumberingModule } from '../numbering/numbering.module';
import { UsersModule } from '../users/users.module';
import { MpesaService } from './mpesa.service';
import { PosAdminService } from './pos-admin.service';
import { PosReportsService } from './pos-reports.service';
import { MpesaCallbackController, PosController } from './pos.controllers';
import { Customer, CustomerLedger, MpesaConfig, MpesaTransaction, PosEvent, PosPromotion, PosSale, PosShift, PosTerminal } from './pos.entities';
import { PosService } from './pos.service';
import { ShiftsService } from './shifts.service';

/** Over-the-counter point of sale: tills, shifts, sales (online and offline), M-Pesa, customers, promotions, reports. */
@Module({
  imports: [
    TypeOrmModule.forFeature([PosTerminal, PosShift, PosSale, PosEvent, Customer, CustomerLedger, PosPromotion, MpesaConfig, MpesaTransaction]),
    BillingModule,
    EtimsModule,
    InventoryModule,
    NumberingModule,
    UsersModule,
  ],
  controllers: [PosController, MpesaCallbackController],
  providers: [PosService, ShiftsService, PosAdminService, PosReportsService, MpesaService],
})
export class PosModule {}

