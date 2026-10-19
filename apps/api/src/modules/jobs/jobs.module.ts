import { Body, Controller, Get, Global, HttpCode, Module, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { JobRun } from './jobs.entities';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** Registered jobs, their schedules and last run. */
  @Get() @RequirePermissions(Permissions.JOBS_RUN)
  status() {
    return this.jobs.status();
  }

  @Get('runs') @RequirePermissions(Permissions.JOBS_RUN)
  runs(@Query('name') name?: string) {
    return this.jobs.runs(name);
  }

  /** Queues (or, in inline mode, runs) a job now. */
  @Post(':name/run') @HttpCode(200) @RequirePermissions(Permissions.JOBS_RUN)
  run(@Param('name') name: string, @Body() body: Record<string, unknown>, @CurrentUser() u: SessionUser) {
    return this.jobs.enqueue(name, body ?? {}, { trigger: 'manual', userId: u.id });
  }
}

/** Background jobs (BullMQ). Global so any module can register handlers. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([JobRun])],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
