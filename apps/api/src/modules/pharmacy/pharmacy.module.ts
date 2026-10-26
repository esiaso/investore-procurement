import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingModule } from '../billing/billing.module';
import { EtimsModule } from '../etims/etims.module';
import { HmisModule } from '../hmis/hmis.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NumberingModule } from '../numbering/numbering.module';
import { DrugInteractionsService } from './drug-interactions.service';
import { PatientsController, PharmacyController } from './pharmacy.controllers';
import { ClinicalAlert, Dispense, DispenseLine, DrugInteraction, InteractionOverride, Patient, Prescription, PrescriptionLine } from './pharmacy.entities';
import { PharmacyService } from './pharmacy.service';

/** Patients (cached), prescriptions, clinical checks, dispensing and returns. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Patient, Prescription, PrescriptionLine, Dispense, DispenseLine, DrugInteraction, ClinicalAlert, InteractionOverride]),
    BillingModule,
    EtimsModule,
    HmisModule,
    InventoryModule,
    NumberingModule,
  ],
  controllers: [PatientsController, PharmacyController],
  providers: [PharmacyService, DrugInteractionsService],
  exports: [PharmacyService],
})
export class PharmacyModule {}
