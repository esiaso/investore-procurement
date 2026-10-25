import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssetStatus, ComplaintCategory, DocumentType, ReadingSource, SessionUser, StorageUnitType } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { Asset } from '../../modules/assets/assets.entities';
import { ItemsService } from '../../modules/catalog/items.service';
import { DistributionService } from '../../modules/logistics/distribution.service';
import { ShipmentsService } from '../../modules/logistics/shipments.service';
import { NumberingService } from '../../modules/numbering/numbering.service';
import { ColdChainService } from '../../modules/quality/cold-chain.service';
import { ComplaintsService } from '../../modules/quality/complaints.service';
import { SettingsService } from '../../modules/settings/settings.service';
import { UsersService } from '../../modules/users/users.service';

/**
 * Sample slice-8 data through the real services: a vaccine fridge and a cold
 * room with three days of in-range temperature logs, a delivery route from the
 * main store to the pharmacies, an inbound shipment on an open order, a
 * product complaint, an equipment item and a service item, and two tagged
 * patient monitors. Runs once (skipped when any storage unit exists).
 */
export async function seedSampleLogistics(app: INestApplicationContext, log: (m: string) => void = (m) => console.log(`[seed] ${m}`)) {
  const ds = app.get(DataSource);
  const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM storage_unit`);
  const [{ f }] = await ds.query(`SELECT count(*)::int AS f FROM facility WHERE code = 'SIL-NBI'`);
  if (n > 0 || f === 0) return;
  const users = app.get(UsersService);
  const actor = async (username: string): Promise<SessionUser | null> => {
    const [row] = await ds.query(`SELECT id FROM app_user WHERE username = $1`, [username]);
    return row ? users.findForSession(row.id) : null;
  };
  const scm = await actor('scm');
  const quality = await actor('quality');
  const tech = await actor('pharm.tech');
  if (!scm || !quality || !tech) return log('sample logistics skipped: users missing');
  const as = <T>(u: SessionUser, fn: () => Promise<T>) => RequestContext.run({ userId: u.id, username: u.username, storeIds: u.storeIds }, fn);
  const one = async (sql: string, p: unknown[] = []) => (await ds.query(sql, p))[0];
  const today = await app.get(SettingsService).today();
  const plus = (d: number) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
  const store = async (code: string) => (await one(`SELECT id FROM store WHERE code = $1`, [code]))?.id as string | undefined;
  const [ms, mp, opd, ipd] = [await store('MS'), await store('MP'), await store('OPD-PH'), await store('IPD-PH')];
  if (!ms || !mp) return;

  try {
    // Cold chain: fridge in the main pharmacy, cold room in the main store, logs twice a day.
    const cold = app.get(ColdChainService);
    const fridge = await as(quality, () => cold.saveUnit(null, { code: 'MP-FRIDGE-1', name: 'Main Pharmacy vaccine fridge', storeId: mp, type: StorageUnitType.FRIDGE, loggerSerial: 'LOG-0001', binIds: [] }));
    const room = await as(quality, () => cold.saveUnit(null, { code: 'MS-COLDROOM', name: 'Main Store cold room', storeId: ms, type: StorageUnitType.COLD_ROOM, loggerSerial: 'LOG-0002', binIds: [] }));
    const at = (daysAgo: number, hour: number) => new Date(Date.parse(`${plus(-daysAgo)}T${String(hour).padStart(2, '0')}:00:00+03:00`));
    for (const u of [fridge, room]) {
      const readings = [3, 2, 1].flatMap((d) => [
        { at: at(d, 8), t: 4 + (d % 2) * 0.6 },
        { at: at(d, 16), t: 5.2 - (d % 2) * 0.4 },
      ]);
      await as(quality, () => cold.record(u.id, readings, ReadingSource.MANUAL, quality));
    }

    // Delivery round from the main store to the pharmacies.
    await as(scm, () => app.get(DistributionService).saveRoute(null, { code: 'MS-PHARM', name: 'Main Store → pharmacies (daily)', fromStoreId: ms, stopStoreIds: [mp, opd, ipd].filter(Boolean) as string[], isActive: true }));

    // Inbound shipment on an order already sent to its supplier.
    const po = await one(`SELECT id FROM purchase_order WHERE status = 'SENT' ORDER BY created_at LIMIT 1`);
    if (po) {
      await as(scm, () => app.get(ShipmentsService).create({ purchaseOrderId: po.id, shippedOn: today, expectedOn: plus(3), carrier: 'Sample Logistics Ltd', trackingRef: 'SLL-0001', notes: 'Sample advance shipping notice' }, scm));
    }

    // A product complaint from the OPD pharmacy.
    const b = await one(`SELECT b.id, b.item_id FROM batch b JOIN stock_balance sb ON sb.batch_id = b.id JOIN item i ON i.id = b.item_id WHERE sb.store_id = $1 AND sb.on_hand > 0 AND i.generic_id IS NOT NULL AND b.hold_status = 'NONE' ORDER BY i.code LIMIT 1`, [opd ?? mp]);
    if (b) {
      await as(tech, () => app.get(ComplaintsService).create({ itemId: b.item_id, batchId: b.id, storeId: opd ?? mp, category: ComplaintCategory.PACKAGING, description: 'Sample: several blisters in one carton were torn on arrival from the main store', reportedByName: 'Njeri Technician', sampleRetained: true }, tech));
    }

    // Equipment and service items, and two tagged monitors on the medical ward.
    const cat = async (code: string) => (await one(`SELECT id FROM item_category WHERE code = $1`, [code]))?.id;
    const uom = (await one(`SELECT id FROM unit_of_measure WHERE code = 'PCS'`))?.id;
    const tax = (await one(`SELECT id FROM tax_category WHERE code = 'STANDARD'`))?.id ?? (await one(`SELECT id FROM tax_category LIMIT 1`)).id;
    const [equip, svc] = [await cat('EQUIP'), await cat('SVC')];
    const numbering = app.get(NumberingService);
    if (equip && svc && uom) {
      const mk = async (categoryId: string, name: string, price: number) =>
        (await as(scm, () => app.get(ItemsService).create({ categoryId, name, baseUomId: uom, unitPrice: price, taxCategoryId: tax, isBatchTracked: false } as never))).id;

      const monitor = await mk(equip, 'Patient monitor, 5-parameter (sample)', 185_000);
      await mk(svc, 'Preventive maintenance visit – CSSD autoclave (sample)', 12_000);
      const ward = (await one(`SELECT id FROM department WHERE code = 'IPD-MED'`))?.id ?? null;
      const incharge = await one(`SELECT id, full_name FROM app_user WHERE username = 'ward.incharge'`);
      for (const [i, serial] of ['PM-SAMPLE-0001', 'PM-SAMPLE-0002'].entries()) {
        await ds.getRepository(Asset).save(
          ds.getRepository(Asset).create({
            tagNo: await numbering.next(DocumentType.ASSET),
            itemId: monitor,
            description: 'Patient monitor, 5-parameter (sample)',
            serialNo: serial,
            acquiredOn: plus(-200),
            cost: 185_000,
            departmentId: ward,
            location: `Medical ward, bay ${i + 1}`,
            custodianUserId: incharge?.id ?? null,
            custodianName: incharge?.full_name ?? null,
            warrantyEndsOn: plus(i === 0 ? 40 : 400),
            maintenanceIntervalMonths: 6,
            nextMaintenanceOn: plus(i === 0 ? 10 : 120),
            status: AssetStatus.ACTIVE,
          }),
        );
      }
    }
    log('sample logistics: fridge and cold room with temperature logs, delivery route, inbound shipment, complaint, equipment and service items, 2 tagged monitors');
  } catch (e) {
    log(`sample logistics: stopped early (${(e as Error).message})`);
  }
}
