import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ContractType, EvaluationStage, NationalAgency, QuantificationMethod, SessionUser, SourcingMethod } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { ForecastingService } from '../../modules/forecasting/forecasting.service';
import { AgenciesService } from '../../modules/procurement/agencies.service';
import { ContractsService } from '../../modules/procurement/contracts.service';
import { PlansService } from '../../modules/procurement/plans.service';
import { TendersService } from '../../modules/procurement/tenders.service';
import { financialYearOf } from '../../modules/numbering/financial-year';
import { SettingsService } from '../../modules/settings/settings.service';
import { SuppliersService } from '../../modules/suppliers/suppliers.service';
import { UsersService } from '../../modules/users/users.service';

/**
 * Sample strategic-procurement data, through the real services: KEMSA as a
 * national agency with an order template, a donor funding source on some
 * malaria stock, a malaria programme with a quantification, forecasts for the
 * Main Pharmacy, a framework agreement, a draft departmental plan and an open
 * tender visible in the supplier portal. Runs once (skipped when any programme exists).
 */
export async function seedSampleStrategic(app: INestApplicationContext, log: (m: string) => void = (m) => console.log(`[seed] ${m}`)) {
  const ds = app.get(DataSource);
  const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM programme`);
  const [{ f }] = await ds.query(`SELECT count(*)::int AS f FROM facility WHERE code = 'SIL-NBI'`);
  if (n > 0 || f === 0) return;
  const users = app.get(UsersService);
  const actor = async (username: string): Promise<SessionUser | null> => {
    const [row] = await ds.query(`SELECT id FROM app_user WHERE username = $1`, [username]);
    return row ? users.findForSession(row.id) : null;
  };
  const scm = await actor('scm');
  const pharmacist = await actor('pharmacist');
  const manager = await actor('proc.manager');
  if (!scm || !pharmacist || !manager) {
    log('sample strategic procurement skipped: users missing');
    return;
  }
  const as = <T>(u: SessionUser, fn: () => Promise<T>) => RequestContext.run({ userId: u.id, username: u.username, storeIds: u.storeIds }, fn);
  const one = async (sql: string, p: unknown[] = []) => (await ds.query(sql, p))[0];
  const settings = app.get(SettingsService);
  const today = await settings.today();
  const plus = (d: number) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
  const mp = (await one(`SELECT id FROM store WHERE code = 'MP'`)).id as string;
  const pharmDept = (await one(`SELECT id FROM department WHERE code = 'PHARM'`))?.id as string | undefined;
  const forecasting = app.get(ForecastingService);

  try {
    // National agency.
    const kemsa = await as(scm, () =>
      app.get(SuppliersService).create({ name: 'Kenya Medical Supplies Authority (sample)', kraPin: 'P000000099K', email: 'orders@kemsa.example', paymentTermsDays: 30, nationalAgency: NationalAgency.KEMSA } as never),
    );
    // Donor stock: malaria commodities funded by a donor, not for sale.
    const al = await one(`SELECT i.id, i.name FROM item i JOIN generic g ON g.id = i.generic_id WHERE g.inn_name = 'Artemether + Lumefantrine' ORDER BY i.code LIMIT 1`);
    const artesunate = await one(`SELECT i.id FROM item i JOIN generic g ON g.id = i.generic_id WHERE g.inn_name = 'Artesunate' ORDER BY i.code LIMIT 1`);
    const programme = await as(scm, () =>
      forecasting.saveProgramme(null, {
        code: 'MALARIA',
        name: 'Malaria case management',
        description: 'Sample programme: uncomplicated malaria (AL) and severe malaria (artesunate)',
        commodities: [
          ...(al ? [{ itemId: al.id, unitsPerPatientMonth: 24, regimenSharePercent: 90, protocolNotes: 'AL 20/120: 24 tablets per adult course' }] : []),
          ...(artesunate ? [{ itemId: artesunate.id, unitsPerPatientMonth: 6, regimenSharePercent: 10, protocolNotes: 'Severe malaria: about 6 vials per patient' }] : []),
        ],
      }),
    );
    await as(scm, () => forecasting.saveFundingSource(null, { code: 'GLOBAL_FUND', name: 'Global Fund malaria grant (sample)', donor: 'Global Fund', programmeId: programme.id, allowSale: false, notes: 'Free to patients: may be issued and dispensed without charge, never sold' }));
    if (al) {
      await ds.query(
        `UPDATE batch SET funding_source = 'GLOBAL_FUND' WHERE id IN (
           SELECT b.id FROM batch b JOIN stock_balance sb ON sb.batch_id = b.id WHERE b.item_id = $1 AND sb.store_id = $2 ORDER BY b.expiry_date LIMIT 1)`,
        [al.id, mp],
      );
    }
    if (programme.commodities?.length) {
      await as(scm, () => forecasting.quantify({ programmeId: programme.id, storeId: mp, title: `Malaria commodities ${financialYearOf(today, 1).label} (target population = average monthly caseload)`, periodMonths: 12, targetPopulation: 100, coveragePercent: 80, wastagePercent: 5, method: QuantificationMethod.MORBIDITY }));
    }
    const forecast = await as(scm, () => forecasting.run({ storeId: mp }, scm));
    // Framework agreement with the first supplier for three items it supplies at contract prices.
    const s1 = await one(`SELECT id FROM supplier WHERE code = 'SUP0001'`);
    const priced: { item_id: string; unit_price: number }[] = await ds.query(`SELECT item_id, unit_price::float AS unit_price FROM contract_price WHERE supplier_id = $1 ORDER BY item_id LIMIT 3`, [s1.id]);
    if (priced.length) {
      const contracts = app.get(ContractsService);
      const c = await as(manager, () =>
        contracts.create({ title: 'Framework agreement: essential medicines (sample)', supplierId: s1.id, type: ContractType.FRAMEWORK, startDate: today, endDate: plus(365), value: 2_000_000, deliveryTerms: 'DDP hospital stores within 7 days of a call-off', paymentTermsDays: 30, leadTimeDays: 7, lines: priced.map((p) => ({ itemId: p.item_id, unitPrice: p.unit_price, quantity: 5000 })) }),
      );
      await as(manager, () => contracts.sign(c.id, { supplierSignatory: 'Sales Director (sample)' }, manager));
      await as(manager, () => contracts.addSecurity(c.id, { securityType: 'BANK_GUARANTEE', reference: 'BG-SAMPLE-001', issuer: 'Sample Bank', amount: 100_000, expiresOn: plus(20) }));
    }
    // KEMSA order cycle for the Main Pharmacy.
    if (pharmDept && al) {
      await as(scm, () => app.get(AgenciesService).saveTemplate(null, { name: 'KEMSA monthly order – Main Pharmacy', supplierId: kemsa.id, storeId: mp, departmentId: pharmDept, frequencyMonths: 1, nextOrderDate: plus(7), leadTimeDays: 21, quantityMode: 'SUGGESTED', lines: [{ itemId: al.id, quantity: 300 }], isActive: true }));
    }
    // Draft departmental plan (pharmacy) on the pharmacy budget vote head.
    const fy = financialYearOf(today, await settings.get('finance.fyStartMonth')).label;
    const budget = pharmDept ? await one(`SELECT vote_head FROM budget WHERE department_id = $1 AND financial_year = $2 LIMIT 1`, [pharmDept, fy]) : null;
    if (pharmDept && budget) {
      const items: { id: string; unit_price: number }[] = await ds.query(`SELECT id, unit_price::float AS unit_price FROM item WHERE generic_id IS NOT NULL ORDER BY code LIMIT 4`);
      await as(pharmacist, () =>
        app.get(PlansService).create(
          { financialYear: fy, departmentId: pharmDept, title: `Pharmacy procurement plan ${fy}`, lines: items.map((it, i) => ({ itemId: it.id, quantity: 1000 * (i + 1), estimatedUnitCost: Math.max(1, it.unit_price), voteHead: budget.vote_head, plannedQuarter: (i % 4) + 1 })) },
          { ...pharmacist, departmentId: pharmDept },
        ),
      );
    }
    // An open tender, visible to every supplier in the portal.
    const supplyItems: { id: string; name: string }[] = await ds.query(`SELECT id, name FROM item WHERE generic_id IS NULL ORDER BY code LIMIT 2`);
    if (supplyItems.length) {
      const t = await as(manager, () =>
        app.get(TendersService).create(
          {
            title: 'Supply of surgical gloves and dressings (sample)',
            method: SourcingMethod.OPEN_TENDER,
            estimatedValue: 2_500_000,
            closingAt: new Date(Date.parse(`${plus(14)}T09:00:00Z`)).toISOString(),
            bidSecurityAmount: 0,
            technicalWeight: 30,
            technicalPassMark: 60,
            lines: supplyItems.map((it) => ({ itemId: it.id, quantity: 10_000, specification: 'As per the attached specification (sample)' })),
            criteria: [
              { stage: EvaluationStage.PRELIMINARY, name: 'Valid tax compliance certificate' },
              { stage: EvaluationStage.PRELIMINARY, name: 'Valid business permit' },
              { stage: EvaluationStage.TECHNICAL, name: 'Compliance with specifications', weight: 60, maxScore: 10 },
              { stage: EvaluationStage.TECHNICAL, name: 'Delivery capacity and references', weight: 40, maxScore: 10 },
            ],
          },
          manager,
        ),
      );
      await as(manager, () => app.get(TendersService).publish(t.id));
    }
    log(`sample strategic procurement: KEMSA, MALARIA programme, ${forecast.forecasts} forecasts, framework agreement, order template, draft plan, open tender`);
  } catch (e) {
    log(`sample strategic procurement: stopped early (${(e as Error).message})`);
  }
}
