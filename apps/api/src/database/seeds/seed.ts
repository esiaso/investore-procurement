import * as argon2 from 'argon2';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { DocumentType, PERMISSION_DESCRIPTIONS, type PermissionCode } from '@sil/shared';
import { RequestContext } from '../../common/request-context';
import { Generic, Item, ItemCategory, UnitConversion, UnitOfMeasure } from '../../modules/catalog/catalog.entities';
import { formatDocumentNumber } from '../../modules/numbering/financial-year';
import { NumberingScheme } from '../../modules/numbering/numbering.entities';
import { Bin, Department, Facility, Store } from '../../modules/org/org.entities';
import { Permission, Role } from '../../modules/rbac/rbac.entities';
import { SystemSetting } from '../../modules/settings/system-setting.entity';
import { TaxCategory, TaxRate } from '../../modules/tax/tax.entities';
import { User } from '../../modules/users/user.entity';
import { ApproverType } from '@sil/shared';
import { ApprovalStep, ApprovalWorkflow } from '../../modules/approvals/approvals.entities';
import { AdjustmentReason, ReturnReason } from '../../modules/inventory/documents.entities';
import { PaymentMode, PriceList } from '../../modules/billing/billing.entities';
import { EtimsCodeMapping } from '../../modules/etims/etims.entities';
import { orderPair } from '../../modules/pharmacy/interactions';
import { DrugInteraction } from '../../modules/pharmacy/pharmacy.entities';
import { DEFAULT_ETIMS_MAPPINGS, DEFAULT_PAYMENT_MODES, DEFAULT_PRICE_LISTS, DEMO_INTERACTIONS } from './reference-billing';
import { seedSampleStock } from './sample-stock';
import { seedSampleSuppliers } from './sample-suppliers';
import {
  DEFAULT_ADJUSTMENT_REASONS,
  DEFAULT_CATEGORIES,
  DEFAULT_CONVERSIONS,
  DEFAULT_NUMBERING,
  DEFAULT_RETURN_REASONS,
  DEFAULT_ROLES,
  DEFAULT_SETTINGS,
  DEFAULT_TAX,
  DEFAULT_UOMS,
  DEFAULT_WORKFLOWS,
} from './reference-data';
import {
  SAMPLE_DEPARTMENTS,
  SAMPLE_FACILITY,
  SAMPLE_GENERICS,
  SAMPLE_STORES,
  SAMPLE_SUPPLIES,
  SAMPLE_USERS,
} from './sample-data';

export interface SeedOptions {
  /** Password given to every sample user. Required when sample=true. */
  defaultPassword: string | null;
  sample: boolean;
  log?: (msg: string) => void;
}

