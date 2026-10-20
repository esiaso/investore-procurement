import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EtimsAdapterKind, PayerType, SalesSource, SessionUser, Sex } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { loadEnv } from '../../config/env';
import { BillingService } from '../../modules/billing/billing.service';
import { EtimsService } from '../../modules/etims/etims.service';
import { PharmacyService } from '../../modules/pharmacy/pharmacy.service';
import { UsersService } from '../../modules/users/users.service';
import { DEMO_GENERIC_FLAGS } from './reference-billing';

/** Sample outlets with a (mock) eTIMS control unit. */
const ETIMS_OUTLETS = ['MP', 'OPD-PH', 'IPD-PH'];

/** Demo item classes per category (the mock's demo classification). */
const DEMO_ITEM_CLASSES: [category: string, itemClsCd: string][] = [
  ['DRUG', '5100000000'],
  ['DRUG-ANTIINF', '5110000000'],
  ['DRUG-CNS', '5114000000'],
  ['DRUG-CVS', '5112000000'],
  ['DRUG-ENDO', '5118000000'],
  ['DRUG-FLUIDS', '5119000000'],
  ['DRUG-VACC', '5120000000'],
  ['DRUG-ANALG', '5130000000'],
  ['SUP', '4214000000'],
  ['SUP-PPE', '4213000000'],
  ['SUP-SUTURE', '4229000000'],
  ['SUP-LAB', '4127000000'],
];

/**
 * Sample pharmacy and billing data, through the real services:
 * payers, demo generic flags, mock eTIMS control units for the pharmacy
 * outlets (initialised, code tables synced, demo item classes mapped),
 * patients, prescriptions (one with interaction alerts), a dispense and an
 * OTC sale. Runs once (skipped when any patient exists).
 */
