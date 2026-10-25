import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { parse } from 'csv-parse/sync';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { ExcursionStatus, HoldReason, ReadingSource, SessionUser, StorageUnitType } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { SettingsService } from '../settings/settings.service';
import { HoldsService } from './holds.service';
import { StorageUnit, TemperatureExcursion, TemperatureReading } from './quality.entities';

export interface Reading {
  at: Date;
  t: number;
}

/**
 * Excursion rule: the run of out-of-range readings that ends with the latest
 * reading lasts at least `minutes` (0 = a single reading is enough). Returns
 * the start of that run, or null.
 */
export function excursionStart(readings: Reading[], range: { min: number; max: number }, minutes: number): Date | null {
  const sorted = [...readings].sort((a, b) => a.at.getTime() - b.at.getTime());
  let start: Date | null = null;
  for (const r of sorted) {
    const out = r.t < range.min || r.t > range.max;
    if (out && !start) start = r.at;
    if (!out) start = null;
  }
  if (!start) return null;
  const last = sorted[sorted.length - 1].at;
  return (last.getTime() - start.getTime()) / 60_000 >= minutes ? start : null;
}

/** Logger CSV: a timestamp column and a temperature column (names are matched loosely), optional unit / logger column. */
export function parseLoggerCsv(text: string): { at: Date; t: number; unit: string | null }[] {
  const rows: Record<string, string>[] = parse(text, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  const tsKey = keys.find((k) => /time|date/.test(k));
  const tKey = keys.find((k) => /temp|°c|celsius|value/.test(k));
  const unitKey = keys.find((k) => /unit|logger|serial|device/.test(k));
  if (!tsKey || !tKey) throw new BadRequestException('The CSV needs a timestamp column and a temperature column');
  return rows.map((r, i) => {
    const at = new Date(r[tsKey].includes('T') || /[+Z]/.test(r[tsKey]) ? r[tsKey] : `${r[tsKey].replace(' ', 'T')}+03:00`);
    const t = Number(String(r[tKey]).replace(',', '.'));
    if (Number.isNaN(at.getTime()) || !Number.isFinite(t)) throw new BadRequestException(`Row ${i + 2}: unreadable timestamp or temperature`);
    return { at, t, unit: unitKey ? r[unitKey] || null : null };
  });
}

@Injectable()
export class ColdChainService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly holds: HoldsService,
  ) {}

  async range(type: StorageUnitType | string, m: EntityManager = this.ds.manager) {
    const ranges = await this.settings.get('coldChain.ranges', m);
    const r = ranges[type];
    if (!r) throw new BadRequestException(`No temperature range is configured for ${type} (setting coldChain.ranges)`);
    return r;
  }

  units(storeId?: string) {
    const qb = this.ds.getRepository(StorageUnit).createQueryBuilder('u').leftJoinAndSelect('u.store', 'store').orderBy('u.code');
    StoreScope.apply(qb, 'u.store_id');
    if (storeId) qb.andWhere('u.store_id = :s', { s: storeId });
    return qb.getMany();
  }

  async saveUnit(id: string | null, dto: Partial<StorageUnit>) {
    if (dto.storeId) StoreScope.assert(dto.storeId);
    await this.range(dto.type ?? StorageUnitType.FRIDGE);
    const repo = this.ds.getRepository(StorageUnit);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw new NotFoundException('Storage unit not found');
    if (dto.binIds?.length) {
      const bins: { id: string; store_id: string }[] = await this.ds.query(`SELECT id, store_id FROM bin WHERE id = ANY($1::uuid[])`, [dto.binIds]);
      if (bins.length !== new Set(dto.binIds).size || bins.some((b) => b.store_id !== (dto.storeId ?? row.storeId))) throw new BadRequestException('Bins must belong to the unit’s store');
    }
    return repo.save(Object.assign(row, dto));
  }

  private async unit(m: EntityManager, id: string) {
    const u = await m.findOneBy(StorageUnit, { id });
    if (!u) throw new NotFoundException('Storage unit not found');
    StoreScope.assert(u.storeId);
    return u;
  }

  /** Records readings for one unit (manual or imported) and evaluates excursions. */
  async record(unitId: string, readings: { at: Date; t: number; note?: string | null }[], source: ReadingSource, actor: SessionUser | null) {
    return this.ds.transaction(async (m) => {
      const unit = await this.unit(m, unitId);
      const range = await this.range(unit.type, m);
      const sorted = [...readings].sort((a, b) => a.at.getTime() - b.at.getTime());
      const now = Date.now() + 5 * 60_000;
      if (sorted.some((r) => r.at.getTime() > now)) throw new BadRequestException('A reading is in the future');
      let excursions = 0;
      for (const r of sorted) {
        const row = await m.save(
          m.create(TemperatureReading, { unitId, recordedAt: r.at, temperatureC: r.t, source, inRange: r.t >= range.min && r.t <= range.max, recordedBy: actor?.id ?? null, note: r.note ?? null }),
        );
        if (await this.evaluate(m, unit, range, row, actor)) excursions++;
      }
      return { readings: sorted.length, outOfRange: sorted.filter((r) => r.t < range.min || r.t > range.max).length, newExcursions: excursions, range };
    });
  }

  async importCsv(unitId: string | null, csv: string, actor: SessionUser) {
    const rows = parseLoggerCsv(csv);
    if (!rows.length) throw new BadRequestException('The file has no readings');
    const byUnit = new Map<string, { at: Date; t: number }[]>();
    for (const r of rows) {
      let id = unitId;
      if (!id) {
        if (!r.unit) throw new BadRequestException('Choose the storage unit, or include a unit / logger column');
        const [u] = await this.ds.query(`SELECT id FROM storage_unit WHERE code = $1 OR logger_serial = $1`, [r.unit]);
        if (!u) throw new BadRequestException(`Unknown storage unit or logger ${r.unit}`);
        id = u.id as string;
      }
      byUnit.set(id, [...(byUnit.get(id) ?? []), { at: r.at, t: r.t }]);
    }
    const results = [];
    for (const [id, list] of byUnit) results.push({ unitId: id, ...(await this.record(id, list, ReadingSource.CSV, actor)) });
    return results;
  }

  /** Opens, extends or closes the unit's excursion for a new reading. True when an excursion was opened. */
  private async evaluate(m: EntityManager, unit: StorageUnit, range: { min: number; max: number }, reading: TemperatureReading, actor: SessionUser | null): Promise<boolean> {
    const open = await m.findOne(TemperatureExcursion, { where: { unitId: unit.id, endedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
    if (reading.inRange) {
      if (open && reading.recordedAt > open.startedAt) {
        open.endedAt = reading.recordedAt;
        await m.save(open);
      }
      return false;
    }
    if (open) {
      open.minTemperatureC = Math.min(open.minTemperatureC, reading.temperatureC);
      open.maxTemperatureC = Math.max(open.maxTemperatureC, reading.temperatureC);
      await m.save(open);
      await m.update(TemperatureReading, reading.id, { excursionId: open.id });
      return false;
    }
    const minutes = await this.settings.get('coldChain.excursionMinutes', m);
    // Readings since the last in-range one, plus this one.
    const recent: { recorded_at: Date; temperature_c: string; id: string }[] = await m.query(
      `SELECT id, recorded_at, temperature_c FROM temperature_reading
        WHERE unit_id = $1 AND recorded_at <= $2
          AND recorded_at > COALESCE((SELECT MAX(recorded_at) FROM temperature_reading WHERE unit_id = $1 AND in_range AND recorded_at <= $2), '-infinity')
        ORDER BY recorded_at`,
      [unit.id, reading.recordedAt],
    );
    const start = excursionStart(recent.map((r) => ({ at: new Date(r.recorded_at), t: Number(r.temperature_c) })), range, minutes);
    if (!start) return false;
    const temps = recent.map((r) => Number(r.temperature_c));
    const exc = await m.save(
      m.create(TemperatureExcursion, { unitId: unit.id, startedAt: start, endedAt: null, minTemperatureC: Math.min(...temps), maxTemperatureC: Math.max(...temps), rangeMin: range.min, rangeMax: range.max, status: ExcursionStatus.OPEN }),
    );
    await m.query(`UPDATE temperature_reading SET excursion_id = $2 WHERE id = ANY($1::uuid[])`, [recent.map((r) => r.id), exc.id]);
    if (await this.settings.get('coldChain.autoQuarantine', m)) {
      exc.holdIds = await this.quarantineUnit(m, unit, exc, actor?.id ?? null);
      await m.save(exc);
    }
    return true;
  }

  /** Holds every batch with stock in the unit (its bins, or the store's cold-chain stock when it has none). */
  private async quarantineUnit(m: EntityManager, unit: StorageUnit, exc: TemperatureExcursion, actorId: string | null): Promise<string[]> {
    const params: unknown[] = [unit.storeId];
    let where = 'sb.store_id = $1 AND sb.on_hand > 0';
    if (unit.binIds.length) {
      params.push(unit.binIds);
      where += ' AND sb.bin_id = ANY($2::uuid[])';
    } else if (unit.type !== StorageUnitType.AMBIENT) {
      where += ' AND i.is_cold_chain';
    }
    const batches: { batch_id: string }[] = await m.query(`SELECT DISTINCT sb.batch_id FROM stock_balance sb JOIN item i ON i.id = sb.item_id WHERE ${where}`, params);
    const ids: string[] = [];
    for (const b of batches) {
      const hold = await this.holds.place(
        m,
        {
          batchId: b.batch_id,
          storeId: unit.storeId,
          reason: HoldReason.EXCURSION,
          details: `Temperature excursion in ${unit.code} ${unit.name}: ${exc.minTemperatureC}–${exc.maxTemperatureC} °C (range ${exc.rangeMin}–${exc.rangeMax} °C) from ${exc.startedAt.toISOString()}`,
          sourceType: 'EXCURSION',
          sourceId: exc.id,
        },
        actorId,
      );
      ids.push(hold.id);
    }
    return ids;
  }

  readings(unitId: string, from?: string, to?: string) {
    const qb = this.ds.getRepository(TemperatureReading).createQueryBuilder('r').where('r.unit_id = :u', { u: unitId }).orderBy('r.recordedAt', 'DESC').take(2000);
    if (from) qb.andWhere('r.recorded_at >= :f', { f: from });
    if (to) qb.andWhere('r.recorded_at < (:t::date + 1)', { t: to });
    return qb.getMany();
  }

  async excursions(q: { status?: string; unitId?: string }) {
    const qb = this.ds.getRepository(TemperatureExcursion).createQueryBuilder('e').leftJoinAndSelect('e.unit', 'unit').leftJoinAndSelect('unit.store', 'store').orderBy('e.startedAt', 'DESC').take(500);
    StoreScope.apply(qb, 'unit.store_id');
    if (q.status) qb.andWhere('e.status = :s', { s: q.status });
    if (q.unitId) qb.andWhere('e.unit_id = :u', { u: q.unitId });
    return qb.getMany();
  }

  async excursion(id: string) {
    const e = await this.ds.getRepository(TemperatureExcursion).findOne({ where: { id }, relations: { unit: { store: true } } });
    if (!e) throw new NotFoundException('Excursion not found');
    StoreScope.assert(e.unit!.storeId);
    const holds = e.holdIds.length ? await this.ds.query(
      `SELECT h.id, h.number, h.status, h.quantity_at_hold::float AS "quantityAtHold", b.batch_no AS "batchNo", i.name AS item
         FROM quality_hold h JOIN batch b ON b.id = h.batch_id JOIN item i ON i.id = b.item_id WHERE h.id = ANY($1::uuid[]) ORDER BY i.name`,
      [e.holdIds],
    ) : [];
    const readings = await this.ds.getRepository(TemperatureReading).find({ where: { excursionId: id }, order: { recordedAt: 'ASC' } });
    return { ...e, holds, readings };
  }

  /** Quality officer's review; held batches are released or rejected on their holds. */
  async review(id: string, note: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const e = await m.findOne(TemperatureExcursion, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!e) throw new NotFoundException('Excursion not found');
      if (e.status !== ExcursionStatus.OPEN) throw new ConflictException('Already reviewed');
      Object.assign(e, { status: ExcursionStatus.REVIEWED, reviewedBy: actor.id, reviewNote: note });
      await m.save(e);
    });
    return this.excursion(id);
  }

  /**
   * Temperature measured on receipt (GRN): out of range for a fridge puts the
   * received cold-chain batches on hold. Returns the holds placed.
   */
  async checkReceipt(m: EntityManager, grn: { id: string; number: string; storeId: string; receiptTemperatureC: number | null }, batchIds: string[], actorId: string): Promise<number> {
    if (grn.receiptTemperatureC === null || !batchIds.length) return 0;
    const range = await this.range(StorageUnitType.FRIDGE, m);
    if (grn.receiptTemperatureC >= range.min && grn.receiptTemperatureC <= range.max) return 0;
    const cold: { id: string }[] = await m.query(`SELECT b.id FROM batch b JOIN item i ON i.id = b.item_id WHERE b.id = ANY($1::uuid[]) AND i.is_cold_chain`, [batchIds]);
    for (const b of cold) {
      await this.holds.place(
        m,
        { batchId: b.id, storeId: grn.storeId, reason: HoldReason.EXCURSION, details: `Received at ${grn.receiptTemperatureC} °C on ${grn.number} (range ${range.min}–${range.max} °C)`, sourceType: 'GRN', sourceId: grn.id },
        actorId,
      );
    }
    return cold.length;
  }
}
