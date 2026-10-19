import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '@sil/shared';
import { RequirePermissions, StoreScoped } from '../../common/decorators';
import { PageQueryDto } from '../../common/pagination';
import {
  BinQueryDto,
  CreateBinDto,
  CreateDepartmentDto,
  CreateFacilityDto,
  CreateStoreDto,
  StoreQueryDto,
  UpdateBinDto,
  UpdateDepartmentDto,
  UpdateFacilityDto,
  UpdateStoreDto,
} from './org.dto';
import { OrgService } from './org.service';

@ApiTags('org')
@Controller('facilities')
export class FacilitiesController {
  constructor(private readonly org: OrgService) {}

  @Get() @RequirePermissions(Permissions.ORG_READ)
  list() {
    return this.org.listFacilities();
  }

  @Get(':id') @RequirePermissions(Permissions.ORG_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.getFacility(id);
  }

  @Post() @RequirePermissions(Permissions.ORG_MANAGE)
  create(@Body() dto: CreateFacilityDto) {
    return this.org.createFacility(dto);
  }

  @Patch(':id') @RequirePermissions(Permissions.ORG_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFacilityDto) {
    return this.org.updateFacility(id, dto);
  }
}

@ApiTags('org')
@Controller('stores')
export class StoresController {
  constructor(private readonly org: OrgService) {}

  @Get() @RequirePermissions(Permissions.ORG_READ)
  list(@Query() query: StoreQueryDto) {
    return this.org.listStores(query);
  }

  @Get(':id') @RequirePermissions(Permissions.ORG_READ) @StoreScoped('params.id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.getStore(id);
  }

  @Post() @RequirePermissions(Permissions.ORG_MANAGE) @StoreScoped('body.parentStoreId')
  create(@Body() dto: CreateStoreDto) {
    return this.org.createStore(dto);
  }

  @Patch(':id') @RequirePermissions(Permissions.ORG_MANAGE) @StoreScoped('params.id', 'body.parentStoreId')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStoreDto) {
    return this.org.updateStore(id, dto);
  }
}

@ApiTags('org')
@Controller('bins')
export class BinsController {
  constructor(private readonly org: OrgService) {}

  @Get() @RequirePermissions(Permissions.ORG_READ) @StoreScoped('query.storeId')
  list(@Query() query: BinQueryDto) {
    return this.org.listBins(query);
  }

  @Get(':id') @RequirePermissions(Permissions.ORG_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.getBin(id);
  }

  @Post() @RequirePermissions(Permissions.BINS_MANAGE) @StoreScoped('body.storeId')
  create(@Body() dto: CreateBinDto) {
    return this.org.createBin(dto);
  }

  @Patch(':id') @RequirePermissions(Permissions.BINS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBinDto) {
    return this.org.updateBin(id, dto);
  }

  @Delete(':id') @HttpCode(204) @RequirePermissions(Permissions.BINS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.deleteBin(id);
  }
}

@ApiTags('org')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly org: OrgService) {}

  @Get() @RequirePermissions(Permissions.ORG_READ)
  list(@Query() query: PageQueryDto) {
    return this.org.listDepartments(query);
  }

  @Get(':id') @RequirePermissions(Permissions.ORG_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.getDepartment(id);
  }

  @Post() @RequirePermissions(Permissions.ORG_MANAGE)
  create(@Body() dto: CreateDepartmentDto) {
    return this.org.createDepartment(dto);
  }

  @Patch(':id') @RequirePermissions(Permissions.ORG_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDepartmentDto) {
    return this.org.updateDepartment(id, dto);
  }

  @Delete(':id') @HttpCode(204) @RequirePermissions(Permissions.ORG_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.deleteDepartment(id);
  }
}
