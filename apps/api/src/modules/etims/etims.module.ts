import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EtimsController } from './etims.controllers';
import {
  ApiClient,
  EtimsCode,
  EtimsCodeMapping,
  EtimsConfig,
  EtimsImportItem,
  EtimsItem,
  EtimsItemClass,
  EtimsOutbox,
  EtimsPurchase,
  EtimsTransmission,
} from './etims.entities';
import { EtimsService } from './etims.service';

/** KRA eTIMS: control units, code tables, outbox, stock reporting, purchases, imports. */
@Module({
  imports: [TypeOrmModule.forFeature([EtimsConfig, EtimsCode, EtimsItemClass, EtimsCodeMapping, EtimsItem, EtimsOutbox, EtimsTransmission, EtimsPurchase, EtimsImportItem, ApiClient])],
  controllers: [EtimsController],
  providers: [EtimsService],
  exports: [EtimsService],
})
export class EtimsModule {}
