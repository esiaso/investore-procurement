import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EtimsModule } from '../etims/etims.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NumberingModule } from '../numbering/numbering.module';
import { TaxModule } from '../tax/tax.module';
import { UsersModule } from '../users/users.module';
import { ApiClientsService } from './api-clients.service';
import { ApiClientsController, BillingController, IntegrationController, SalesReportsController } from './billing.controllers';
import { Payer, PaymentMode, PriceList, PriceListItem, SalesInvoice, SalesInvoiceLine, SalesPayment } from './billing.entities';
import { BillingService } from './billing.service';
import { SalesReportsService } from './sales-reports.service';

/** Price lists, payers, sales invoices / credit notes, receipts and the HMIS invoice API. */
@Module({
  imports: [
    TypeOrmModule.forFeature([PriceList, PriceListItem, Payer, PaymentMode, SalesInvoice, SalesInvoiceLine, SalesPayment]),
    EtimsModule,
    InventoryModule,
    NumberingModule,
    TaxModule,
    UsersModule,
  ],
  controllers: [BillingController, SalesReportsController, ApiClientsController, IntegrationController],
  providers: [BillingService, SalesReportsService, ApiClientsService],
  exports: [BillingService, SalesReportsService, ApiClientsService],
})
export class BillingModule {}
