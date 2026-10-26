import { Module } from '@nestjs/common';
import { PharmacyModule } from '../pharmacy/pharmacy.module';
import { HmisInboundService } from './hmis-inbound.service';
import { HmisController, HmisIntegrationController, PatientChargesController } from './hmis.controllers';
import { HmisModule } from './hmis.module';

/** HMIS screens and inbound flow (orders → prescriptions); depends on the pharmacy. */
@Module({
  imports: [HmisModule, PharmacyModule],
  controllers: [HmisController, PatientChargesController, HmisIntegrationController],
  providers: [HmisInboundService],
})
export class HmisIntegrationModule {}
