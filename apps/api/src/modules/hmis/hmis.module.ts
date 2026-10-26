import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingModule } from '../billing/billing.module';
import { EtimsModule } from '../etims/etims.module';
import { Encounter, HmisCodeMapping, HmisConnection, HmisMessage, PatientCharge } from './hmis.entities';
import { HmisService } from './hmis.service';
import { PatientChargesService } from './patient-charges.service';

/**
 * HMIS link core: connection and adapters, code mappings, cached encounters,
 * the message log / outbox and patient charges. Used by the pharmacy
 * (dispensing) and stores (consumables issued to a patient); inbound orders
 * and the screens are in HmisIntegrationModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([HmisConnection, HmisCodeMapping, Encounter, HmisMessage, PatientCharge]), BillingModule, EtimsModule],
  providers: [HmisService, PatientChargesService],
  exports: [HmisService, PatientChargesService],
})
export class HmisModule {}
