import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MpesaEnvironment, SessionUser } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { MpesaService } from '../../modules/pos/mpesa.service';
import { PosAdminService } from '../../modules/pos/pos-admin.service';
import { UsersService } from '../../modules/users/users.service';

/**
 * Sample point of sale: two tills (OPD and main pharmacy), M-Pesa in mock
 * mode, a corporate credit customer and a walk-in loyalty customer, and a
 * promotion on a common OTC analgesic. Runs once (skipped when a till exists).
 */
export async function seedSamplePos(app: INestApplicationContext, log: (m: string) => void = (m) => console.log(`[seed] ${m}`)) {
  const ds = app.get(DataSource);
  const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM pos_terminal`);
  const [store] = await ds.query(`SELECT id FROM store WHERE code = 'OPD-PH'`);
  if (n > 0 || !store) return;
  const admin = app.get(PosAdminService);
  const users = app.get(UsersService);
  const one = async (sql: string, p: unknown[] = []) => (await ds.query(sql, p))[0];
  const row = await one(`SELECT id FROM app_user WHERE username = 'admin'`);
  const actor: SessionUser | null = row ? await users.findForSession(row.id) : null;
  if (!actor) return;
  try {
    await RequestContext.run({ userId: actor.id, username: actor.username, storeIds: actor.storeIds }, async () => {
      await admin.saveTerminal(null, { code: 'OPD-TILL-1', name: 'OPD pharmacy counter 1', storeId: store.id });
      const mp = await one(`SELECT id FROM store WHERE code = 'MP'`);
      if (mp) await admin.saveTerminal(null, { code: 'MP-TILL-1', name: 'Main pharmacy counter', storeId: mp.id });
      await app.get(MpesaService).saveConfig({ environment: MpesaEnvironment.MOCK, shortcode: '174379', transactionType: 'CustomerBuyGoodsOnline', partyB: '5123456' });
      const corporate = await one(`SELECT id FROM price_list WHERE code = 'CORPORATE'`);
      await admin.saveCustomer(null, { name: 'Beta Ltd (staff purchases)', phone: '0733000999', kraPin: 'P051234567X', priceListId: corporate?.id, creditAllowed: true, creditLimit: 20_000 }, actor);
      await admin.saveCustomer(null, { name: 'Grace Wanjiru', phone: '0722111222' }, actor);
      const para = await one(`SELECT i.id FROM item i JOIN generic g ON g.id = i.generic_id WHERE g.inn_name = 'Paracetamol' AND g.strength = '500 mg' ORDER BY i.code LIMIT 1`);
      await ds.query(`UPDATE generic SET max_qty_per_sale = 100 WHERE inn_name = 'Paracetamol'`);
      await ds.query(`UPDATE item i SET sales_class = 'OTC' FROM generic g WHERE g.id = i.generic_id AND g.inn_name IN ('Paracetamol', 'Ibuprofen', 'Cetirizine', 'Oral rehydration salts') AND i.sales_class IS NULL`);
      if (para) {
        const today = new Date().toISOString().slice(0, 10);
        const end = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
        await admin.savePromotion(null, { code: 'PARA-BULK', name: 'Paracetamol: 10% off from 20 tablets', itemId: para.id, discountPercent: 10, minQty: 20, startsOn: today, endsOn: end });
      }
    });
    log('sample POS: tills OPD-TILL-1 and MP-TILL-1, mock M-Pesa, two customers, one promotion');
  } catch (e) {
    log(`sample POS incomplete: ${(e as Error).message}`);
  }
}
