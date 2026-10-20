import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  EtimsAdapterKind,
  EtimsOutboxKind,
  EtimsPurchaseStatus,
  EtimsStatus,
  EtimsSyncStatus,
  NotificationCategory,
  Permissions,
  SalesDocType,
  SessionUser,
} from '@sil/shared';
import { decryptField, encryptField } from '../../common/crypto';
import { loadEnv } from '../../config/env';
import { NotificationsService } from '../approvals/notifications.service';
import { SalesInvoice } from '../billing/billing.entities';
import { round2 } from '../billing/tax-calc';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { createAdapter, EtimsCallResult } from './etims-adapter';
import {
  Actor,
  buildItemPayload,
  buildPurchasePayload,
  buildSalePayload,
  buildStockIOPayload,
  buildStockMasterPayload,
  maskSecrets,
  SaleLine,
  StockLine,
} from './etims-payloads';
import { CODE_CLASSES, etimsDateTime, EtimsOperation, PRODUCT_TYPE, RESULT, SAR_TYPE } from './etims-spec';
import {
  EtimsCode,
  EtimsCodeMapping,
  EtimsConfig,
  EtimsImportItem,
  EtimsItem,
  EtimsItemClass,
  EtimsOutbox,
  EtimsPurchase,
  EtimsTransmission,
} from './etims.entities';

export const MAPPING_KINDS = ['TAX_CATEGORY', 'QTY_UNIT', 'PACKAGING_UNIT', 'ITEM_CLASS', 'COUNTRY'] as const;
export type MappingKind = (typeof MAPPING_KINDS)[number];

export interface ResolvedItemCodes {
  itemClsCd: string;
  pkgUnitCd: string;
  qtyUnitCd: string;
  taxTyCd: string;
  orgnNatCd: string;
}

interface ItemRow {
  id: string;
  code: string;
  name: string;
  barcode: string | null;
  gtin: string | null;
  unit_price: string;
  uom_code: string;
  tax_code: string;
  category_id: string;
  is_batch_tracked: boolean;
}

const SYSTEM_ACTOR: Actor = { id: 'system', name: 'System' };
const actorOf = (u: SessionUser | null | undefined): Actor => (u ? { id: u.username, name: u.fullName } : SYSTEM_ACTOR);

/**
 * KRA eTIMS integration: control-unit configuration, code tables and mapping,
 * item registration, the transactional outbox with retries, stock movement
 * reporting, supplier purchases and import items. Documents are written to the
 * outbox in their own transaction and sent by the `etims.dispatch` job (or
 * straight away, with a short wait, at sale time).
 */
