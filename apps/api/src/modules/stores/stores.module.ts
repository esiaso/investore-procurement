import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryModule } from '../inventory/inventory.module';
import { NumberingModule } from '../numbering/numbering.module';
import { BackorderReplanService } from './backorder-replan.service';
import { ConsumptionService } from './consumption.service';
import { DepartmentReturnsService } from './department-returns.service';
import { IssuesService } from './issues.service';
import { ReservationsService } from './reservations.service';
import { ReturnReasonsService } from './return-reasons.service';
import { StoreRequisitionsService } from './store-requisitions.service';
import {
  ConsumptionController,
  DepartmentReturnsController,
  IssuesController,
  ReturnReasonsController,
  StoreRequisitionsController,
} from './stores.controllers';
import {
  DepartmentReturn,
  DepartmentReturnLine,
  IssueVoucher,
  IssueVoucherLine,
  StoreRequisition,
  StoreRequisitionLine,
} from './stores.entities';

/** Internal requisitions, reservations, issues, department returns and consumption. */
@Module({
  imports: [
    TypeOrmModule.forFeature([StoreRequisition, StoreRequisitionLine, IssueVoucher, IssueVoucherLine, DepartmentReturn, DepartmentReturnLine]),
    NumberingModule,
    InventoryModule,
  ],
  controllers: [StoreRequisitionsController, IssuesController, DepartmentReturnsController, ReturnReasonsController, ConsumptionController],
  providers: [ReservationsService, StoreRequisitionsService, IssuesService, DepartmentReturnsService, ConsumptionService, ReturnReasonsService, BackorderReplanService],
  exports: [StoreRequisitionsService, IssuesService, DepartmentReturnsService, ReservationsService],
})
export class StoresModule {}
