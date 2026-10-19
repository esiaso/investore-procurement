import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '@sil/shared';
import { Public, RequirePermissions } from '../../common/decorators';
import { UpdateSettingDto } from './settings.dto';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Locale and password policy; needed on the login screen. */
  @Public()
  @Get('public')
  publicSettings() {
    return this.settings.publicSettings();
  }

  @Get()
  @RequirePermissions(Permissions.SETTINGS_READ)
  list() {
    return this.settings.list();
  }

  @Put(':key')
  @RequirePermissions(Permissions.SETTINGS_MANAGE)
  update(@Param('key') key: string, @Body() dto: UpdateSettingDto) {
    return this.settings.update(key, dto.value);
  }
}
