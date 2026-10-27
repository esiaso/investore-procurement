import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { DashboardService } from './dashboard.service';
import { DocumentsService } from './documents.service';
import { DashboardController, DocumentsController, ReportsController } from './reports.controllers';
import { ReportRun, ReportSchedule } from './reports.entities';
import { ReportsService } from './reports.service';

/** Reports (screen, CSV / Excel / PDF, scheduled email), the role dashboard and the documents register. */
@Module({
  imports: [TypeOrmModule.forFeature([ReportSchedule, ReportRun]), MailModule, UsersModule],
  controllers: [ReportsController, DashboardController, DocumentsController],
  providers: [ReportsService, DashboardService, DocumentsService],
  exports: [ReportsService],
})
export class ReportsModule {}
