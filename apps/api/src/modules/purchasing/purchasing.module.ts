import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BudgetsModule } from '../budgets/budgets.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NumberingModule } from '../numbering/numbering.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { TaxModule } from '../tax/tax.module';
import { GrnsService } from './grns.service';
import { InvoicesService } from './invoices.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  GrnsController,
  InvoicesController,
  PurchaseOrdersController,
  RequisitionsController,
  RfqsController,
} from './purchasing.controllers';
import {
  GoodsReceivedNote,
  GrnLine,
  PaymentVoucher,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderVersion,
  PurchaseRequisition,
  PurchaseRequisitionLine,
  Quotation,
  QuotationLine,
  ReturnToSupplier,
  Rfq,
  RfqLine,
  SupplierInvoice,
  SupplierInvoiceLine,
} from './purchasing.entities';
import { RequisitionsService } from './requisitions.service';
import { RfqsService } from './rfqs.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PurchaseRequisition,
      PurchaseRequisitionLine,
      Rfq,
      RfqLine,
      Quotation,
      QuotationLine,
      PurchaseOrder,
      PurchaseOrderLine,
      PurchaseOrderVersion,
      GoodsReceivedNote,
      GrnLine,
      ReturnToSupplier,
      SupplierInvoice,
      SupplierInvoiceLine,
      PaymentVoucher,
    ]),
    NumberingModule,
    TaxModule,
    CatalogModule,
    SuppliersModule,
    BudgetsModule,
    InventoryModule,
  ],
  controllers: [RequisitionsController, RfqsController, PurchaseOrdersController, GrnsController, InvoicesController],
  providers: [RequisitionsService, RfqsService, PurchaseOrdersService, GrnsService, InvoicesService],
  exports: [RequisitionsService, PurchaseOrdersService, GrnsService, InvoicesService, RfqsService],
})
export class PurchasingModule {}
