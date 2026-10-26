import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HmisAdapterKind, HmisBillingMode, HmisMappingKind, SessionUser } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { loadEnv } from '../../config/env';
import { HmisInboundService } from '../../modules/hmis/hmis-inbound.service';
import { HmisService } from '../../modules/hmis/hmis.service';
import { MockPrescription, seedMockHmis, sharedMockHmis } from '../../modules/hmis/mock/mock-hmis';
import { PatientChargesService } from '../../modules/hmis/patient-charges.service';
import { PharmacyService } from '../../modules/pharmacy/pharmacy.service';
import { UsersService } from '../../modules/users/users.service';

/** HMIS drug codes of the mock (as a Kenyan HMIS might code them) → sample generics. */
const DRUG_CODES: [code: string, inn: string, strength: string][] = [
  ['MOH-PARA-500', 'Paracetamol', '500 mg'],
  ['MOH-AMOX-500', 'Amoxicillin', '500 mg'],
  ['MOH-AMLO-5', 'Amlodipine', '5 mg'],
  ['MOH-OMEP-20', 'Omeprazole', '20 mg'],
  ['MOH-METRO-400', 'Metronidazole', '400 mg'],
  ['MOH-FURO-40', 'Furosemide', '40 mg'],
  ['MOH-IBU-400', 'Ibuprofen', '400 mg'],
];

/**
 * Sample HMIS link (mock FHIR HMIS, billing in the HMIS): mappings, the
 * sample patients linked to their HMIS records, orders received by polling
 * (an outpatient prescription with an allergy alert, an inpatient daily
 * supply that is dispensed on the ward round, and one with an unmapped drug
 * code for the integration dashboard) and ward consumables charged to an
 * admission. Runs once (skipped when a connection exists).
 */
