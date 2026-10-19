import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ApprovalAction,
  ApprovalDelegation,
  ApprovalRequest,
  ApprovalStep,
  ApprovalWorkflow,
  DocumentLink,
  Notification,
  NotificationPreference,
} from './approvals.entities';
import { ApprovalsController, DocumentsController, NotificationsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { DocumentLinksService } from './document-links.service';
import { NotificationsService } from './notifications.service';

/** Core workflow services: approvals, notifications and document links. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApprovalWorkflow, ApprovalStep, ApprovalRequest, ApprovalAction, ApprovalDelegation, Notification, NotificationPreference, DocumentLink])],
  controllers: [ApprovalsController, NotificationsController, DocumentsController],
  providers: [ApprovalsService, NotificationsService, DocumentLinksService],
  exports: [ApprovalsService, NotificationsService, DocumentLinksService],
})
export class ApprovalsModule {}
