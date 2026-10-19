import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import {
  ContractPriceDto,
  ContractPriceQueryDto,
  CreateSupplierDto,
  SupplierDocumentDto,
  SupplierQueryDto,
  SupplierStatusDto,
  UpdateSupplierDto,
} from './suppliers.dto';
import { SuppliersService } from './suppliers.service';

@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get() @RequirePermissions(Permissions.SUPPLIERS_READ)
  list(@Query() q: SupplierQueryDto) {
    return this.suppliers.list(q);
  }

  @Get('documents/expiring') @RequirePermissions(Permissions.SUPPLIERS_READ)
  expiring(@Query('days') days?: string) {
    return this.suppliers.expiringDocuments(Number(days ?? 60));
  }

  @Get('contract-prices') @RequirePermissions(Permissions.SUPPLIERS_READ)
  prices(@Query() q: ContractPriceQueryDto) {
    return this.suppliers.listPrices(q);
  }

  /** Bank account number is decrypted only for suppliers.bank holders. */
  @Get(':id') @RequirePermissions(Permissions.SUPPLIERS_READ)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.suppliers.get(id, user.permissions.includes(Permissions.SUPPLIERS_BANK));
  }

  @Post() @RequirePermissions(Permissions.SUPPLIERS_MANAGE)
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliers.create(dto);
  }

  @Patch(':id') @RequirePermissions(Permissions.SUPPLIERS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(id, dto);
  }

  @Post(':id/status') @HttpCode(200) @RequirePermissions(Permissions.SUPPLIERS_MANAGE)
  status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SupplierStatusDto) {
    return this.suppliers.setStatus(id, dto);
  }

  @Post(':id/documents') @RequirePermissions(Permissions.SUPPLIERS_MANAGE)
  addDocument(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SupplierDocumentDto) {
    return this.suppliers.addDocument(id, dto);
  }

  @Delete(':id/documents/:docId') @HttpCode(204) @RequirePermissions(Permissions.SUPPLIERS_MANAGE)
  removeDocument(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string) {
    return this.suppliers.removeDocument(id, docId);
  }

  @Post(':id/contract-prices') @RequirePermissions(Permissions.SUPPLIERS_MANAGE)
  addPrice(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ContractPriceDto) {
    return this.suppliers.addPrice(id, dto);
  }
}