export async function seedSampleHmis(app: INestApplicationContext, log: (m: string) => void = (m) => console.log(`[seed] ${m}`)) {
  const ds = app.get(DataSource);
  const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM hmis_connection`);
  const [{ p }] = await ds.query(`SELECT count(*)::int AS p FROM patient`);
  if (n > 0 || p === 0) return;
  const hmis = app.get(HmisService);
  const inbound = app.get(HmisInboundService);
  const pharmacy = app.get(PharmacyService);
  const charges = app.get(PatientChargesService);
  const users = app.get(UsersService);
  const one = async (sql: string, params: unknown[] = []) => (await ds.query(sql, params))[0];
  const actor = async (username: string): Promise<SessionUser | null> => {
    const row = await one(`SELECT id FROM app_user WHERE username = $1`, [username]);
    return row ? users.findForSession(row.id) : null;
  };
  const as = <T>(u: SessionUser, fn: () => Promise<T>) => RequestContext.run({ userId: u.id, username: u.username, storeIds: u.storeIds }, fn);

  const url = loadEnv().sampleHmisUrl;
  if (!url) {
    sharedMockHmis.reset();
    seedMockHmis(sharedMockHmis);
  }
  await hmis.saveConnection({ name: 'Mock HMIS (sample, FHIR R4)', adapter: HmisAdapterKind.MOCK, baseUrl: url ?? undefined, billingMode: HmisBillingMode.HMIS, sendDispenses: true, pollOrders: true });

  // Mappings: outlets, wards, the insurer, drug codes.
  const id = async (table: string, code: string) => (await one(`SELECT id FROM "${table}" WHERE code = $1`, [code]))?.id as string | undefined;
  const map = async (kind: HmisMappingKind, externalCode: string, localId: string | undefined, externalDisplay?: string) => {
    if (localId) await hmis.saveMapping({ kind, externalCode, localId, externalDisplay });
  };
  await map(HmisMappingKind.LOCATION, 'HMIS-OPD-PH', await id('store', 'OPD-PH'), 'OPD pharmacy');
  await map(HmisMappingKind.LOCATION, 'HMIS-IPD-PH', await id('store', 'IPD-PH'), 'Inpatient pharmacy');
  await map(HmisMappingKind.WARD, 'HMIS-MED', await id('department', 'IPD-MED'), 'Medical ward');
  await map(HmisMappingKind.WARD, 'HMIS-SURG', await id('department', 'IPD-SURG'), 'Surgical ward');
  await map(HmisMappingKind.WARD, 'HMIS-MAT', await id('department', 'MAT'), 'Maternity');
  await map(HmisMappingKind.PAYER, 'ALPHA', await id('payer', 'INS-ALPHA'), 'Alpha Health Insurance');
  for (const [code, inn, strength] of DRUG_CODES) {
    const g = await one(`SELECT id FROM generic WHERE inn_name = $1 AND strength = $2`, [inn, strength]);
    await map(HmisMappingKind.DRUG, code, g?.id, `${inn} ${strength}`);
  }

  const prescribe = async (rx: MockPrescription) => {
    if (!url) return sharedMockHmis.prescribe(rx);
    const res = await fetch(`${new URL(url).origin}/_mock/prescriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rx) });
    if (!res.ok) throw new Error(`mock HMIS answered ${res.status}`);
  };

  try {
    // Link the sample patients to their HMIS records (and add the one only the HMIS knows).
    for (const ext of ['pt-101', 'pt-102', 'pt-103', 'pt-105']) await inbound.importPatient(ext);
    // Orders written in the HMIS.
    await prescribe({ patient: 'pt-101', encounter: 'enc-101', location: 'HMIS-OPD-PH', prescriber: 'Dr. Achieng Odhiambo', lines: [
      { code: 'MOH-AMOX-500', display: 'Amoxicillin 500 mg caps', dose: 1, doseUnit: 'cap', frequency: 'TDS', durationDays: 5 },
      { code: 'MOH-PARA-500', display: 'Paracetamol 500 mg tabs', dose: 2, doseUnit: 'tab', frequency: 'TDS', durationDays: 3 },
    ] });
    await prescribe({ patient: 'pt-102', encounter: 'enc-102', location: 'HMIS-IPD-PH', prescriber: 'Dr. Achieng Odhiambo', lines: [
      { code: 'MOH-PARA-500', display: 'Paracetamol 500 mg tabs', dose: 2, doseUnit: 'tab', frequency: 'QID', durationDays: 5, supplyMode: 'DAILY' },
      { code: 'MOH-AMLO-5', display: 'Amlodipine 5 mg tabs', dose: 1, doseUnit: 'tab', frequency: 'OD', durationDays: 5, supplyMode: 'DAILY' },
    ] });
    await prescribe({ patient: 'pt-105', encounter: 'enc-105', location: 'HMIS-IPD-PH', prescriber: 'Dr. Otieno Surgeon', lines: [
      { code: 'MOH-TRAMA-50', display: 'Tramadol 50 mg caps', dose: 1, doseUnit: 'cap', frequency: 'TDS', durationDays: 3 },
    ] });
    const polled = await inbound.poll();
    log(`sample HMIS: ${JSON.stringify(polled)}`);

    // Ward round at the inpatient pharmacy: today's daily supply for Mr Otieno (charged to his HMIS bill).
    const pharmacist = await actor('pharmacist');
    const ipd = await id('store', 'IPD-PH');
    if (pharmacist && ipd) {
      await as(pharmacist, async () => {
        const list = await pharmacy.wardSupplyList({ storeId: ipd });
        const rxIds = [...new Set(list.patients.flatMap((x) => (x.lines as { prescriptionId: string; needsVerification: boolean }[]).filter((l) => l.needsVerification).map((l) => l.prescriptionId)))];
        for (const rxId of rxIds) await pharmacy.verify(rxId, pharmacist).catch(() => undefined);
        const options = new Map<string, string>();
        const lines = [];
        for (const pt of (await pharmacy.wardSupplyList({ storeId: ipd })).patients) {
          for (const l of pt.lines as { prescriptionId: string; prescriptionLineId: string; due: number }[]) {
            if (l.due <= 0) continue;
            if (!options.has(l.prescriptionLineId)) {
              for (const o of await pharmacy.options(l.prescriptionId)) {
                const brand = o.brands.filter((b) => b.available > 0).sort((a, b) => b.available - a.available)[0];
                if (brand) options.set(o.prescriptionLineId, brand.itemId);
              }
            }
            const itemId = options.get(l.prescriptionLineId);
            if (itemId) lines.push({ prescriptionLineId: l.prescriptionLineId, itemId, quantity: l.due });
          }
        }
        if (lines.length) {
          const r = await pharmacy.wardSupply({ storeId: ipd, lines }, pharmacist);
          log(`sample HMIS: ward round dispensed ${r.dispensed} prescription(s)${r.failed ? `, ${r.failed} failed` : ''}`);
        }
      });
    }

    // Surgical ward: gloves used on Mr Mwangi, charged to his admission.
    const nurse = await actor('surg.incharge');
    const enc = await one(`SELECT id, department_id FROM encounter WHERE external_id = 'enc-105'`);
    const gloves = await one(`SELECT i.id FROM item i JOIN item_category c ON c.id = i.category_id WHERE c.code = 'SUP-PPE' AND i.is_active ORDER BY i.code LIMIT 1`);
    const ms = await id('store', 'MS');
    if (nurse && enc?.department_id && gloves && ms) {
      await as(nurse, () => charges.wardConsumption({ encounterId: enc.id, departmentId: enc.department_id, storeId: ms, lines: [{ itemId: gloves.id, quantity: 4 }], note: 'Dressing change' }, nurse));
    }
    await hmis.dispatch();
  } catch (e) {
    log(`sample HMIS incomplete: ${(e as Error).message} (start the mock-hmis service, then use HMIS integration → Sync now)`);
  }
}
