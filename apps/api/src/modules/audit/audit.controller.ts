import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '@sil/shared';
import { RequirePermissions } from '../../common/decorators';
import { AuditQueryDto } from './audit.dto';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(Permissions.AUDIT_READ)
  list(@Query() query: AuditQueryDto) {
    return this.audit.list(query);
  }
}