@Injectable()
export class EtimsService implements OnModuleInit {
  private readonly log = new Logger('eTIMS');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.jobs.register('etims.dispatch', 'Send queued eTIMS documents (retries with back-off)', () => this.dispatch());
    this.jobs.register('etims.codes', 'Synchronise eTIMS code tables and item classes', () => this.syncCodes());
    this.jobs.register('etims.stock', 'Report stock movements and stock master to eTIMS', () => this.reportStock());
    this.jobs.register('etims.purchases', 'Fetch supplier sales (purchases) from eTIMS and match invoices', () => this.fetchPurchases());
    this.jobs.register('etims.monitor', 'Alert finance about documents not accepted in time', () => this.monitor());
  }

  // ------------------------------------------------------------------ configuration

  async configs() {
    return this.ds.getRepository(EtimsConfig).find({ relations: { store: true }, order: { createdAt: 'ASC' } });
  }

  async configForStore(m: EntityManager, storeId: string): Promise<EtimsConfig | null> {
    return m.findOne(EtimsConfig, { where: { storeId, isActive: true } });
  }

  async saveConfig(dto: { storeId: string; adapter: EtimsAdapterKind; baseUrl?: string | null; kraPin: string; branchId: string; deviceSerial: string; isActive?: boolean }) {
    const repo = this.ds.getRepository(EtimsConfig);
    const existing = await repo.findOneBy({ storeId: dto.storeId });
    // KRA issues one control unit per PIN + branch, with one invoice sequence: two outlets cannot share it.
    const clash = await repo.findOne({ where: { kraPin: dto.kraPin, branchId: dto.branchId, isActive: true }, relations: { store: true } });
    if (clash && clash.storeId !== dto.storeId && (dto.isActive ?? true)) {
      throw new ConflictException(`KRA branch ${dto.branchId} of ${dto.kraPin} is already used by ${clash.store?.name ?? 'another outlet'}: register each selling outlet as its own eTIMS branch`);
    }
    if (existing) {
      const deviceChanged = existing.kraPin !== dto.kraPin || existing.branchId !== dto.branchId || existing.deviceSerial !== dto.deviceSerial || existing.adapter !== dto.adapter;
      Object.assign(existing, { ...dto, baseUrl: dto.baseUrl ?? null });
      if (deviceChanged) Object.assign(existing, { initialisedAt: null, cuId: null, mrcNo: null, cmcKeyEnc: null });
      return repo.save(existing);
    }
    // Go-live: movements are reported from now on (earlier history is not replayed to KRA).
    const [{ last }] = await this.ds.query(`SELECT COALESCE(max(id), 0)::text AS last FROM stock_transaction WHERE store_id = $1`, [dto.storeId]);
    return repo.save(repo.create({ ...dto, baseUrl: dto.baseUrl ?? null, isActive: dto.isActive ?? true, lastStockTxnId: Number(last) }));
  }

  private async withKey(m: EntityManager, configId: string): Promise<EtimsConfig> {
    const c = await m.getRepository(EtimsConfig).createQueryBuilder('c').addSelect('c.cmcKeyEnc').where('c.id = :id', { id: configId }).getOne();
    if (!c) throw new NotFoundException('eTIMS configuration not found');
    return c;
  }

  /** One call to the control unit, logged with credentials masked. */
  async transmit(m: EntityManager, config: EtimsConfig, op: EtimsOperation, body: Record<string, unknown>, outboxId: string | null, timeoutMs?: number): Promise<EtimsCallResult> {
    const adapter = createAdapter(config.adapter, config.baseUrl);
    const cmcKey = config.cmcKeyEnc ? decryptField(loadEnv().dataEncryptionKey, config.cmcKeyEnc) : null;
    const timeout = timeoutMs ?? (await this.settings.get('etims.requestTimeoutMs', m));
    const res = await adapter.call(op, body, { tin: config.kraPin, bhfId: config.branchId, cmcKey }, timeout);
    await m.save(EtimsTransmission, {
      outboxId,
      configId: config.id,
      operation: op,
      url: res.url,
      request: maskSecrets({ tin: config.kraPin, bhfId: config.branchId, cmcKey: cmcKey ? '***' : null, ...body }),
      response: res.raw ? maskSecrets(res.raw) : null,
      httpStatus: res.httpStatus,
      resultCd: res.resultCd,
      error: res.error ?? (res.ok ? null : res.resultMsg),
      durationMs: res.durationMs,
    });
    return res;
  }

  /** Device initialisation (selectInitOsdcInfo): stores the communication key, CU id and MRC number. */
  async initialise(configId: string) {
    return this.ds.transaction(async (m) => {
      const c = await this.withKey(m, configId);
      const res = await this.transmit(m, c, 'init', { dvcSrlNo: c.deviceSerial }, null);
      if (!res.ok) throw new BadRequestException({ code: 'ETIMS_ERROR', message: `eTIMS initialisation failed: ${res.resultCd ?? ''} ${res.resultMsg ?? res.error ?? ''}`.trim() });
      const info = (res.data?.info ?? {}) as Record<string, string>;
      c.cmcKeyEnc = info.cmcKey ? encryptField(loadEnv().dataEncryptionKey, info.cmcKey) : c.cmcKeyEnc;
      c.cuId = info.sdcId ?? c.cuId;
      c.mrcNo = info.mrcNo ?? c.mrcNo;
      c.initialisedAt = new Date();
      await m.save(c);
      const { cmcKeyEnc: _hidden, ...safe } = c;
      return { ...safe, taxpayer: info.taxprNm ?? null, branch: info.bhfNm ?? null };
    });
  }

  private async activeConfigs(m: EntityManager = this.ds.manager) {
    const rows = await m.find(EtimsConfig, { where: { isActive: true } });
    return rows.filter((c) => c.initialisedAt);
  }

  // ------------------------------------------------------------------ code tables and mapping

  async syncCodes(): Promise<{ configs: number; codes: number; itemClasses: number }> {
    let codes = 0;
    let itemClasses = 0;
    const configs = await this.activeConfigs();
    // Code tables are national: one initialised device is enough.
    const c = configs[0];
    if (c) {
      await this.ds.transaction(async (m) => {
        const cfg = await this.withKey(m, c.id);
        const now = etimsDateTime(new Date(), await this.settings.get('locale.timezone', m));
        const r1 = await this.transmit(m, cfg, 'codes', { lastReqDt: cfg.lastRequest.codes ?? '20180101000000' }, null);
        if (r1.ok) {
          for (const cls of (r1.data?.clsList as Record<string, unknown>[]) ?? []) {
            for (const d of (cls.dtlList as Record<string, unknown>[]) ?? []) {
              await m.query(
                `INSERT INTO etims_code (cd_cls, cd, cd_nm, cd_cls_nm, user_dfn_cd1, use_yn, synced_at) VALUES ($1, $2, $3, $4, $5, $6, now())
                 ON CONFLICT (cd_cls, cd) DO UPDATE SET cd_nm = EXCLUDED.cd_nm, cd_cls_nm = EXCLUDED.cd_cls_nm, user_dfn_cd1 = EXCLUDED.user_dfn_cd1, use_yn = EXCLUDED.use_yn, synced_at = now()`,
                [cls.cdCls, d.cd, d.cdNm, cls.cdClsNm, d.userDfnCd1 ?? null, d.useYn !== 'N'],
              );
              codes++;
            }
          }
          cfg.lastRequest = { ...cfg.lastRequest, codes: now };
        }
        const r2 = await this.transmit(m, cfg, 'itemClasses', { lastReqDt: cfg.lastRequest.itemClasses ?? '20180101000000' }, null);
        if (r2.ok) {
          for (const ic of (r2.data?.itemClsList as Record<string, unknown>[]) ?? []) {
            await m.query(
              `INSERT INTO etims_item_class (item_cls_cd, item_cls_nm, item_cls_lvl, tax_ty_cd, use_yn, synced_at) VALUES ($1, $2, $3, $4, $5, now())
               ON CONFLICT (item_cls_cd) DO UPDATE SET item_cls_nm = EXCLUDED.item_cls_nm, item_cls_lvl = EXCLUDED.item_cls_lvl, tax_ty_cd = EXCLUDED.tax_ty_cd, use_yn = EXCLUDED.use_yn, synced_at = now()`,
              [ic.itemClsCd, ic.itemClsNm, ic.itemClsLvl ?? null, ic.taxTyCd ?? null, ic.useYn !== 'N'],
            );
            itemClasses++;
          }
          cfg.lastRequest = { ...cfg.lastRequest, itemClasses: now };
        }
        await m.save(cfg);
      });
    }
    return { configs: configs.length, codes, itemClasses };
  }

  async codes(cdCls?: string) {
    return this.ds.getRepository(EtimsCode).find({ where: cdCls ? { cdCls } : {}, order: { cdCls: 'ASC', cd: 'ASC' }, take: 2000 });
  }

  async itemClasses(q?: string) {
    const qb = this.ds.getRepository(EtimsItemClass).createQueryBuilder('c').orderBy('c.itemClsCd').take(200);
    if (q) qb.where('(c.item_cls_cd ILIKE :q OR c.item_cls_nm ILIKE :q)', { q: `%${q}%` });
    return qb.getMany();
  }

  async mappings() {
    return this.ds.getRepository(EtimsCodeMapping).find({ order: { kind: 'ASC', localKey: 'ASC' } });
  }

  async setMapping(kind: MappingKind, localKey: string, etimsCode: string) {
    if (!MAPPING_KINDS.includes(kind)) throw new BadRequestException('Unknown mapping kind');
    const cls = { TAX_CATEGORY: CODE_CLASSES.TAX_TYPE, QTY_UNIT: CODE_CLASSES.QTY_UNIT, PACKAGING_UNIT: CODE_CLASSES.PACKAGING_UNIT, COUNTRY: CODE_CLASSES.COUNTRY } as Record<string, string>;
    if (kind === 'ITEM_CLASS') {
      const n = await this.ds.getRepository(EtimsItemClass).count();
      if (n && !(await this.ds.getRepository(EtimsItemClass).existsBy({ itemClsCd: etimsCode }))) throw new BadRequestException(`Item class ${etimsCode} is not in the eTIMS classification`);
    } else if (cls[kind]) {
      const n = await this.ds.getRepository(EtimsCode).countBy({ cdCls: cls[kind] });
      if (n && !(await this.ds.getRepository(EtimsCode).existsBy({ cdCls: cls[kind], cd: etimsCode }))) throw new BadRequestException(`${etimsCode} is not an eTIMS code of class ${cls[kind]}`);
    }
    const repo = this.ds.getRepository(EtimsCodeMapping);
    const row = (await repo.findOneBy({ kind, localKey })) ?? repo.create({ kind, localKey });
    row.etimsCode = etimsCode;
    return repo.save(row);
  }

  private async loadItems(m: EntityManager, itemIds: string[]): Promise<Map<string, ItemRow>> {
    const rows: ItemRow[] = await m.query(
      `SELECT i.id, i.code, i.name, i.barcode, i.gtin, i.unit_price, u.code AS uom_code, t.code AS tax_code, i.category_id, i.is_batch_tracked
         FROM item i JOIN unit_of_measure u ON u.id = i.base_uom_id JOIN tax_category t ON t.id = i.tax_category_id
        WHERE i.id = ANY($1::uuid[])`,
      [itemIds],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** eTIMS codes for an item from the mapping tables; lists what is missing. */
  async resolveItem(m: EntityManager, item: ItemRow): Promise<{ codes: ResolvedItemCodes | null; missing: string[] }> {
    const maps = await m.find(EtimsCodeMapping);
    const get = (kind: string, key: string) => maps.find((x) => x.kind === kind && x.localKey === key)?.etimsCode;
    // Item class: the item itself, else its category or the nearest parent category.
    let itemClsCd = get('ITEM_CLASS', `item:${item.code}`);
    if (!itemClsCd) {
      const chain: { code: string }[] = await m.query(
        `WITH RECURSIVE up AS (SELECT id, code, parent_id, 0 AS d FROM item_category WHERE id = $1
           UNION ALL SELECT c.id, c.code, c.parent_id, up.d + 1 FROM item_category c JOIN up ON c.id = up.parent_id)
         SELECT code FROM up ORDER BY d`,
        [item.category_id],
      );
      for (const c of chain) {
        itemClsCd = get('ITEM_CLASS', `category:${c.code}`);
        if (itemClsCd) break;
      }
    }
    const taxTyCd = get('TAX_CATEGORY', item.tax_code);
    const qtyUnitCd = get('QTY_UNIT', item.uom_code);
    const pkgUnitCd = get('PACKAGING_UNIT', item.uom_code) ?? (await this.settings.get('etims.defaultPackagingUnit', m));
    const orgnNatCd = get('COUNTRY', `item:${item.code}`) ?? (await this.settings.get('etims.defaultOriginCountry', m));
    const missing = [
      !itemClsCd && 'item classification (map the item or its category)',
      !taxTyCd && `tax type for tax category ${item.tax_code}`,
      !qtyUnitCd && `quantity unit for ${item.uom_code}`,
    ].filter(Boolean) as string[];
    return { codes: missing.length ? null : { itemClsCd: itemClsCd!, pkgUnitCd, qtyUnitCd: qtyUnitCd!, taxTyCd: taxTyCd!, orgnNatCd }, missing };
  }

  /** Refuses to invoice items that cannot be reported to eTIMS. */
  async assertInvoiceable(m: EntityManager, storeId: string, itemIds: string[]): Promise<void> {
    const config = await this.configForStore(m, storeId);
    if (!config) return;
    const items = await this.loadItems(m, itemIds);
    const problems: string[] = [];
    for (const it of items.values()) {
      const { missing } = await this.resolveItem(m, it);
      if (missing.length) problems.push(`${it.code} ${it.name}: no eTIMS ${missing.join(', ')}`);
    }
    if (problems.length) throw new BadRequestException({ code: 'ETIMS_MAPPING_MISSING', message: `Cannot invoice: ${problems.join('; ')}`, problems });
  }

  /**
   * Makes sure the item is registered with the control unit; queues saveItem
   * if needed. Returns the registration and, while it is not yet accepted, the
   * outbox id later documents must wait for.
   */
  async ensureItem(m: EntityManager, config: EtimsConfig, itemId: string, actor: Actor): Promise<{ item: EtimsItem; pendingOutboxId: string | null }> {
    const existing = await m.findOneBy(EtimsItem, { configId: config.id, itemId });
    const pendingOf = async (e: EtimsItem) => {
      if (e.status === EtimsSyncStatus.ACCEPTED) return null;
      const ob = await m.findOneBy(EtimsOutbox, { idempotencyKey: `ITEM|${config.id}|${itemId}` });
      return ob?.id ?? null;
    };
    if (existing) return { item: existing, pendingOutboxId: await pendingOf(existing) };
    const items = await this.loadItems(m, [itemId]);
    const it = items.get(itemId);
    if (!it) throw new NotFoundException('Item not found');
    const { codes, missing } = await this.resolveItem(m, it);
    if (!codes) throw new BadRequestException({ code: 'ETIMS_MAPPING_MISSING', message: `${it.code} ${it.name}: no eTIMS ${missing.join(', ')}` });
    // itemCd (spec 4.19): country + product type + packaging unit + quantity unit + 7-digit sequence.
    const seq = await this.nextNo(m, config.id, 'next_item_seq');
    const itemCd = `${codes.orgnNatCd}${PRODUCT_TYPE.FINISHED}${codes.pkgUnitCd}${codes.qtyUnitCd}${String(seq).padStart(7, '0')}`.slice(0, 20);
    const reg = await m.save(m.create(EtimsItem, { configId: config.id, itemId, itemCd, itemClsCd: codes.itemClsCd, pkgUnitCd: codes.pkgUnitCd, qtyUnitCd: codes.qtyUnitCd, taxTyCd: codes.taxTyCd, status: EtimsSyncStatus.PENDING }));
    const rate = await this.rateForType(m, codes.taxTyCd);
    const ob = await this.enqueue(m, {
      config,
      kind: EtimsOutboxKind.ITEM,
      key: `ITEM|${config.id}|${itemId}`,
      docType: 'ITEM',
      docId: itemId,
      docNo: it.code,
      payload: buildItemPayload({
        itemCd,
        itemClsCd: codes.itemClsCd,
        itemTyCd: PRODUCT_TYPE.FINISHED,
        itemNm: it.name,
        orgnNatCd: codes.orgnNatCd,
        pkgUnitCd: codes.pkgUnitCd,
        qtyUnitCd: codes.qtyUnitCd,
        taxTyCd: codes.taxTyCd,
        bcd: it.gtin ?? it.barcode,
        dftPrc: Number(it.unit_price) * (1 + rate / 100),
        insuranceApplicable: true,
        actor,
      }),
    });
    return { item: reg, pendingOutboxId: ob.id };
  }

  /** Allocates the next value of a per-device counter (row-locked by the UPDATE). */
  private async nextNo(m: EntityManager, configId: string, column: 'next_invoice_no' | 'next_sar_no' | 'next_item_seq' | 'next_purchase_no'): Promise<number> {
    const res = await m.query(`UPDATE etims_config SET ${column} = ${column} + 1 WHERE id = $1 RETURNING ${column} - 1 AS v`, [configId]);
    // TypeORM returns [rows, affected] for UPDATE statements.
    const rows = Array.isArray(res[0]) ? res[0] : res;
    const v = Number(rows[0]?.v);
    if (!Number.isFinite(v)) throw new Error(`Could not allocate ${column}`);
    return v;
  }

  /** Rate for an eTIMS tax type from the synced code table (userDfnCd1), else the defaults in settings. */
  private async rateForType(m: EntityManager, taxTyCd: string): Promise<number> {
    const [c] = await m.query(`SELECT user_dfn_cd1 FROM etims_code WHERE cd_cls = $1 AND cd = $2`, [CODE_CLASSES.TAX_TYPE, taxTyCd]);
    if (c?.user_dfn_cd1 && !Number.isNaN(Number(c.user_dfn_cd1))) return Number(c.user_dfn_cd1);
    return (await this.settings.get('etims.taxTypeRates', m))[taxTyCd] ?? 0;
  }

  // ------------------------------------------------------------------ outbox

  private async enqueue(m: EntityManager, e: { config: EtimsConfig; kind: EtimsOutboxKind; key: string; docType: string; docId: string | null; docNo: string | null; payload: Record<string, unknown>; dependsOn?: string[] }): Promise<EtimsOutbox> {
    const existing = await m.findOneBy(EtimsOutbox, { idempotencyKey: e.key });
    if (existing) return existing;
    return m.save(
      m.create(EtimsOutbox, {
        configId: e.config.id,
        kind: e.kind,
        idempotencyKey: e.key,
        docType: e.docType,
        docId: e.docId,
        docNo: e.docNo,
        payload: e.payload,
        dependsOn: (e.dependsOn ?? []).filter(Boolean),
        status: EtimsSyncStatus.PENDING,
      }),
    );
  }

  /**
   * Queues a sales invoice or credit note, in the caller's (invoice) transaction.
   * Allocates the control unit's next invcNo. Without an eTIMS configuration for
   * the outlet the document is marked NOT_REQUIRED.
   */
  async queueSale(m: EntityManager, invoiceId: string, actor: SessionUser | null): Promise<EtimsOutbox | null> {
    const inv = await m.findOneOrFail(SalesInvoice, { where: { id: invoiceId }, relations: { lines: true, payments: true, payer: true } });
    const config = await this.configForStore(m, inv.storeId);
    if (!config) {
      await m.update(SalesInvoice, inv.id, { etimsStatus: EtimsSyncStatus.NOT_REQUIRED });
      return null;
    }
    let orgInvcNo = 0;
    if (inv.docType === SalesDocType.CREDIT_NOTE) {
      const orig = await m.findOneByOrFail(SalesInvoice, { id: inv.originalInvoiceId! });
      if (!orig.etimsInvoiceNo) throw new ConflictException('The original invoice was never sent to eTIMS');
      orgInvcNo = orig.etimsInvoiceNo;
    }
    const invcNo = await this.nextNo(m, config.id, 'next_invoice_no');
    const who = actorOf(actor);
    const lines: SaleLine[] = [];
    const deps: string[] = [];
    const rates: Record<string, number> = {};
    const items = await this.loadItems(m, (inv.lines ?? []).map((l) => l.itemId));
    for (const l of [...(inv.lines ?? [])].sort((a, b) => a.lineNo - b.lineNo)) {
      const { item, pendingOutboxId } = await this.ensureItem(m, config, l.itemId, who);
      if (pendingOutboxId) deps.push(pendingOutboxId);
      rates[l.taxTypeCode] = l.taxRatePercent;
      const it = items.get(l.itemId)!;
      lines.push({
        itemCd: item.itemCd,
        itemClsCd: item.itemClsCd,
        itemNm: l.description,
        bcd: it.gtin ?? it.barcode,
        pkgUnitCd: item.pkgUnitCd,
        qtyUnitCd: item.qtyUnitCd,
        qty: l.quantity,
        prc: l.unitPrice,
        splyAmt: round2(l.quantity * l.unitPrice),
        dcRt: l.discountPercent,
        dcAmt: l.discountAmount,
        taxTyCd: item.taxTyCd,
        taxblAmt: l.grossAmount,
        taxAmt: l.taxAmount,
        totAmt: l.grossAmount,
        isrccCd: inv.payer?.etimsInsuranceCode ?? null,
        isrccNm: inv.payer?.etimsInsuranceCode ? inv.payer.name.slice(0, 100) : null,
        isrcRt: inv.payer && inv.totalAmount ? Math.round((100 * inv.payerAmount) / inv.totalAmount) : null,
        isrcAmt: inv.payer ? l.payerShare : null,
      });
    }
    const primary = [...(inv.payments ?? [])].sort((a, b) => b.amount - a.amount)[0];
    const payload = buildSalePayload({
      trdInvcNo: inv.number,
      invcNo,
      orgInvcNo,
      isCreditNote: inv.docType === SalesDocType.CREDIT_NOTE,
      creditReasonCode: inv.creditReasonCode,
      custTin: inv.customerPin,
      custNm: inv.customerName?.slice(0, 60) ?? null,
      custMblNo: inv.customerPhone,
      pmtTyCd: primary?.etimsPaymentTypeCode ?? (await this.settings.get('etims.defaultPaymentType', m)),
      issuedAt: inv.issuedAt,
      rates: { ...(await this.settings.get('etims.taxTypeRates', m)), ...rates },
      lines,
      remark: inv.notes,
      timeZone: await this.settings.get('locale.timezone', m),
      actor: who,
    });
    const ob = await this.enqueue(m, { config, kind: EtimsOutboxKind.SALE, key: `SALE|${inv.id}`, docType: inv.docType, docId: inv.id, docNo: inv.number, payload, dependsOn: deps });
    await m.update(SalesInvoice, inv.id, { etimsInvoiceNo: invcNo, etimsStatus: EtimsSyncStatus.PENDING, cuId: config.cuId });
    return ob;
  }

  /** Sends due outbox entries (job etims.dispatch). */
  async dispatch(limit = 50): Promise<{ sent: number; accepted: number; failed: number; waiting: number }> {
    const due: { id: string }[] = await this.ds.query(
      `SELECT id FROM etims_outbox WHERE status = 'PENDING' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1`,
      [limit],
    );
    const totals = { sent: 0, accepted: 0, failed: 0, waiting: 0 };
    for (const d of due) {
      const r = await this.sendOne(d.id);
      if (r === 'ACCEPTED') totals.accepted++;
      else if (r === 'FAILED') totals.failed++;
      else if (r === 'WAITING') totals.waiting++;
      if (r !== 'WAITING' && r !== 'SKIPPED') totals.sent++;
    }
    return totals;
  }

  /**
   * Sends one outbox entry inside a transaction that locks it (SKIP LOCKED: a
   * concurrent dispatcher leaves it alone), after its dependencies. Never sends
   * an accepted entry twice.
   */
  async sendOne(outboxId: string, timeoutMs?: number): Promise<'ACCEPTED' | 'FAILED' | 'RETRY' | 'WAITING' | 'SKIPPED'> {
    return this.ds.transaction(async (m) => {
      const [row] = await m.query(`SELECT id FROM etims_outbox WHERE id = $1 AND status = 'PENDING' FOR UPDATE SKIP LOCKED`, [outboxId]);
      if (!row) return 'SKIPPED';
      const ob = await m.findOneByOrFail(EtimsOutbox, { id: outboxId });
      if (ob.dependsOn.length) {
        const deps = await m.find(EtimsOutbox, { where: { id: In(ob.dependsOn) } });
        const open = deps.filter((x) => x.status !== EtimsSyncStatus.ACCEPTED);
        if (open.length) {
          ob.resultMsg = `Waiting for ${open.map((x) => `${x.kind} ${x.docNo ?? ''}`.trim()).join(', ')}${open.some((x) => x.status === EtimsSyncStatus.FAILED) ? ' (failed — reprocess it first)' : ''}`;
          ob.nextAttemptAt = new Date(Date.now() + 15_000);
          await m.save(ob);
          return 'WAITING';
        }
      }
      const config = await this.withKey(m, ob.configId);
      const op: EtimsOperation = { ITEM: 'saveItem', SALE: 'saveSale', STOCK_IO: 'stockIO', STOCK_MASTER: 'stockMaster', PURCHASE: 'savePurchase', IMPORT_ITEM: 'updateImport' }[ob.kind] as EtimsOperation;
      const res = await this.transmit(m, config, op, ob.payload, ob.id, timeoutMs);
      ob.attempts++;
      ob.resultCd = res.resultCd;
      ob.resultMsg = (res.resultMsg ?? res.error)?.slice(0, 1000) ?? null;
      ob.response = res.raw;
      const duplicateWithData = res.resultCd === RESULT.DUPLICATE && !!res.data;
      if (res.ok || duplicateWithData) {
        ob.status = EtimsSyncStatus.ACCEPTED;
        ob.acceptedAt = new Date();
        await m.save(ob);
        await this.applyAccepted(m, ob, config, res.data);
        return 'ACCEPTED';
      }
      const maxAttempts = await this.settings.get('etims.maxAttempts', m);
      if (res.retryable && ob.attempts < maxAttempts) {
        const base = await this.settings.get('etims.retryBaseSeconds', m);
        ob.nextAttemptAt = new Date(Date.now() + Math.min(base * 2 ** (ob.attempts - 1), 3600) * 1000);
        await m.save(ob);
        await this.applyFailure(m, ob, false);
        return 'RETRY';
      }
      ob.status = EtimsSyncStatus.FAILED;
      await m.save(ob);
      await this.applyFailure(m, ob, true);
      return 'FAILED';
    });
  }

  private async applyAccepted(m: EntityManager, ob: EtimsOutbox, config: EtimsConfig, data: Record<string, unknown> | null) {
    if (ob.kind === EtimsOutboxKind.SALE && ob.docId) {
      const rcptNo = Number(data?.curRcptNo ?? 0) || null;
      await m.update(SalesInvoice, ob.docId, {
        etimsStatus: EtimsSyncStatus.ACCEPTED,
        rcptNo,
        totRcptNo: Number(data?.totRcptNo ?? 0) || null,
        intrlData: (data?.intrlData as string) ?? null,
        rcptSign: (data?.rcptSign as string) ?? null,
        sdcDateTime: (data?.sdcDateTime as string) ?? null,
        cuId: config.cuId,
        cuInvoiceNo: config.cuId && rcptNo ? `${config.cuId}/${rcptNo}` : null,
        etimsError: null,
        etimsAcceptedAt: new Date(),
      });
    } else if (ob.kind === EtimsOutboxKind.ITEM && ob.docId) {
      await m.update(EtimsItem, { configId: ob.configId, itemId: ob.docId }, { status: EtimsSyncStatus.ACCEPTED });
    } else if (ob.kind === EtimsOutboxKind.PURCHASE && ob.docId) {
      const p = await m.findOneByOrFail(EtimsPurchase, { id: ob.docId });
      p.status = (ob.payload.pchsSttsCd as string) === '02' ? EtimsPurchaseStatus.CONFIRMED : EtimsPurchaseStatus.REJECTED;
      await m.save(p);
    } else if (ob.kind === EtimsOutboxKind.IMPORT_ITEM && ob.docId) {
      await m.update(EtimsImportItem, ob.docId, { imptItemSttsCd: String(ob.payload.imptItemSttsCd) });
    }
  }

  private async applyFailure(m: EntityManager, ob: EtimsOutbox, final: boolean) {
    if (ob.kind === EtimsOutboxKind.SALE && ob.docId) {
      await m.update(SalesInvoice, ob.docId, {
        etimsStatus: final ? EtimsSyncStatus.FAILED : EtimsSyncStatus.PENDING,
        etimsError: `${ob.resultCd ?? ''} ${ob.resultMsg ?? ''}`.trim().slice(0, 1000) || null,
      });
    } else if (ob.kind === EtimsOutboxKind.ITEM && ob.docId && final) {
      await m.update(EtimsItem, { configId: ob.configId, itemId: ob.docId }, { status: EtimsSyncStatus.FAILED });
    }
  }

  /** At sale time: try to get the invoice accepted within etims.syncWaitMs; otherwise it stays queued. */
  async trySendNow(outboxId: string): Promise<void> {
    const wait = await this.settings.get('etims.syncWaitMs');
    const started = Date.now();
    const ob = await this.ds.getRepository(EtimsOutbox).findOneBy({ id: outboxId });
    if (!ob) return;
    for (const dep of ob.dependsOn) {
      const left = wait - (Date.now() - started);
      if (left <= 200) break;
      await this.sendOne(dep, left).catch((e) => this.log.warn(`eTIMS dependency send failed: ${(e as Error).message}`));
    }
    const left = wait - (Date.now() - started);
    if (left > 200) await this.sendOne(outboxId, left).catch((e) => this.log.warn(`eTIMS send failed: ${(e as Error).message}`));
    // Whatever is still pending goes to the worker.
    await this.jobs.enqueue('etims.dispatch', {}, { trigger: 'event', dedupeKey: 'now' }).catch(() => undefined);
  }

  /** Puts a failed (or stuck) entry back in the queue, rebuilding sales from current mappings. */
  async reprocess(outboxId: string, actor: SessionUser) {
    await this.ds.transaction(async (m) => {
      const ob = await m.findOne(EtimsOutbox, { where: { id: outboxId }, lock: { mode: 'pessimistic_write' } });
      if (!ob) throw new NotFoundException('Outbox entry not found');
      if (ob.status === EtimsSyncStatus.ACCEPTED) throw new ConflictException('Already accepted by eTIMS');
      if (ob.kind === EtimsOutboxKind.ITEM && ob.docId) {
        // Mapping may have been corrected: re-resolve the codes.
        const config = await m.findOneByOrFail(EtimsConfig, { id: ob.configId });
        const items = await this.loadItems(m, [ob.docId]);
        const { codes, missing } = await this.resolveItem(m, items.get(ob.docId)!);
        if (!codes) throw new BadRequestException(`Still missing: ${missing.join(', ')}`);
        const reg = await m.findOneByOrFail(EtimsItem, { configId: config.id, itemId: ob.docId });
        Object.assign(reg, { itemClsCd: codes.itemClsCd, taxTyCd: codes.taxTyCd, status: EtimsSyncStatus.PENDING });
        await m.save(reg);
        ob.payload = { ...ob.payload, itemClsCd: codes.itemClsCd, taxTyCd: codes.taxTyCd, modrId: actor.username, modrNm: actor.fullName };
      }
      ob.status = EtimsSyncStatus.PENDING;
      ob.attempts = 0;
      ob.nextAttemptAt = new Date();
      ob.alertedAt = null;
      await m.save(ob);
      if (ob.kind === EtimsOutboxKind.SALE && ob.docId) await m.update(SalesInvoice, ob.docId, { etimsStatus: EtimsSyncStatus.PENDING });
    });
    await this.sendOne(outboxId);
    return this.ds.getRepository(EtimsOutbox).findOneByOrFail({ id: outboxId });
  }

  /** Finance alert for documents not accepted within etims.alertAfterMinutes (once per entry). */
  async monitor(): Promise<{ overdue: number; alerted: number }> {
    const minutes = await this.settings.get('etims.alertAfterMinutes');
    const overdue: { id: string; kind: string; doc_no: string | null; status: string; result_msg: string | null }[] = await this.ds.query(
      `SELECT id, kind, doc_no, status, result_msg FROM etims_outbox
        WHERE status <> 'ACCEPTED' AND alerted_at IS NULL AND created_at < now() - ($1 || ' minutes')::interval
        ORDER BY created_at LIMIT 200`,
      [String(minutes)],
    );
    if (!overdue.length) return { overdue: 0, alerted: 0 };
    const users: { id: string }[] = await this.ds.query(
      `SELECT DISTINCT ur.user_id AS id FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = $1
         JOIN app_user u ON u.id = ur.user_id AND u.is_active`,
      [Permissions.ETIMS_MANAGE],
    );
    const lines = overdue.map((o) => `• ${o.kind} ${o.doc_no ?? ''} — ${o.status}${o.result_msg ? `: ${o.result_msg}` : ''}`);
    const reached = await this.notifications.dispatch(this.ds.manager, users.map((u) => u.id), NotificationCategory.ETIMS, {
      title: `eTIMS: ${overdue.length} document(s) not accepted after ${minutes} minutes`,
      body: lines.slice(0, 5).join('\n'),
      link: '/etims/outbox',
      emailText: `These documents have not been accepted by KRA eTIMS:\n\n${lines.join('\n')}`,
    });
    await this.ds.query(`UPDATE etims_outbox SET alerted_at = now() WHERE id = ANY($1::uuid[])`, [overdue.map((o) => o.id)]);
    return { overdue: overdue.length, alerted: reached };
  }

  // ------------------------------------------------------------------ stock movements

  /** sarTyCd for a ledger row (see ETIMS_ASSUMPTIONS). */
  private sarType(txnType: string, qty: number, reasonCode: string | null, disposalCode: string): string | null {
    if (qty === 0) return null;
    const IN = qty > 0;
    switch (txnType) {
      case 'RECEIPT':
        return IN ? SAR_TYPE.IN_PURCHASE : SAR_TYPE.OUT_ADJUSTMENT;
      case 'OPENING':
        return SAR_TYPE.IN_ADJUSTMENT;
      case 'TRANSFER_RECEIPT':
        return SAR_TYPE.IN_STOCK_MOVEMENT;
      case 'TRANSFER_DISPATCH':
        return IN ? null : SAR_TYPE.OUT_STOCK_MOVEMENT;
      case 'RETURN_IN':
      case 'DISPENSE_RETURN':
        return SAR_TYPE.IN_RETURN;
      case 'DISPENSE':
        return SAR_TYPE.OUT_SALE;
      case 'SUPPLIER_RETURN':
        return SAR_TYPE.OUT_RETURN;
      case 'ISSUE':
        return SAR_TYPE.OUT_ADJUSTMENT;
      case 'ADJUSTMENT':
      case 'STOCK_TAKE':
        return IN ? SAR_TYPE.IN_ADJUSTMENT : reasonCode === disposalCode ? SAR_TYPE.OUT_DISCARDING : SAR_TYPE.OUT_ADJUSTMENT;
      default:
        return null;
    }
  }

  /**
   * Reports new ledger rows of each eTIMS outlet as stock in/out (one per
   * document and direction) followed by the stock master of each item.
   * Stops (and records why) at a movement it cannot report yet: a dispense
   * whose sale is not accepted, or an item without eTIMS mapping.
   */
  async reportStock(): Promise<{ configs: number; movements: number; masters: number; paused: string[] }> {
    if (!(await this.settings.get('etims.stockReporting'))) return { configs: 0, movements: 0, masters: 0, paused: [] };
    const disposal = await this.settings.get('stock.disposalReasonCode');
    let movements = 0;
    let masters = 0;
    const paused: string[] = [];
    const configs = await this.activeConfigs();
    for (const c of configs) {
      await this.ds.transaction(async (m) => {
        const config = await m.findOne(EtimsConfig, { where: { id: c.id }, lock: { mode: 'pessimistic_write' } });
        if (!config) return;
        const rows: { id: string; txn_type: string; item_id: string; quantity: number; unit_cost: number; source_doc_type: string; source_doc_id: string | null; source_doc_no: string | null; reason_code: string | null; effective_date: string; expiry: string | null }[] =
          await m.query(
            `SELECT t.id, t.txn_type, t.item_id, t.quantity::float AS quantity, t.unit_cost::float AS unit_cost, t.source_doc_type, t.source_doc_id, t.source_doc_no,
                    t.reason_code, to_char(t.effective_date, 'YYYYMMDD') AS effective_date, to_char(b.expiry_date, 'YYYYMMDD') AS expiry
               FROM stock_transaction t JOIN batch b ON b.id = t.batch_id
              WHERE t.store_id = $1 AND t.id > $2 ORDER BY t.id LIMIT 2000`,
            [config.storeId, config.lastStockTxnId],
          );
        // Group consecutive rows of the same document and direction.
        const groups: { key: string; rows: typeof rows; sar: string }[] = [];
        for (const r of rows) {
          const sar = this.sarType(r.txn_type, r.quantity, r.reason_code, disposal);
          const key = `${r.source_doc_type}|${r.source_doc_id ?? r.source_doc_no}|${sar}`;
          const last = groups.at(-1);
          if (last && last.key === key) last.rows.push(r);
          else groups.push({ key, rows: [r], sar: sar ?? '' });
        }
        let watermark = Number(config.lastStockTxnId);
        let stop: string | null = null;
        for (const g of groups) {
          const lastId = Number(g.rows.at(-1)!.id);
          if (!g.sar) {
            watermark = lastId;
            continue;
          }
          // A dispense goes out only after its sale was accepted.
          let saleDep: string | null = null;
          if (g.rows[0].txn_type === 'DISPENSE' || g.rows[0].txn_type === 'DISPENSE_RETURN') {
            const [sale] = await m.query(
              `SELECT o.id, o.status FROM etims_outbox o JOIN sales_invoice s ON s.id = o.doc_id
                WHERE o.kind = 'SALE' AND (s.id = $1 OR s.source_id = $1) ORDER BY o.created_at DESC LIMIT 1`,
              [g.rows[0].source_doc_id],
            );
            if (!sale) {
              stop = `Waiting for the sales invoice of ${g.rows[0].source_doc_no}`;
              break;
            }
            saleDep = sale.status === 'ACCEPTED' ? null : sale.id;
          }
          const items = await this.loadItems(m, [...new Set(g.rows.map((r) => r.item_id))]);
          const lines: StockLine[] = [];
          const deps: string[] = saleDep ? [saleDep] : [];
          try {
            for (const r of g.rows) {
              const { item, pendingOutboxId } = await this.ensureItem(m, config, r.item_id, SYSTEM_ACTOR);
              if (pendingOutboxId) deps.push(pendingOutboxId);
              lines.push({
                itemCd: item.itemCd,
                itemClsCd: item.itemClsCd,
                itemNm: items.get(r.item_id)!.name,
                bcd: items.get(r.item_id)!.gtin,
                pkgUnitCd: item.pkgUnitCd,
                qtyUnitCd: item.qtyUnitCd,
                qty: Math.abs(r.quantity),
                itemExprDt: r.expiry,
                prc: r.unit_cost,
                taxTyCd: item.taxTyCd,
                taxRate: await this.rateForType(m, item.taxTyCd),
              });
            }
          } catch (e) {
            stop = (e as Error).message;
            break;
          }
          const sarNo = await this.nextNo(m, config.id, 'next_sar_no');
          const io = await this.enqueue(m, {
            config,
            kind: EtimsOutboxKind.STOCK_IO,
            key: `STOCK|${config.id}|${g.rows[0].id}`,
            docType: g.rows[0].source_doc_type,
            docId: g.rows[0].source_doc_id,
            docNo: g.rows[0].source_doc_no,
            payload: buildStockIOPayload({ sarNo, sarTyCd: g.sar, ocrnDt: g.rows[0].effective_date, remark: `${g.rows[0].txn_type} ${g.rows[0].source_doc_no ?? ''}`.trim(), lines, actor: SYSTEM_ACTOR }),
            dependsOn: [...new Set(deps)],
          });
          movements++;
          for (const itemId of new Set(g.rows.map((r) => r.item_id))) {
            const [{ qty }] = await m.query(`SELECT COALESCE(SUM(on_hand), 0)::float AS qty FROM stock_balance WHERE store_id = $1 AND item_id = $2`, [config.storeId, itemId]);
            const reg = await m.findOneByOrFail(EtimsItem, { configId: config.id, itemId });
            await this.enqueue(m, {
              config,
              kind: EtimsOutboxKind.STOCK_MASTER,
              key: `MASTER|${config.id}|${itemId}|${lastId}`,
              docType: 'STOCK_MASTER',
              docId: itemId,
              docNo: reg.itemCd,
              payload: buildStockMasterPayload(reg.itemCd, qty, SYSTEM_ACTOR),
              dependsOn: [io.id],
            });
            masters++;
          }
          watermark = lastId;
        }
        config.lastStockTxnId = watermark;
        config.stockReportError = stop;
        if (stop) paused.push(`${config.storeId}: ${stop}`);
        await m.save(config);
      });
    }
    if (movements) await this.jobs.enqueue('etims.dispatch', {}, { trigger: 'event', dedupeKey: 'stock' }).catch(() => undefined);
    return { configs: configs.length, movements, masters, paused };
  }

  // ------------------------------------------------------------------ purchases (supplier sales to the hospital)

  async fetchPurchases(): Promise<{ fetched: number; matched: number }> {
    let fetched = 0;
    for (const c of await this.activeConfigs()) {
      await this.ds.transaction(async (m) => {
        const config = await this.withKey(m, c.id);
        const now = etimsDateTime(new Date(), await this.settings.get('locale.timezone', m));
        const res = await this.transmit(m, config, 'purchases', { lastReqDt: config.lastRequest.purchases ?? '20180101000000' }, null);
        if (!res.ok) return;
        for (const s of (res.data?.saleList as Record<string, unknown>[]) ?? []) {
          const breakdown: Record<string, number> = {};
          for (const k of Object.keys(s)) if (/^(taxblAmt|taxRt|taxAmt)[A-E]$/.test(k)) breakdown[k] = Number(s[k]);
          await m.query(
            `INSERT INTO etims_purchase (config_id, spplr_tin, spplr_nm, spplr_bhf_id, spplr_invc_no, sales_dt, tot_taxbl_amt, tot_tax_amt, tot_amt, tax_breakdown, items)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (spplr_tin, spplr_invc_no, config_id) DO NOTHING`,
            [config.id, s.spplrTin, s.spplrNm ?? null, s.spplrBhfId ?? null, String(s.spplrInvcNo), s.salesDt ?? null, s.totTaxblAmt ?? 0, s.totTaxAmt ?? 0, s.totAmt ?? 0, breakdown, JSON.stringify(s.itemList ?? [])],
          );
          fetched++;
        }
        config.lastRequest = { ...config.lastRequest, purchases: now };
        await m.save(config);
      });
    }
    const matched = await this.matchAllInvoices();
    return { fetched, matched };
  }

  /** Normalised supplier invoice number for matching (case, spaces and leading zeros ignored). */
  static norm(no: string) {
    return String(no).trim().toUpperCase().replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
  }

  /** Matches a supplier invoice to its eTIMS purchase; sets VERIFIED or NOT_ON_ETIMS. */
  async matchInvoice(m: EntityManager, invoiceId: string): Promise<EtimsStatus> {
    const [inv] = await m.query(
      `SELECT si.id, si.supplier_invoice_no, s.kra_pin FROM supplier_invoice si JOIN supplier s ON s.id = si.supplier_id WHERE si.id = $1`,
      [invoiceId],
    );
    if (!inv) throw new NotFoundException('Invoice not found');
    const candidates: { id: string; spplr_invc_no: string }[] = await m.query(`SELECT id, spplr_invc_no FROM etims_purchase WHERE spplr_tin = $1`, [inv.kra_pin]);
    const hit = candidates.find((p) => EtimsService.norm(p.spplr_invc_no) === EtimsService.norm(inv.supplier_invoice_no));
    const status = hit ? EtimsStatus.VERIFIED : EtimsStatus.NOT_ON_ETIMS;
    await m.query(`UPDATE supplier_invoice SET etims_status = $2 WHERE id = $1`, [invoiceId, status]);
    if (hit) await m.query(`UPDATE etims_purchase SET supplier_invoice_id = $2 WHERE id = $1`, [hit.id, invoiceId]);
    return status;
  }

  private async matchAllInvoices(): Promise<number> {
    const open: { id: string }[] = await this.ds.query(`SELECT id FROM supplier_invoice WHERE etims_status IN ('NOT_CHECKED', 'NOT_ON_ETIMS') AND status <> 'CANCELLED'`);
    let matched = 0;
    for (const o of open) if ((await this.matchInvoice(this.ds.manager, o.id)) === EtimsStatus.VERIFIED) matched++;
    return matched;
  }

  /** At invoice capture: pull the latest purchases (short wait), then match. Never blocks capture. */
  async verifySupplierInvoice(invoiceId: string): Promise<EtimsStatus> {
    // Without an initialised control unit there is nothing to check against.
    if (!(await this.activeConfigs()).length) return EtimsStatus.NOT_CHECKED;
    try {
      await this.fetchPurchases();
    } catch (e) {
      this.log.warn(`eTIMS purchase fetch failed: ${(e as Error).message}`);
    }
    return this.matchInvoice(this.ds.manager, invoiceId);
  }

  async purchases(status?: string) {
    return this.ds.getRepository(EtimsPurchase).find({ where: status ? { status: status as EtimsPurchaseStatus } : {}, order: { createdAt: 'DESC' }, take: 500 });
  }

  /** Accept (02) or reject (04) a supplier's sale on eTIMS. */
  async decidePurchase(id: string, accept: boolean, note: string | undefined, actor: SessionUser) {
    const out = await this.ds.transaction(async (m) => {
      const p = await m.findOne(EtimsPurchase, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!p) throw new NotFoundException('Purchase not found');
      if (p.status !== EtimsPurchaseStatus.RECEIVED) throw new ConflictException(`Purchase is already ${p.status}`);
      const config = await m.findOneByOrFail(EtimsConfig, { id: p.configId });
      const purchaseNo = await this.nextNo(m, config.id, 'next_purchase_no');
      p.decisionNote = note ?? null;
      await m.save(p);
      return this.enqueue(m, {
        config,
        kind: EtimsOutboxKind.PURCHASE,
        key: `PURCHASE|${p.id}`,
        docType: 'PURCHASE',
        docId: p.id,
        docNo: `${p.spplrTin}/${p.spplrInvcNo}`,
        payload: buildPurchasePayload({
          invcNo: purchaseNo,
          spplrTin: p.spplrTin,
          spplrBhfId: p.spplrBhfId,
          spplrNm: p.spplrNm,
          spplrInvcNo: p.spplrInvcNo,
          accept,
          pmtTyCd: await this.settings.get('etims.defaultPaymentType', m),
          salesDt: p.salesDt,
          at: new Date(),
          timeZone: await this.settings.get('locale.timezone', m),
          totals: { ...p.taxBreakdown, totTaxblAmt: p.totTaxblAmt, totTaxAmt: p.totTaxAmt, totAmt: p.totAmt },
          items: p.items,
          remark: note ?? null,
          actor: actorOf(actor),
        }),
      });
    });
    await this.sendOne(out.id);
    return this.ds.getRepository(EtimsPurchase).findOneByOrFail({ id });
  }

  /**
   * Reverse invoicing: for supplies from persons not registered for VAT/eTIMS the
   * buyer would issue the invoice. OSCU/VSCU v2.0 has no message for it, so this
   * only reports whether the invoice would need one (supplier without a KRA PIN).
   */
  async reverseInvoiceCheck(m: EntityManager, invoiceId: string): Promise<{ required: boolean; note: string | null }> {
    const [r] = await m.query(`SELECT s.kra_pin FROM supplier_invoice si JOIN supplier s ON s.id = si.supplier_id WHERE si.id = $1`, [invoiceId]);
    const required = !r?.kra_pin;
    return { required, note: required ? 'Supplier has no KRA PIN: a reverse invoice may be required (not yet supported by the eTIMS OSCU/VSCU specification)' : null };
  }

  // ------------------------------------------------------------------ import items

  async fetchImports(): Promise<{ fetched: number }> {
    let fetched = 0;
    for (const c of await this.activeConfigs()) {
      await this.ds.transaction(async (m) => {
        const config = await this.withKey(m, c.id);
        const res = await this.transmit(m, config, 'imports', { lastReqDt: config.lastRequest.imports ?? '20180101000000' }, null);
        if (!res.ok) return;
        for (const it of (res.data?.itemList as Record<string, unknown>[]) ?? []) {
          await m.query(
            `INSERT INTO etims_import_item (config_id, task_cd, dcl_de, item_seq, dcl_no, hs_cd, item_nm, raw, impt_item_stts_cd)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (config_id, task_cd, item_seq) DO NOTHING`,
            [config.id, it.taskCd, it.dclDe ?? null, Number(it.itemSeq), it.dclNo ?? null, it.hsCd ?? null, it.itemNm, it, it.imptItemSttsCd ?? '2'],
          );
          fetched++;
        }
        config.lastRequest = { ...config.lastRequest, imports: etimsDateTime(new Date(), await this.settings.get('locale.timezone', m)) };
        await m.save(config);
      });
    }
    return { fetched };
  }

  async imports() {
    return this.ds.getRepository(EtimsImportItem).find({ order: { createdAt: 'DESC' }, take: 500 });
  }

  /** Links a declared import to a local item and approves it on eTIMS (updateImportItem, status 3). */
  async linkImport(id: string, itemId: string, actor: SessionUser) {
    const ob = await this.ds.transaction(async (m) => {
      const imp = await m.findOne(EtimsImportItem, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!imp) throw new NotFoundException('Import item not found');
      const config = await m.findOneByOrFail(EtimsConfig, { id: imp.configId });
      const { item, pendingOutboxId } = await this.ensureItem(m, config, itemId, actorOf(actor));
      imp.itemId = itemId;
      await m.save(imp);
      return this.enqueue(m, {
        config,
        kind: EtimsOutboxKind.IMPORT_ITEM,
        key: `IMPORT|${imp.id}`,
        docType: 'IMPORT',
        docId: imp.id,
        docNo: imp.taskCd,
        payload: { taskCd: imp.taskCd, dclDe: imp.dclDe, itemSeq: imp.itemSeq, hsCd: imp.hsCd, itemClsCd: item.itemClsCd, itemCd: item.itemCd, imptItemSttsCd: '3', remark: null, modrId: actor.username, modrNm: actor.fullName },
        dependsOn: pendingOutboxId ? [pendingOutboxId] : [],
      });
    });
    await this.sendOne(ob.id);
    return this.ds.getRepository(EtimsImportItem).findOneByOrFail({ id });
  }

  // ------------------------------------------------------------------ views

  async outbox(q: { status?: string; kind?: string }) {
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.kind) where.kind = q.kind;
    return this.ds.getRepository(EtimsOutbox).find({ where, order: { createdAt: 'DESC' }, take: 500 });
  }

  async transmissions(outboxId?: string) {
    return this.ds.getRepository(EtimsTransmission).find({ where: outboxId ? { outboxId } : {}, order: { at: 'DESC' }, take: 200 });
  }

  async codeStatus() {
    const [codes] = await this.ds.query(`SELECT count(*)::int AS n, max(synced_at) AS at FROM etims_code`);
    const [classes] = await this.ds.query(`SELECT count(*)::int AS n FROM etims_item_class`);
    const unmapped = await this.ds.query(
      `SELECT i.id, i.code, i.name FROM item i WHERE i.is_active AND NOT EXISTS (SELECT 1 FROM etims_item e WHERE e.item_id = i.id) ORDER BY i.code LIMIT 1`,
    );
    return { codes: codes.n, lastSync: codes.at, itemClasses: classes.n, sampleUnregistered: unmapped };
  }

  /** Items that cannot be invoiced (missing mapping), for the mapping screen. */
  async unmappedItems(limit = 200) {
    const items: ItemRow[] = await this.ds.query(
      `SELECT i.id, i.code, i.name, i.barcode, i.gtin, i.unit_price, u.code AS uom_code, t.code AS tax_code, i.category_id, i.is_batch_tracked
         FROM item i JOIN unit_of_measure u ON u.id = i.base_uom_id JOIN tax_category t ON t.id = i.tax_category_id WHERE i.is_active ORDER BY i.code`,
    );
    const out: { itemId: string; code: string; name: string; missing: string[] }[] = [];
    for (const it of items) {
      const { missing } = await this.resolveItem(this.ds.manager, it);
      if (missing.length) out.push({ itemId: it.id, code: it.code, name: it.name, missing });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Receipt QR (TIS spec sample receipt link). */
  async qrUrl(inv: { rcptSign: string | null }, config: { kraPin: string; branchId: string }) {
    const tpl = await this.settings.get('etims.qrUrlTemplate');
    return tpl.replace('{pin}', config.kraPin).replace('{bhfId}', config.branchId).replace('{rcptSign}', inv.rcptSign ?? '');
  }
}
