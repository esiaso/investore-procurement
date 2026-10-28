import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BinsController, DepartmentsController, FacilitiesController, HospitalController, StoresController } from './org.controllers';
import { HospitalService } from './hospital.service';
import { Bin, Department, Facility, Store } from './org.entities';
import { OrgService } from './org.service';

@Module({
  imports: [TypeOrmModule.forFeature([Facility, Store, Bin, Department])],
  controllers: [FacilitiesController, StoresController, BinsController, DepartmentsController, HospitalController],
  providers: [OrgService, HospitalService],
  exports: [OrgService],
})
export class OrgModule {}
