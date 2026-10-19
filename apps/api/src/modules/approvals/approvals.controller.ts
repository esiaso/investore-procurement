import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApprovalActionType, Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ApprovalDecisionDto, ChainQueryDto, CreateDelegationDto, MarkReadDto, PreferencesDto, SaveWorkflowDto } from './approvals.dto';
import { ApprovalsService } from './approvals.service';
import { DocumentLinksService } from './document-links.service';
import { NotificationsService } from './notifications.service';

@ApiTags('approvals')
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /** Documents waiting for the current user (including as a delegate). */
  @Get('inbox')
  inbox(@CurrentUser() user: SessionUser) {
    return this.approvals.inbox(user);
  }

  @Get('history')
  history(@Query() q: ChainQueryDto) {
    return this.approvals.history(q.type, q.id);
  }

  @Post(':id/approve') @HttpCode(200)
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApprovalDecisionDto, @CurrentUser() user: SessionUser) {
    return this.approvals.act(id, user, ApprovalActionType.APPROVE, dto.comment);
  }

  @Post(':id/reject') @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApprovalDecisionDto, @CurrentUser() user: SessionUser) {
    return this.approvals.act(id, user, ApprovalActionType.REJECT, dto.comment);
  }

  @Post(':id/return') @HttpCode(200)
  returnForAmendment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApprovalDecisionDto, @CurrentUser() user: SessionUser) {
    return this.approvals.act(id, user, ApprovalActionType.RETURN, dto.comment);
  }

  @Get('workflows') @RequirePermissions(Permissions.APPROVALS_MANAGE)
  workflows() {
    return this.approvals.listWorkflows();
  }

  @Post('workflows') @RequirePermissions(Permissions.APPROVALS_MANAGE)
  createWorkflow(@Body() dto: SaveWorkflowDto) {
    return this.approvals.saveWorkflow(null, dto);
  }

  @Put('workflows/:id') @RequirePermissions(Permissions.APPROVALS_MANAGE)
  updateWorkflow(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveWorkflowDto) {
    return this.approvals.saveWorkflow(id, dto);
  }

  @Get('delegations')
  delegations(@CurrentUser() user: SessionUser) {
    return this.approvals.listDelegations(user, user.permissions.includes(Permissions.APPROVALS_MANAGE));
  }

  @Post('delegations')
  delegate(@Body() dto: CreateDelegationDto, @CurrentUser() user: SessionUser) {
    return this.approvals.createDelegation(user, dto, user.permissions.includes(Permissions.APPROVALS_MANAGE));
  }

  @Post('delegations/:id/end') @HttpCode(200)
  endDelegation(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.approvals.endDelegation(user, id, user.permissions.includes(Permissions.APPROVALS_MANAGE));
  }
}

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: SessionUser, @Query('unread') unread?: string) {
    return this.notifications.list(user.id, unread === 'true');
  }

  @Post('read') @HttpCode(204)
  markRead(@CurrentUser() user: SessionUser, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(user.id, dto.ids);
  }

  /** Channels (in-app, email, SMS) per notification category for the current user. */
  @Get('preferences')
  preferences(@CurrentUser() user: SessionUser) {
    return this.notifications.preferences(user.id);
  }

  @Put('preferences')
  setPreferences(@CurrentUser() user: SessionUser, @Body() dto: PreferencesDto) {
    return this.notifications.setPreferences(user.id, dto.preferences);
  }
}

@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly links: DocumentLinksService) {}

  /** The document chain (PR → RFQ → PO → GRN → invoice → payment) around any document. */
  @Get('chain') @RequirePermissions(Permissions.PURCHASING_READ)
  chain(@Query() q: ChainQueryDto) {
    return this.links.chain(q.type, q.id);
  }
}
