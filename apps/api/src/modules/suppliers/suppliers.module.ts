import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NumberingModule } from '../numbering/numbering.module';
import { SuppliersController } from './suppliers.controller';
import { ContractPrice, Supplier, SupplierContact, SupplierDocument } from './suppliers.entities';
import { SuppliersService } from './suppliers.service';

@Module({
  imports: [TypeOrmModule.forFeature([Supplier, SupplierContact, SupplierDocument, ContractPrice]), NumberingModule],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
