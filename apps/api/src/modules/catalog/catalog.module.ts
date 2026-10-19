import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NumberingModule } from '../numbering/numbering.module';
import { TaxModule } from '../tax/tax.module';
import {
  CategoriesController,
  GenericsController,
  ImportController,
  ItemsController,
  UnitsController,
} from './catalog.controllers';
import { Generic, Item, ItemCategory, UnitConversion, UnitOfMeasure } from './catalog.entities';
import { CategoriesService } from './categories.service';
import { GenericsService } from './generics.service';
import { ItemImportService } from './item-import.service';
import { ItemsService } from './items.service';
import { UnitsService } from './units.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Generic, Item, ItemCategory, UnitOfMeasure, UnitConversion]),
    TaxModule,
    NumberingModule,
  ],
  controllers: [GenericsController, ItemsController, CategoriesController, UnitsController, ImportController],
  providers: [GenericsService, ItemsService, CategoriesService, UnitsService, ItemImportService],
  exports: [GenericsService, ItemsService, UnitsService],
})
export class CatalogModule {}
