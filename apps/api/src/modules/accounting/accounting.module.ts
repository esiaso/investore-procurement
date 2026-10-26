import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NumberingModule } from '../numbering/numbering.module';
import { AccountingController, QuickBooksCallbackController } from './accounting.controllers';
import { AccountingBatch, AccountingConnection, AccountingPosting, AccountMapping, ExternalRef, PayerSettlement } from './accounting.entities';
import { AccountingService } from './accounting.service';

/** QuickBooks Online: connection, mappings, batch posting with preview, retries, reconciliation, payer settlements. */
@Module({
  imports: [TypeOrmModule.forFeature([AccountingConnection, AccountMapping, ExternalRef, AccountingPosting, AccountingBatch, PayerSettlement]), NumberingModule],
  controllers: [AccountingController, QuickBooksCallbackController],
  providers: [AccountingService],
  exports: [AccountingService],
})
export class AccountingModule {}