export async function seedSamplePharmacy(app: INestApplicationContext, log: (m: string) => void = (m) => console.log(`[seed] ${m}`)) {
  const ds = app.get(DataSource);
  const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM patient`);
  const [facility] = await ds.query(`SELECT id, kra_pin FROM facility WHERE code = 'SIL-NBI'`);
  if (n > 0 || !facility) return;

  const users = app.get(UsersService);
  const etims = app.get(EtimsService);
  const billing = app.get(BillingService);
  const pharmacy = app.get(PharmacyService);
  const actor = async (username: string): Promise<SessionUser | null> => {
    const [row] = await ds.query(`SELECT id FROM app_user WHERE username = $1`, [username]);
    return row ? users.findForSession(row.id) : null;
  };
  const pharmacist = await actor('pharmacist');
  const cashier = await actor('cashier');
  if (!pharmacist || !cashier) {
    log('sample pharmacy skipped: users missing');
    return;
  }
  const as = <T>(u: SessionUser, fn: () => Promise<T>) => RequestContext.run({ userId: u.id, username: u.username, storeIds: u.storeIds }, fn);
  const one = async (sql: string, params: unknown[] = []) => (await ds.query(sql, params))[0];

  // Generic flags used by the age / pregnancy checks (demo values).
  for (const f of DEMO_GENERIC_FLAGS) {
    await ds.query(
      `UPDATE generic SET pregnancy_contraindicated = COALESCE($2, pregnancy_contraindicated), min_age_years = COALESCE($3, min_age_years) WHERE inn_name = $1`,
      [f.inn, f.pregnancyContraindicated ?? null, f.minAgeYears ?? null],
    );
  }

  const insurance = await billing.savePayer(null, { code: 'INS-ALPHA', name: 'Alpha Health Insurance (sample)', type: PayerType.INSURANCE, coPayPercent: 10, priceListId: (await one(`SELECT id FROM price_list WHERE code = 'INSURANCE'`))?.id ?? null, etimsInsuranceCode: 'ALPHA' });
  await billing.savePayer(null, { code: 'CORP-BETA', name: 'Beta Ltd staff medical scheme (sample)', type: PayerType.CORPORATE, coPayPercent: 0, priceListId: (await one(`SELECT id FROM price_list WHERE code = 'CORPORATE'`))?.id ?? null });

  // Mock control units: initialise, sync code tables, map item classes.
  const url = loadEnv().sampleEtimsUrl;
  let serial = 0;
  for (const code of ETIMS_OUTLETS) {
    const store = await one(`SELECT id FROM store WHERE code = $1`, [code]);
    if (!store) continue;
    const cfg = await etims.saveConfig({ storeId: store.id, adapter: EtimsAdapterKind.MOCK, baseUrl: url, kraPin: facility.kra_pin ?? 'P000000000X', branchId: String(serial).padStart(2, '0'), deviceSerial: `SAMPLE-OSCU-${String(++serial).padStart(3, '0')}` });
    try {
      await etims.initialise(cfg.id);
    } catch (e) {
      log(`sample eTIMS: ${code} not initialised (${(e as Error).message}); start the mock-etims service and initialise it under eTIMS → Control units`);
    }
  }
  const synced = await etims.syncCodes().catch(() => ({ codes: 0, itemClasses: 0 }));
  if (synced.itemClasses) {
    for (const [category, cls] of DEMO_ITEM_CLASSES) await etims.setMapping('ITEM_CLASS', `category:${category}`, cls);
  }

  // Patients (cached from the HMIS).
  const patients = [
    { hospitalNo: 'SIL-000101', name: 'Wanjiku Kamau', dateOfBirth: '1984-03-12', sex: Sex.F, weightKg: 68, isPregnant: false, allergies: ['penicillins'], phone: '0712000101' },
    { hospitalNo: 'SIL-000102', name: 'Ochieng Otieno', dateOfBirth: '1958-11-02', sex: Sex.M, weightKg: 81, isPregnant: false, allergies: [], payerId: insurance.id, memberNo: 'ALPHA-55821' },
    { hospitalNo: 'SIL-000103', name: 'Amina Hassan', dateOfBirth: '1996-07-21', sex: Sex.F, weightKg: 59, isPregnant: true, allergies: ['sulfonamides'] },
    { hospitalNo: 'SIL-000104', name: 'Baby Kiptoo', dateOfBirth: '2021-01-15', sex: Sex.M, weightKg: 16, isPregnant: false, allergies: [] },
  ];
  const saved: { id: string }[] = [];
  for (const p of patients) saved.push(await pharmacy.savePatient(null, p));

  const opd = await one(`SELECT id FROM store WHERE code = 'OPD-PH'`);
  const generic = async (inn: string, strength: string) => (await one(`SELECT id FROM generic WHERE inn_name = $1 AND strength = $2`, [inn, strength]))?.id as string | undefined;
  const stocked = async (genericId: string | undefined) =>
    genericId
      ? one(
          `SELECT i.id FROM item i JOIN stock_balance sb ON sb.item_id = i.id AND sb.store_id = $2 JOIN batch b ON b.id = sb.batch_id
            WHERE i.generic_id = $1 AND sb.on_hand - sb.reserved >= 30 AND b.hold_status = 'NONE' AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
            GROUP BY i.id ORDER BY i.id LIMIT 1`,
          [genericId, opd.id],
        )
      : null;
  if (!opd) return;

  let made = 0;
  try {
    await as(pharmacist, async () => {
      // 1. Simple prescription, verified and partly dispensed (insurance patient: payer split).
      const para = await generic('Paracetamol', '500 mg');
      const amlo = await generic('Amlodipine', '5 mg');
      if (para && amlo) {
        const rx = await pharmacy.createPrescription({
          patientId: saved[1].id,
          storeId: opd.id,
          prescriber: 'Dr. M. Njoroge',
          prescriberRegNo: 'KMPDC-A1234',
          encounterRef: 'OPD-2026-0001',
          lines: [
            { genericId: para, dose: '1 g', frequency: 'TDS', duration: '5 days', route: 'PO', quantity: 30 },
            { genericId: amlo, dose: '5 mg', frequency: 'OD', duration: '30 days', route: 'PO', quantity: 30 },
          ],
        });
        made++;
        await pharmacy.verify(rx.id, pharmacist);
        const item = await stocked(para);
        if (item) await pharmacy.dispense(rx.id, { lines: [{ prescriptionLineId: rx.lines!.find((l) => l.genericId === para)!.id, itemId: item.id, quantity: 30 }], payments: [{ modeCode: 'MPESA', amount: 5_000, reference: 'SAMPLE1A2B' }] }, pharmacist);
      }
      // 2. Prescription with blocking alerts awaiting the pharmacist (allergy + NSAID/anticoagulant).
      const amox = await generic('Amoxicillin', '500 mg');
      const ibu = await generic('Ibuprofen', '400 mg');
      const enox = await generic('Enoxaparin sodium', '40 mg/0.4 mL');
      if (amox && ibu && enox) {
        await pharmacy.createPrescription({
          patientId: saved[0].id,
          storeId: opd.id,
          prescriber: 'Dr. A. Wekesa',
          lines: [
            { genericId: amox, dose: '500 mg', frequency: 'TDS', duration: '7 days', route: 'PO', quantity: 21 },
            { genericId: ibu, dose: '400 mg', frequency: 'TDS', duration: '5 days', route: 'PO', quantity: 15 },
            { genericId: enox, dose: '40 mg', frequency: 'OD', duration: '5 days', route: 'SC', quantity: 5 },
          ],
        });
        made++;
      }
      // 3. Pregnant patient prescribed doxycycline (pregnancy alert).
      const doxy = await generic('Doxycycline', '100 mg');
      if (doxy) {
        await pharmacy.createPrescription({ patientId: saved[2].id, storeId: opd.id, prescriber: 'Dr. S. Mutiso', lines: [{ genericId: doxy, dose: '100 mg', frequency: 'BD', duration: '7 days', route: 'PO', quantity: 14 }] });
        made++;
      }
    });

    // OTC sale at the OPD pharmacy (cash, B2C).
    const otc = await one(
      `SELECT i.id FROM item i JOIN stock_balance sb ON sb.item_id = i.id AND sb.store_id = $1 JOIN batch b ON b.id = sb.batch_id
        WHERE i.sales_class = 'OTC' AND NOT i.is_controlled AND sb.on_hand - sb.reserved >= 10 AND b.hold_status = 'NONE' AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
        GROUP BY i.id ORDER BY i.id LIMIT 1`,
      [opd.id],
    );
    if (otc) await as(cashier, () => billing.sell({ storeId: opd.id, source: SalesSource.OTC, lines: [{ itemId: otc.id, quantity: 2 }], payments: [{ modeCode: 'CASH', amount: 2_000 }] }, cashier));
  } catch (e) {
    log(`sample pharmacy: stopped early (${(e as Error).message})`);
  }
  log(`sample pharmacy: ${patients.length} patients, ${made} prescriptions, ${ETIMS_OUTLETS.length} mock eTIMS outlets`);
}
