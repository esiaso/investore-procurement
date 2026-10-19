import { EntityManager } from 'typeorm';
import { BatchHoldStatus, StockTxnType, ValuationMethod } from '@sil/shared';
import { Batch } from '../../modules/inventory/inventory.entities';
import { MovementLine, postMovements } from '../../modules/inventory/posting';
import { dateInTimezone } from '../../modules/settings/settings.service';

/** Deterministic PRNG so the sample data is the same on every machine. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Expiry offsets (days from today): expired, ≤30, ≤60, ≤90, ≤180, and comfortable. */
const EXPIRY_OFFSETS = [-20, 25, 55, 85, 170, 420, 720];

interface ItemRow {
  id: string;
  code: string;
  unit_price: string;
  is_batch_tracked: boolean;
  is_controlled: boolean;
  is_cold_chain: boolean;
  generic_id: string | null;
  base_uom: string;
}

/**
 * Opening stock for the sample catalog: drugs in the main store and
 * pharmacies, controlled drugs in CD bins, cold-chain items in fridges,
 * supplies in the main store, theatre and emergency. Some batches expired or
 * near expiry, a few quarantined.
 */
export async function seedSampleStock(m: EntityManager, timezone: string, log: (msg: string) => void): Promise<void> {
  const today = dateInTimezone(new Date(), timezone);
  const rand = mulberry32(20261019);
  const stores = new Map<string, string>(
    (await m.query(`SELECT code, id FROM store`)).map((r: { code: string; id: string }) => [r.code, r.id]),
  );
  const bins = new Map<string, string>(
    (await m.query(`SELECT s.code || ':' || b.code AS k, b.id FROM bin b JOIN store s ON s.id = b.store_id`)).map(
      (r: { k: string; id: string }) => [r.k, r.id],
    ),
  );
  const items: ItemRow[] = await m.query(
    `SELECT i.id, i.code, i.unit_price, i.is_batch_tracked, i.is_controlled, i.is_cold_chain, i.generic_id, u.code AS base_uom
       FROM item i JOIN unit_of_measure u ON u.id = i.base_uom_id ORDER BY i.code`,
  );

  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const qtyFor = (uom: string) =>
    ['TAB', 'CAP', 'PCS', 'SACHET'].includes(uom) ? 100 * (5 + Math.floor(rand() * 45)) : 10 * (2 + Math.floor(rand() * 18));

  const lines: MovementLine[] = [];
  let batchCount = 0;
  let quarantined = 0;

  for (const item of items) {
    const isDrug = !!item.generic_id;
    let placements: [store: string, bin: string][];
    if (item.is_controlled) placements = [['MP', 'CD-SAFE'], ['IPD-PH', 'IPD-CD'], ['TH-PH', 'TH-CD']];
    else if (item.is_cold_chain) placements = [['MS', 'COLD-01'], ['MP', 'FRIDGE-01'], ['OPD-PH', 'OPD-FR']];
    else if (isDrug) placements = [['MS', pick(['A-01', 'A-02', 'A-03', 'B-01'])], ['MP', pick(['SH-01', 'SH-02', 'SH-03'])], pick<[string, string]>([['OPD-PH', 'OPD-01'], ['IPD-PH', 'IPD-01']])];
    else placements = [['MS', pick(['B-02', 'BULK-01'])], pick<[string, string]>([['TH-PH', 'TH-01'], ['ER-PH', 'ER-01']])];

    const cost = Math.round(Number(item.unit_price) * 0.7 * 10_000) / 10_000;
    const batchTotal = item.is_batch_tracked ? 1 + Math.floor(rand() * 3) : 1;
    const created: Batch[] = [];
    for (let i = 0; i < batchTotal; i++) {
      batchCount++;
      const offset = item.is_batch_tracked ? EXPIRY_OFFSETS[Math.floor(rand() * EXPIRY_OFFSETS.length)] : null;
      const quarantine = item.is_batch_tracked && batchCount % 37 === 0;
      if (quarantine) quarantined++;
      created.push(
        await m.save(
          m.create(Batch, {
            itemId: item.id,
            batchNo: item.is_batch_tracked ? `${item.code.slice(-4)}-${String(batchCount).padStart(5, '0')}` : 'NOBATCH',
            manufactureDate: offset === null ? null : addDays(today, offset - 730),
            expiryDate: offset === null ? null : addDays(today, offset),
            unitCost: cost,
            holdStatus: quarantine ? BatchHoldStatus.QUARANTINE : BatchHoldStatus.NONE,
            holdReason: quarantine ? 'Sample: awaiting quality release' : null,
            receivedAt: new Date(Date.now() - (60 + Math.floor(rand() * 300)) * 86_400_000),
          }),
        ),
      );
    }

    placements.forEach(([storeCode, binCode], p) => {
      // The main store holds every batch; outlets hold one.
      const forStore = p === 0 ? created : [created[Math.floor(rand() * created.length)]];
      for (const batch of forStore) {
        lines.push({
          txnType: StockTxnType.OPENING,
          storeId: stores.get(storeCode)!,
          binId: bins.get(`${storeCode}:${binCode}`) ?? null,
          itemId: item.id,
          batchId: batch.id,
          quantity: p === 0 ? qtyFor(item.base_uom) : Math.max(1, Math.round(qtyFor(item.base_uom) / 4)),
          unitCost: cost,
        });
      }
    });
  }

  // One posting per store keeps each transaction small.
  for (const storeId of new Set(lines.map((l) => l.storeId))) {
    await postMovements(
      m,
      lines.filter((l) => l.storeId === storeId),
      {
        sourceDocType: 'OPENING',
        sourceDocNo: 'SAMPLE-OPENING',
        effectiveDate: today,
        userId: null,
        permissions: null,
        valuationMethod: ValuationMethod.WAC,
      },
    );
  }
  log(`sample stock: ${batchCount} batches (${quarantined} quarantined), ${lines.length} opening balance lines`);
}
