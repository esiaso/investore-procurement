import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BinsController, DepartmentsController, FacilitiesController, StoresController } from './org.controllers';
import { Bin, Department, Facility, Store } from './org.entities';
import { OrgService } from './org.service';

@Module({
  imports: [TypeOrmModule.forFeature([Facility, Store, Bin, Department])],
  controllers: [FacilitiesController, StoresController, BinsController, DepartmentsController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
