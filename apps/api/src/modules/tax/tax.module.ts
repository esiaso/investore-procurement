import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaxController } from './tax.controller';
import { TaxCategory, TaxRate } from './tax.entities';
import { TaxService } from './tax.service';

@Module({
  imports: [TypeOrmModule.forFeature([TaxCategory, TaxRate])],
  controllers: [TaxController],
  providers: [TaxService],
  exports: [TaxService],
})
export class TaxModule {}
