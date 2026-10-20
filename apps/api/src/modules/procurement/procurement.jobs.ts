import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { AgenciesService } from './agencies.service';
import { ContractsService } from './contracts.service';
import { PerformanceService } from './performance.service';
import { TendersService } from './tenders.service';

/** Background jobs of the procurement module (schedules in setting jobs.schedules). */
@Injectable()
export class ProcurementJobs implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
    private readonly tenders: TendersService,
    private readonly contracts: ContractsService,
    private readonly perf: PerformanceService,
    private readonly agencies: AgenciesService,
  ) {}

  onModuleInit() {
    this.jobs.register('tenders.close', 'Close tenders whose closing time has passed', () => this.tenders.closeDue());
    this.jobs.register('contracts.alerts', 'Contract and performance-security expiry alerts; expire ended contracts', () => this.contracts.alerts());
    this.jobs.register('suppliers.sanctions', 'Apply approved supplier sanctions and lift ended suspensions', () => this.perf.applyDue());
    this.jobs.register('suppliers.scorecards', 'Supplier scorecards for last month (or { period })', async (data) => {
      const period = (data as { period?: string } | undefined)?.period ?? (await this.lastMonth());
      return this.perf.compute(period);
    });
    this.jobs.register('agency.ordercycle', 'Raise draft POs from order templates that are due (KEMSA / MEDS order cycles)', () => this.agencies.runDue());
  }

  private async lastMonth() {
    const [y, m] = (await this.settings.today()).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
}
