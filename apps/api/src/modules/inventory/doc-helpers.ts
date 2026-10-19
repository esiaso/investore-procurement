import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ValuationMethod } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';

export interface ItemInfo {
  id: string;
  code: string;
  name: string;
  is_batch_tracked: boolean;
  is_controlled: boolean;
  is_cold_chain: boolean;
  is_active: boolean;
}

export async function loadItems(m: EntityManager, ids: string[]): Promise<Map<string, ItemInfo>> {
  const rows: ItemInfo[] = await m.query(
    `SELECT id, code, name, is_batch_tracked, is_controlled, is_cold_chain, is_active FROM item WHERE id = ANY($1::uuid[])`,
    [[...new Set(ids)]],
  );
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) if (!map.has(id)) throw new NotFoundException(`Item ${id} not found`);
  return map;
}

/** Store must exist, be active and be in the caller's scope. */
export async function assertStore(m: EntityManager, storeId: string): Promise<{ id: string; code: string; name: string }> {
  StoreScope.assert(storeId);
  const [store] = await m.query(`SELECT id, code, name, is_active FROM store WHERE id = $1`, [storeId]);
  if (!store) throw new NotFoundException('Store not found');
  if (!store.is_active) throw new BadRequestException(`Store ${store.code} is inactive`);
  return store;
}

export async function assertBin(m: EntityManager, storeId: string, binId: string | null | undefined): Promise<string | null> {
  if (!binId) return null;
  const [bin] = await m.query(`SELECT id, store_id, is_active FROM bin WHERE id = $1`, [binId]);
  if (!bin || bin.store_id !== storeId) throw new BadRequestException('Bin does not belong to the store');
  if (!bin.is_active) throw new BadRequestException('Bin is inactive');
  return bin.id;
}

/** Current cost per base unit of an item batch in a store, per valuation method. */
export async function currentCost(
  m: EntityManager,
  storeId: string,
  itemId: string,
  batchId: string,
  method: ValuationMethod,
): Promise<number> {
  const [r] = await m.query(
    `SELECT b.unit_cost, c.avg_cost FROM batch b
       LEFT JOIN item_store_cost c ON c.store_id = $1 AND c.item_id = $2
      WHERE b.id = $3`,
    [storeId, itemId, batchId],
  );
  if (!r) throw new NotFoundException('Batch not found');
  return Number(method === ValuationMethod.FIFO || r.avg_cost === null ? r.unit_cost : r.avg_cost);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
