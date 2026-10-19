import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '@sil/shared';
import { RequirePermissions } from '../../common/decorators';
import { CreateNumberingSchemeDto, UpdateNumberingSchemeDto } from './numbering.dto';
import { NumberingService } from './numbering.service';

@ApiTags('numbering')
@Controller('numbering-schemes')
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  @Get()
  @RequirePermissions(Permissions.NUMBERING_READ)
  list() {
    return this.numbering.list();
  }

  @Post()
  @RequirePermissions(Permissions.NUMBERING_MANAGE)
  create(@Body() dto: CreateNumberingSchemeDto) {
    return this.numbering.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(Permissions.NUMBERING_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateNumberingSchemeDto) {
    return this.numbering.update(id, dto);
  }
}
