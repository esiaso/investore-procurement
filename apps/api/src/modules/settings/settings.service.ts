import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { PublicSettings } from '@sil/shared';
import { SettingKey, SettingTypes } from './setting-keys';
import { SystemSetting } from './system-setting.entity';

@Injectable()
export class SettingsService {
  constructor(@InjectRepository(SystemSetting) private readonly repo: Repository<SystemSetting>) {}

  /** Pass the caller's manager inside a transaction so no second pool connection is needed. */
  async get<K extends SettingKey>(key: K, manager?: EntityManager): Promise<SettingTypes[K]> {
    const repo = manager ? manager.getRepository(SystemSetting) : this.repo;
    const row = await repo.findOneBy({ key });
    if (!row) throw new Error(`System setting "${key}" is not configured`);
    return row.value as SettingTypes[K];
  }

  list(): Promise<SystemSetting[]> {
    return this.repo.find({ order: { key: 'ASC' } });
  }

  async update(key: string, value: unknown): Promise<SystemSetting> {
    const row = await this.repo.findOneBy({ key });
    if (!row) throw new NotFoundException(`Unknown setting ${key}`);
    row.value = value;
    return this.repo.save(row);
  }

  async publicSettings(): Promise<PublicSettings> {
    const [currency, timezone, dateFormat, financialYearStartMonth, passwordPolicy, expiryWarningDays] = await Promise.all([
      this.get('locale.currency'),
      this.get('locale.timezone'),
      this.get('locale.dateFormat'),
      this.get('finance.fyStartMonth'),
      this.get('security.passwordPolicy'),
      this.get('inventory.expiryWarningDays'),
    ]);
    return { currency, timezone, dateFormat, financialYearStartMonth, passwordPolicy, expiryWarningDays };
  }

  /** Today's calendar date (YYYY-MM-DD) in the configured timezone. */
  async today(manager?: EntityManager): Promise<string> {
    return dateInTimezone(new Date(), await this.get('locale.timezone', manager));
  }
}

export function dateInTimezone(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
