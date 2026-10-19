import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NumberingController } from './numbering.controller';
import { DocumentSequence, NumberingScheme } from './numbering.entities';
import { NumberingService } from './numbering.service';

@Module({
  imports: [TypeOrmModule.forFeature([NumberingScheme, DocumentSequence])],
  controllers: [NumberingController],
  providers: [NumberingService],
  exports: [NumberingService],
})
export class NumberingModule {}
