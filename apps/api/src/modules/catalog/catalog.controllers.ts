import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Permissions } from '@sil/shared';
import { RequirePermissions } from '../../common/decorators';
import { loadEnv } from '../../config/env';
import {
  ConvertQueryDto,
  CreateGenericDto,
  CreateItemCategoryDto,
  CreateItemDto,
  CreateUnitConversionDto,
  CreateUomDto,
  GenericQueryDto,
  ItemQueryDto,
  UpdateGenericDto,
  UpdateItemCategoryDto,
  UpdateItemDto,
  UpdateUomDto,
} from './catalog.dto';
import { CategoriesService } from './categories.service';
import { GenericsService } from './generics.service';
import { ItemImportService } from './item-import.service';
import { ItemsService } from './items.service';
import { UnitsService } from './units.service';

@ApiTags('catalog')
@Controller('generics')
export class GenericsController {
  constructor(private readonly generics: GenericsService) {}

  @Get() @RequirePermissions(Permissions.CATALOG_READ)
  list(@Query() query: GenericQueryDto) {
    return this.generics.list(query);
  }

  /** The generic with all its mapped brands. */
  @Get(':id') @RequirePermissions(Permissions.CATALOG_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.generics.get(id, true);
  }

  @Post() @RequirePermissions(Permissions.CATALOG_MANAGE)
  create(@Body() dto: CreateGenericDto) {
    return this.generics.create(dto);
  }

  @Patch(':id') @RequirePermissions(Permissions.CATALOG_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGenericDto) {
    return this.generics.update(id, dto);
  }

  @Delete(':id') @HttpCode(204) @RequirePermissions(Permissions.CATALOG_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.generics.remove(id);
  }
}

@ApiTags('catalog')
@Controller('items')
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly units: UnitsService,
  ) {}

  @Get() @RequirePermissions(Permissions.CATALOG_READ)
  list(@Query() query: ItemQueryDto) {
    return this.items.list(query);
  }

  @Get(':id') @RequirePermissions(Permissions.CATALOG_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.items.get(id);
  }

  /** Brands of the same generic that can substitute this item. */
  @Get(':id/equivalents') @RequirePermissions(Permissions.CATALOG_READ)
  equivalents(@Param('id', ParseUUIDPipe) id: string) {
    return this.items.equivalents(id);
  }

  @Get(':id/conversions') @RequirePermissions(Permissions.CATALOG_READ)
  conversions(@Param('id', ParseUUIDPipe) id: string) {
    return this.units.listConversions(id);
  }

  /** Converts a quantity between units for this item (default target: base unit). */
  @Get(':id/convert') @RequirePermissions(Permissions.CATALOG_READ)
  async convert(@Param('id', ParseUUIDPipe) id: string, @Query() q: ConvertQueryDto) {
    return { quantity: await this.units.convert(id, q.quantity, q.fromUomId, q.toUomId) };
  }

  @Post() @RequirePermissions(Permissions.CATALOG_MANAGE)
  create(@Body() dto: CreateItemDto) {
    return this.items.create(dto);
  }

  @Patch(':id') @RequirePermissions(Permissions.CATALOG_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateItemDto) {
    return this.items.update(id, dto);
  }

  @Delete(':id') @HttpCode(204) @RequirePermissions(Permissions.CATALOG_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.items.remove(id);
  }
}

@ApiTags('catalog')
@Controller('item-categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get() @RequirePermissions(Permissions.CATALOG_READ)
  list() {
    return this.categories.list();
  }

  @Get(':id') @RequirePermissions(Permissions.CATALOG_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.categories.get(id);
  }

  @Post() @RequirePermissions(Permissions.CATALOG_MANAGE)
  create(@Body() dto: CreateItemCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id') @RequirePermissions(Permissions.CATALOG_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateItemCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id') @HttpCode(204) @RequirePermissions(Permissions.CATALOG_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.categories.remove(id);
  }
}

@ApiTags('catalog')
@Controller()
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get('uoms') @RequirePermissions(Permissions.CATALOG_READ)
  list() {
    return this.units.listUoms();
  }

  @Post('uoms') @RequirePermissions(Permissions.CATALOG_MANAGE)
  create(@Body() dto: CreateUomDto) {
    return this.units.createUom(dto);
  }

  @Patch('uoms/:id') @RequirePermissions(Permissions.CATALOG_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUomDto) {
    return this.units.updateUom(id, dto);
  }

  @Get('unit-conversions') @RequirePermissions(Permissions.CATALOG_READ)
  conversions() {
    return this.units.listConversions();
  }

  @Post('unit-conversions') @RequirePermissions(Permissions.CATALOG_MANAGE)
  createConversion(@Body() dto: CreateUnitConversionDto) {
    return this.units.createConversion(dto);
  }

  @Delete('unit-conversions/:id') @HttpCode(204) @RequirePermissions(Permissions.CATALOG_MANAGE)
  deleteConversion(@Param('id', ParseUUIDPipe) id: string) {
    return this.units.deleteConversion(id);
  }
}

@ApiTags('catalog')
@Controller('catalog/import')
export class ImportController {
  constructor(private readonly importer: ItemImportService) {}

  @Get('items/template') @RequirePermissions(Permissions.CATALOG_IMPORT)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="item-import-template.csv"')
  template() {
    return this.importer.template();
  }

  /**
   * Validates (dryRun=true, the default) or imports a CSV/XLSX file of items.
   * Import is all-or-nothing: any error blocks it.
   */
  @Post('items') @HttpCode(200) @RequirePermissions(Permissions.CATALOG_IMPORT)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
  @ApiQuery({ name: 'skipDuplicates', required: false, type: Boolean })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: loadEnv().importMaxFileMb * 1024 * 1024 } }))
  async importItems(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('dryRun') dryRun?: string,
    @Query('skipDuplicates') skipDuplicates?: string,
  ) {
    if (!file) throw new BadRequestException('Attach a file in the "file" field');
    const rows = await this.importer.parseFile(file.buffer, file.originalname);
    return this.importer.run(rows, { dryRun: dryRun !== 'false', skipDuplicates: skipDuplicates === 'true' });
  }
}
