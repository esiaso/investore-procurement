import { EntityManager } from 'typeorm';
import { BudgetEnforcement, PrequalificationStatus, SupplierStatus } from '@sil/shared';
import { encryptField, mask } from '../../common/crypto';
import { loadEnv } from '../../config/env';
import { Budget } from '../../modules/budgets/budgets.entities';
import { financialYearOf } from '../../modules/numbering/financial-year';
import { dateInTimezone } from '../../modules/settings/settings.service';
import { ContractPrice, Supplier, SupplierContact, SupplierDocument } from '../../modules/suppliers/suppliers.entities';

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/* Fictional suppliers (all names, PINs, phone numbers and accounts are made up). */
const SUPPLIERS: { name: string; categories: string[]; status?: SupplierStatus; reason?: string; prequalExpired?: boolean; terms: number; town: string }[] = [
  { name: 'Amani Pharmaceutical Distributors (Sample)', categories: ['DRUG'], terms: 60, town: 'Nairobi' },
  { name: 'Baraka Medical Supplies Ltd (Sample)', categories: ['SUP'], terms: 30, town: 'Nairobi' },
  { name: 'Chui Healthcare Ltd (Sample)', categories: ['DRUG', 'SUP'], terms: 45, town: 'Mombasa' },
  { name: 'Dawa Bora Wholesalers (Sample)', categories: ['DRUG'], terms: 30, town: 'Kisumu' },
  { name: 'Ewaso Surgicals (Sample)', categories: ['SUP'], terms: 30, town: 'Nakuru' },
  { name: 'Faraja Lab Supplies (Sample)', categories: ['SUP'], terms: 30, town: 'Nairobi' },
  { name: 'Gatundu Pharma Ltd (Sample)', categories: ['DRUG'], terms: 60, town: 'Thika' },
  { name: 'Hekima Medical Ltd (Sample)', categories: ['DRUG', 'SUP'], terms: 30, town: 'Eldoret' },
  { name: 'Imara Distributors (Sample)', categories: ['DRUG'], terms: 45, town: 'Nairobi' },
  { name: 'Jamii Pharmaceuticals (Sample)', categories: ['DRUG'], terms: 30, town: 'Machakos', prequalExpired: true },
  { name: 'Kifaru Surgical Co. (Sample)', categories: ['SUP'], terms: 30, town: 'Nairobi', status: SupplierStatus.SUSPENDED, reason: 'Repeated late deliveries (sample)' },
  { name: 'Lulu Diagnostics (Sample)', categories: ['SUP'], terms: 30, town: 'Nairobi' },
  { name: 'Mwangaza Medical Imports (Sample)', categories: ['DRUG', 'SUP'], terms: 90, town: 'Mombasa' },
  { name: 'Nyota Pharma Kenya (Sample)', categories: ['DRUG'], terms: 30, town: 'Nyeri', status: SupplierStatus.BLACKLISTED, reason: 'Supplied falsified product (sample record)' },
  { name: 'Ongeza Hospital Supplies (Sample)', categories: ['SUP'], terms: 30, town: 'Kakamega' },
];