/** GTIN-13 in the GS1 restricted-circulation range (prefix 2), valid check digit. */
export function sampleGtin(n: number): string {
  const body = `20${String(n).padStart(10, '0')}`;
  const sum = body
    .split('')
    .reverse()
    .reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

/** Idempotent: reference data is upserted by key/code; sample data only on an empty database. */
export async function seedDatabase(dataSource: DataSource, options: SeedOptions): Promise<void> {
  const log = options.log ?? ((m: string) => console.log(`[seed] ${m}`));
  await RequestContext.run({ username: 'system:seed' }, () =>
    dataSource.transaction(async (m) => {
      await seedReference(m, log);
      if (options.sample) {
        if (await m.exists(Facility)) {
          log('sample data already present, skipping');
          if (options.defaultPassword) {
            const added = await seedSampleUsers(m, options.defaultPassword);
            if (added) log(`added ${added} new sample user(s)`);
          }
        } else {
          if (!options.defaultPassword) throw new Error('SEED_DEFAULT_PASSWORD is required to create sample users');
          await seedSample(m, options.defaultPassword, log);
        }
        // Sample stock arrived in a later release: add it once to sample databases without stock.
        const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM stock_transaction`);
        const [{ sample }] = await m.query(`SELECT count(*)::int AS sample FROM facility WHERE code = $1`, [SAMPLE_FACILITY.code]);
        const [{ value: tz }] = await m.query(`SELECT value FROM system_setting WHERE key = 'locale.timezone'`);
        if (n === 0 && sample > 0) await seedSampleStock(m, tz, log);
        // Suppliers and budgets arrived with slice 3.
        const [{ s }] = await m.query(`SELECT count(*)::int AS s FROM supplier`);
        if (s === 0 && sample > 0) await seedSampleSuppliers(m, tz, log);
      }
    }),
  );
}

async function seedReference(m: EntityManager, log: (msg: string) => void): Promise<void> {
  for (const s of DEFAULT_SETTINGS) {
    if (!(await m.existsBy(SystemSetting, { key: s.key }))) await m.save(m.create(SystemSetting, s));
  }

  const knownPermissions = new Set((await m.find(Permission)).map((p) => p.code));
  const newPermissions = new Set<string>();
  for (const [code, description] of Object.entries(PERMISSION_DESCRIPTIONS)) {
    if (!knownPermissions.has(code)) newPermissions.add(code);
    await m.upsert(Permission, { code, description }, ['code']);
  }

  for (const r of DEFAULT_ROLES) {
    const existing = await m.findOne(Role, { where: { code: r.code }, relations: { permissions: true } });
    if (!existing) {
      const permissions = r.permissions.map((code: PermissionCode) => ({ code }) as Permission);
      await m.save(m.create(Role, { code: r.code, name: r.name, description: r.description, isSystem: true, permissions }));
      continue;
    }
    // Permissions introduced by a newer release are granted to built-in roles once;
    // permissions an admin removed earlier are not re-added.
    const grant = r.permissions.filter((code) => newPermissions.has(code) && !existing.permissions!.some((p) => p.code === code));
    if (existing.isSystem && grant.length) {
      await m.query(
        `INSERT INTO role_permission (role_id, permission_code) SELECT $1, unnest($2::varchar[]) ON CONFLICT DO NOTHING`,
        [existing.id, grant],
      );
      log(`granted ${grant.length} new permission(s) to ${r.code}`);
    }
  }

  for (const reason of DEFAULT_ADJUSTMENT_REASONS) {
    if (!(await m.existsBy(AdjustmentReason, { code: reason.code }))) await m.save(m.create(AdjustmentReason, reason));
  }
  for (const reason of DEFAULT_RETURN_REASONS) {
    if (!(await m.existsBy(ReturnReason, { code: reason.code }))) await m.save(m.create(ReturnReason, reason));
  }

  for (const t of DEFAULT_TAX) {
    if (await m.existsBy(TaxCategory, { code: t.code })) continue;
    const cat = await m.save(m.create(TaxCategory, { code: t.code, name: t.name, treatment: t.treatment }));
    await m.save(m.create(TaxRate, { taxCategoryId: cat.id, ratePercent: t.ratePercent, effectiveFrom: t.effectiveFrom }));
  }

  for (const n of DEFAULT_NUMBERING) {
    if (await m.existsBy(NumberingScheme, { documentType: n.documentType, storeId: IsNull() })) continue;
    await m.save(m.create(NumberingScheme, { ...n, storeId: null }));
  }

  for (const [code, name] of DEFAULT_UOMS) {
    if (!(await m.existsBy(UnitOfMeasure, { code }))) await m.save(m.create(UnitOfMeasure, { code, name }));
  }
  const uoms = new Map((await m.find(UnitOfMeasure)).map((u) => [u.code, u]));
  for (const [from, to, factor] of DEFAULT_CONVERSIONS) {
    const fromUomId = uoms.get(from)!.id;
    const toUomId = uoms.get(to)!.id;
    if (!(await m.existsBy(UnitConversion, { itemId: IsNull(), fromUomId, toUomId }))) {
      await m.save(m.create(UnitConversion, { itemId: null, fromUomId, toUomId, factor }));
    }
  }

  for (const c of DEFAULT_CATEGORIES) {
    if (await m.existsBy(ItemCategory, { code: c.code })) continue;
    const parent = c.parent ? await m.findOneBy(ItemCategory, { code: c.parent }) : null;
    await m.save(
      m.create(ItemCategory, { code: c.code, name: c.name, isDrug: c.isDrug, attributeSchema: c.attributeSchema, parentId: parent?.id ?? null }),
    );
  }
  const roleIds = new Map((await m.find(Role)).map((r) => [r.code, r.id]));
  for (const w of DEFAULT_WORKFLOWS) {
    if (await m.existsBy(ApprovalWorkflow, { code: w.code })) continue;
    const category = w.itemCategoryCode ? await m.findOneBy(ItemCategory, { code: w.itemCategoryCode }) : null;
    await m.save(
      m.create(ApprovalWorkflow, {
        code: w.code,
        name: w.name,
        documentType: w.documentType,
        minAmount: w.minAmount,
        maxAmount: w.maxAmount,
        itemCategoryId: category?.id ?? null,
        priority: w.priority ?? 0,
        steps: w.steps.map(([name, roleCode, approverType], i) =>
          m.create(ApprovalStep, { sequence: i + 1, name, approverType: approverType ?? ApproverType.ROLE, roleId: roleIds.get(roleCode)! }),
        ),
      }),
    );
  }

  for (const p of DEFAULT_PRICE_LISTS) {
    if (!(await m.existsBy(PriceList, { code: p.code }))) await m.save(m.create(PriceList, { ...p, isActive: true }));
  }
  for (const pm of DEFAULT_PAYMENT_MODES) {
    if (!(await m.existsBy(PaymentMode, { code: pm.code }))) await m.save(m.create(PaymentMode, { ...pm, isActive: true }));
  }
  for (const [kind, localKey, etimsCode] of DEFAULT_ETIMS_MAPPINGS) {
    if (!(await m.existsBy(EtimsCodeMapping, { kind, localKey }))) await m.save(m.create(EtimsCodeMapping, { kind, localKey, etimsCode }));
  }
  // Demonstration interaction set (source DEMO); never overwrites curated rows.
  for (const [a, b, severity, mechanism, management] of DEMO_INTERACTIONS) {
    const [innA, innB] = orderPair(a, b);
    if (!(await m.existsBy(DrugInteraction, { innA, innB }))) await m.save(m.create(DrugInteraction, { innA, innB, severity, mechanism, management, source: 'DEMO', isActive: true }));
  }

  log('reference data ready');
}

/** Creates sample users that do not exist yet (new ones arrive with later releases). */
async function seedSampleUsers(m: EntityManager, password: string): Promise<number> {
  const existing = new Set((await m.find(User)).map((u) => u.username));
  const missing = SAMPLE_USERS.filter((u) => !existing.has(u.username));
  if (!missing.length) return 0;
  const roles = new Map((await m.find(Role)).map((r) => [r.code, r]));
  const stores = new Map((await m.find(Store)).map((s) => [s.code, s]));
  const departments = new Map((await m.find(Department)).map((d) => [d.code, d]));
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  for (const u of missing) {
    await m.save(
      m.create(User, {
        username: u.username,
        fullName: u.fullName,
        email: `${u.username}@hospital.example`,
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        roles: [roles.get(u.role)!],
        stores: u.stores.map((c) => stores.get(c)!),
        departmentId: u.department ? departments.get(u.department)!.id : null,
      }),
    );
  }
  return missing.length;
}

async function seedSample(m: EntityManager, password: string, log: (msg: string) => void): Promise<void> {
  const facility = await m.save(m.create(Facility, SAMPLE_FACILITY));

  const stores = new Map<string, Store>();
  for (const s of SAMPLE_STORES) {
    const store = await m.save(
      m.create(Store, {
        facilityId: facility.id,
        code: s.code,
        name: s.name,
        type: s.type,
        servicePoint: s.servicePoint,
        parentStoreId: s.parent ? stores.get(s.parent)!.id : null,
      }),
    );
    stores.set(s.code, store);
    for (const code of s.bins) {
      await m.save(m.create(Bin, { storeId: store.id, code, name: `${s.name} ${code}`, zone: code.split('-')[0] }));
    }
  }

  const departments = new Map<string, Department>();
  for (const [code, name, costCentreCode] of SAMPLE_DEPARTMENTS) {
    departments.set(code, await m.save(m.create(Department, { facilityId: facility.id, code, name, costCentreCode })));
  }

  await seedSampleUsers(m, password);

  const uoms = new Map((await m.find(UnitOfMeasure)).map((u) => [u.code, u]));
  const categories = new Map((await m.find(ItemCategory)).map((c) => [c.code, c]));
  const taxes = new Map((await m.find(TaxCategory)).map((t) => [t.code, t]));
  const itemScheme = await m.findOneByOrFail(NumberingScheme, { documentType: DocumentType.ITEM, storeId: IsNull() });

  let seq = 0;
  const nextCode = () =>
    formatDocumentNumber(itemScheme.format, {
      prefix: itemScheme.prefix,
      storeCode: null,
      fyLabel: '',
      date: '2000-01-01',
      seq: ++seq,
      padding: itemScheme.padding,
    });

  let itemCount = 0;
  for (const sg of SAMPLE_GENERICS) {
    const generic = await m.save(
      m.create(Generic, {
        innName: sg.inn,
        strength: sg.strength,
        dosageForm: sg.form,
        route: sg.route,
        atcCode: sg.atc,
        therapeuticClass: sg.cls,
        isKeml: sg.keml,
        controlledSchedule: sg.schedule,
        storageRequirements: sg.storage ?? (sg.cold ? 'Store at 2–8°C' : 'Store below 30°C'),
        pregnancyNotes: sg.pregnancy ?? null,
        lactationNotes: sg.lactation ?? null,
      }),
    );
    for (const [brand, manufacturer, packSize, price] of sg.brands) {
      itemCount++;
      const item = await m.save(
        m.create(Item, {
          code: nextCode(),
          genericId: generic.id,
          categoryId: categories.get(sg.category)!.id,
          name: `${brand} ${sg.strength !== '—' ? sg.strength + ' ' : ''}${sg.form}`.trim(),
          brandName: brand,
          manufacturer,
          ppbRegNo: `PPB/SAMPLE/${String(itemCount).padStart(4, '0')}`,
          packSize,
          gtin: sampleGtin(itemCount),
          baseUomId: uoms.get(sg.uom)!.id,
          unitPrice: price,
          salesClass: sg.salesClass,
          taxCategoryId: taxes.get(sg.tax ?? 'EXEMPT')!.id,
          isFormulary: sg.keml,
          isBatchTracked: true,
          isColdChain: sg.cold ?? false,
          isControlled: !!sg.schedule,
        }),
      );
      // "10x10" = box of 10 strips of 10 → item-specific BOX→STRIP→base conversions.
      const pack = /^(\d+)x(\d+)$/.exec(packSize);
      if (pack && (sg.uom === 'TAB' || sg.uom === 'CAP')) {
        await m.save(m.create(UnitConversion, { itemId: item.id, fromUomId: uoms.get('BOX')!.id, toUomId: uoms.get('STRIP')!.id, factor: Number(pack[1]) }));
        await m.save(m.create(UnitConversion, { itemId: item.id, fromUomId: uoms.get('STRIP')!.id, toUomId: uoms.get(sg.uom)!.id, factor: Number(pack[2]) }));
      }
    }
  }

  for (const sup of SAMPLE_SUPPLIES) {
    itemCount++;
    await m.save(
      m.create(Item, {
        code: nextCode(),
        genericId: null,
        categoryId: categories.get(sup.category)!.id,
        name: sup.name,
        manufacturer: sup.manufacturer,
        packSize: sup.pack,
        gtin: sampleGtin(itemCount),
        baseUomId: uoms.get(sup.uom)!.id,
        unitPrice: sup.price,
        salesClass: null,
        taxCategoryId: taxes.get(sup.tax)!.id,
        isFormulary: true,
        isBatchTracked: sup.category === 'SUP-LAB' || sup.category === 'SUP-SUTURE',
        attributes: sup.attributes,
      }),
    );
  }

  // Keep the ITEM counter in step with the codes used above.
  await m.query(
    `INSERT INTO document_sequence (scheme_id, period, next_value) VALUES ($1, 'ALL', $2)
     ON CONFLICT (scheme_id, period) DO UPDATE SET next_value = GREATEST(document_sequence.next_value, EXCLUDED.next_value)`,
    [itemScheme.id, seq + 1],
  );

  log(`sample data: 1 facility, ${stores.size} stores, ${departments.size} departments, ${SAMPLE_USERS.length} users, ${SAMPLE_GENERICS.length} generics, ${itemCount} items`);
}