export async function seedSampleSuppliers(m: EntityManager, timezone: string, log: (msg: string) => void): Promise<void> {
  const key = loadEnv().dataEncryptionKey;
  const today = dateInTimezone(new Date(), timezone);
  const cats: { id: string; code: string; parent_id: string | null }[] = await m.query(`SELECT id, code, parent_id FROM item_category`);
  const root = (code: string) => cats.filter((c) => c.code === code || cats.find((p) => p.id === c.parent_id)?.code === code).map((c) => c.id);

  const created: Supplier[] = [];
  for (const [i, s] of SUPPLIERS.entries()) {
    const n = i + 1;
    const account = `01${String(1000000000 + n * 7919).slice(0, 10)}`;
    const supplier = await m.save(
      m.create(Supplier, {
        code: `SUP${String(n).padStart(4, '0')}`,
        name: s.name,
        kraPin: `P${String(900000000 + n).padStart(9, '0')}Z`,
        email: `orders@supplier${n}.example`,
        phone: `+254 700 ${String(100000 + n).slice(-6)}`,
        address: `P.O. Box ${1000 + n}, ${s.town}`,
        paymentTermsDays: s.terms,
        status: s.status ?? SupplierStatus.ACTIVE,
        statusReason: s.reason ?? null,
        prequalificationStatus: PrequalificationStatus.PREQUALIFIED,
        prequalifiedUntil: s.prequalExpired ? addDays(today, -15) : addDays(today, 200 + n * 10),
        categoryIds: s.categories.flatMap(root),
        bankName: ['Sample Bank A', 'Sample Bank B', 'Sample Bank C'][n % 3],
        bankBranch: s.town,
        bankAccountEnc: encryptField(key, account),
        bankAccountMasked: mask(account),
        contacts: [
          m.create(SupplierContact, { name: `Sales Desk ${n}`, role: 'Sales', email: `sales@supplier${n}.example`, phone: `+254 711 ${String(200000 + n).slice(-6)}`, isPrimary: true }),
          m.create(SupplierContact, { name: `Accounts ${n}`, role: 'Accounts', email: `accounts@supplier${n}.example` }),
        ],
      }),
    );
    const docs: Partial<SupplierDocument>[] = [
      { documentType: 'TAX_COMPLIANCE', reference: `TCC-SAMPLE-${n}`, issuedOn: addDays(today, -100), expiresOn: addDays(today, n === 3 ? 20 : 265) },
      { documentType: 'BUSINESS_PERMIT', reference: `SBP-SAMPLE-${n}`, issuedOn: addDays(today, -200), expiresOn: addDays(today, 165) },
    ];
    if (s.categories.includes('DRUG')) {
      docs.push({ documentType: 'PPB_LICENCE', reference: `PPB/WHL/SAMPLE/${n}`, issuedOn: addDays(today, -300), expiresOn: addDays(today, n === 4 ? -5 : 60 + n * 7) });
    }
    await m.save(docs.map((d) => m.create(SupplierDocument, { ...d, supplierId: supplier.id })));
    created.push(supplier);
  }

  // Keep the SUP counter ahead of the codes used above.
  await m.query(
    `INSERT INTO document_sequence (scheme_id, period, next_value)
     SELECT id, 'ALL', $1 FROM numbering_scheme WHERE document_type = 'SUP' AND store_id IS NULL
     ON CONFLICT (scheme_id, period) DO UPDATE SET next_value = GREATEST(document_sequence.next_value, EXCLUDED.next_value)`,
    [created.length + 1],
  );

  // Contract price lists for three suppliers.
  const drugs: { id: string; unit_price: string }[] = await m.query(
    `SELECT id, unit_price FROM item WHERE generic_id IS NOT NULL AND NOT is_controlled ORDER BY code LIMIT 40`,
  );
  const supplies: { id: string; unit_price: string }[] = await m.query(`SELECT id, unit_price FROM item WHERE generic_id IS NULL ORDER BY code LIMIT 20`);
  const lists: [Supplier, { id: string; unit_price: string }[], number][] = [
    [created[0], drugs.slice(0, 25), 0.62],
    [created[2], drugs.slice(15, 40), 0.65],
    [created[1], supplies, 0.6],
  ];
  let prices = 0;
  for (const [supplier, items, factor] of lists) {
    for (const it of items) {
      await m.save(
        m.create(ContractPrice, {
          supplierId: supplier.id,
          itemId: it.id,
          unitPrice: Math.round(Number(it.unit_price) * factor * 100) / 100,
          validFrom: addDays(today, -60),
          validTo: addDays(today, 305),
          contractRef: `FRAMEWORK-SAMPLE-${supplier.code}`,
        }),
      );
      prices++;
    }
  }

  // Budgets for the current financial year.
  const [{ value: fyStart }] = await m.query(`SELECT value FROM system_setting WHERE key = 'finance.fyStartMonth'`);
  const fy = financialYearOf(today, Number(fyStart)).label;
  const depts = new Map<string, string>(
    (await m.query(`SELECT code, id FROM department`)).map((d: { code: string; id: string }) => [d.code, d.id]),
  );
  const budgets: [dept: string, vote: string, desc: string, amount: number, enf: BudgetEnforcement][] = [
    ['PHARM', 'PHARMA', 'Medicines and pharmaceuticals', 20_000_000, BudgetEnforcement.WARN],
    ['PHARM', 'MED-SUPPLIES', 'Pharmacy consumables', 3_000_000, BudgetEnforcement.WARN],
    ['ADMIN', 'MED-SUPPLIES', 'Hospital-wide medical supplies', 8_000_000, BudgetEnforcement.WARN],
    ['LAB', 'LAB-REAGENTS', 'Laboratory reagents and kits', 3_000_000, BudgetEnforcement.BLOCK],
    ['THEATRE', 'SURGICAL', 'Theatre sutures, drapes and consumables', 5_000_000, BudgetEnforcement.WARN],
    ['ICU', 'ICU-CONSUMABLES', 'ICU consumables', 2_000_000, BudgetEnforcement.BLOCK],
    ['IPD-MED', 'WARD-SUPPLIES', 'Medical ward supplies', 1_500_000, BudgetEnforcement.WARN],
  ];
  for (const [dept, voteHead, description, amount, enforcement] of budgets) {
    await m.save(m.create(Budget, { departmentId: depts.get(dept)!, voteHead, description, financialYear: fy, amount, enforcement }));
  }
  log(`sample suppliers: ${created.length} suppliers, ${prices} contract prices, ${budgets.length} budgets (FY ${fy})`);
}
