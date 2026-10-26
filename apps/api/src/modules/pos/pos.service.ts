import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  AuditAction,
  ControlledSchedule,
  CustomerLedgerType,
  DocumentType,
  Permissions,
  PosEventType,
  PosSaleStatus,
  PosShiftStatus,
  SalesClass,
  SalesSource,
  SessionUser,
} from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { AuditService } from '../audit/audit.service';
import { PriceList, SalesInvoice } from '../billing/billing.entities';
import { BillingService } from '../billing/billing.service';
import { takeStock } from '../billing/dispense-stock';
import { round2 } from '../billing/tax-calc';
import { EtimsService } from '../etims/etims.service';
import { InventoryService } from '../inventory/inventory.service';
import { NumberingService } from '../numbering/numbering.service';
import { ageInYears, AlertDraft, InternalInteractionSource, MedForCheck, runChecks, termsOf } from '../pharmacy/interactions';
import { Patient } from '../pharmacy/pharmacy.entities';
import { SettingsService } from '../settings/settings.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import { MpesaService } from './mpesa.service';
import { BasketCheckDto, CredentialsDto, PosLineDto, PosSaleDto, RefundDto, VoidSaleDto } from './pos.dto';
import { Customer, CustomerLedger, PosEvent, PosSale, PosShift, PosTerminal } from './pos.entities';

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
/** Same rules as FEFO: unreserved, not held, not quarantined, not expired. */
const USABLE = `sb.on_hand - sb.reserved > 0 AND b.hold_status = 'NONE' AND NOT COALESCE(bn.is_quarantine, false) AND (b.expiry_date IS NULL OR b.expiry_date >= CURRENT_DATE)`;

export interface QuoteLine {
  itemId: string;
  code: string;
  name: string;
  genericId: string | null;
  generic: string | null;
  salesClass: SalesClass;
  quantity: number;
  listPrice: number;
  promotion: { code: string; name: string; percent: number } | null;
  manualDiscountPercent: number;
  discountPercent: number;
  gross: number;
  available: number;
  lowStock: boolean;
}

export interface Quote {
  priceListId: string;
  lines: QuoteLine[];
  total: number;
  discountAmount: number;
  loyalty: { points: number; value: number } | null;
  /** What the sale needs before it can be completed. */
  needs: { pharmacist: boolean; prescription: boolean; supervisor: boolean; interactionReason: boolean };
  blocked: string[];
  alerts: (AlertDraft & { blocking: boolean })[];
  maxDiscountPercent: number;
}

/**
 * Over-the-counter sales at the till: pricing (price lists, promotions,
 * manual discounts within the role limit), OTC controls (sales class,
 * quantity limits, interactions), FEFO stock, the eTIMS invoice, payments
 * (cash, M-Pesa STK or code, card, split, customer credit, loyalty), and
 * voids / refunds as credit notes. Offline sales sync through the same path,
 * idempotent on the till's clientRef.
 */
@Injectable()
export class PosService {
  private readonly interactions = new InternalInteractionSource();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly billing: BillingService,
    private readonly etims: EtimsService,
    private readonly inventory: InventoryService,
    private readonly numbering: NumberingService,
    private readonly mpesa: MpesaService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ helpers

  async terminal(m: EntityManager, id: string): Promise<PosTerminal> {
    const t = await m.findOneBy(PosTerminal, { id });
    if (!t || !t.isActive) throw new NotFoundException('Till not found or inactive');
    StoreScope.assert(t.storeId);
    return t;
  }

  /**
   * Someone authorised to do `permission`: the seller when they hold it and
   * gave no credentials, else the person whose credentials were given (must
   * differ from the seller). Failed attempts are audited.
   */
  async approver(creds: CredentialsDto | undefined, actor: SessionUser, permission: string, what: string): Promise<string> {
    if (!creds) {
      if (actor.permissions.includes(permission)) return actor.id;
      throw new ForbiddenException({ code: 'APPROVAL_REQUIRED', message: `${what} needs approval: ask a colleague who may approve to enter their username and password` });
    }
    const user = await this.users.findWithSecretsByUsername(creds.username);
    const ok = await this.passwords.verify(user?.passwordHash, creds.password);
    if (!user || !ok || !user.isActive) {
      await this.audit.record({ action: AuditAction.LOGIN_FAILED, entityType: 'User', entityId: user?.id ?? null, after: { username: creds.username, reason: `pos_approval_failed: ${what}` } });
      throw new BadRequestException({ code: 'APPROVER_INVALID', message: 'Approver username or password is incorrect' });
    }
    if (user.id === actor.id) {
      if (actor.permissions.includes(permission)) return actor.id;
      throw new ForbiddenException(`You may not approve ${what.toLowerCase()} yourself`);
    }
    const session = await this.users.findForSession(user.id);
    if (!session?.permissions.includes(permission)) throw new ForbiddenException(`${user.fullName} may not approve ${what.toLowerCase()}`);
    return user.id;
  }

  /** Largest manual discount % the user may give alone (highest of their roles). */
  async discountLimit(m: EntityManager, actor: SessionUser): Promise<number> {
    const limits = await this.settings.get('pos.discountLimits', m);
    return Math.max(0, ...actor.roles.map((r) => limits[r.code] ?? 0));
  }

  private event(m: EntityManager, e: Partial<PosEvent> & { type: PosEventType; userId: string }) {
    return m.save(m.create(PosEvent, { details: {}, ...e }));
  }

  // ------------------------------------------------------------------ quote and checks

  /**
   * Prices the basket (customer's / till's / chosen price list, best active
   * promotion, manual discount), resolves sales classes and stock, and runs
   * the OTC checks: controlled drugs blocked, quantity limits, pharmacist for
   * pharmacy-only / prescription-only items, interactions on the basket and
   * the customer's recent purchases.
   */
  async quote(m: EntityManager, input: { terminal: PosTerminal; customer: Customer | null; priceListId?: string; lines: PosLineDto[]; redeemPoints?: number; actor: SessionUser }): Promise<Quote> {
    const listId = input.priceListId ?? input.customer?.priceListId ?? input.terminal.defaultPriceListId;
    const list = listId ? await m.findOneBy(PriceList, { id: listId, isActive: true }) : await this.billing.defaultPriceList(m);
    if (!list) throw new BadRequestException('Price list not found or inactive');
    const ids = [...new Set(input.lines.map((l) => l.itemId))];
    const items: {
      id: string; code: string; name: string; is_active: boolean; sales_class: SalesClass | null; is_controlled: boolean; category_id: string; generic_id: string | null;
      inn_name: string | null; strength: string | null; therapeutic_class: string | null; controlled_schedule: ControlledSchedule | null; max_qty_per_sale: string | null;
      pregnancy_contraindicated: boolean | null; min_age_years: string | null; available: number; reorder_level: number | null;
    }[] = await m.query(
      `SELECT i.id, i.code, i.name, i.is_active, i.sales_class, i.is_controlled, i.category_id, i.generic_id, g.inn_name, g.strength, g.therapeutic_class, g.controlled_schedule,
              g.max_qty_per_sale, g.pregnancy_contraindicated, g.min_age_years,
              COALESCE((SELECT SUM(sb.on_hand - sb.reserved) FROM stock_balance sb JOIN batch b ON b.id = sb.batch_id LEFT JOIN bin bn ON bn.id = sb.bin_id
                         WHERE sb.item_id = i.id AND sb.store_id = $2 AND ${USABLE}), 0)::float AS available,
              (SELECT s.reorder_level::float FROM store_item_setting s WHERE s.item_id = i.id AND s.store_id = $2) AS reorder_level
         FROM item i LEFT JOIN generic g ON g.id = i.generic_id WHERE i.id = ANY($1::uuid[])`,
      [ids, input.terminal.storeId],
    );
    const today = await this.settings.today(m);
    const promos: { code: string; name: string; item_id: string | null; category_id: string | null; discount_percent: string; min_qty: string }[] = await m.query(
      `SELECT p.code, p.name, p.item_id, p.category_id, p.discount_percent, p.min_qty FROM pos_promotion p
        WHERE p.is_active AND p.starts_on <= $1::date AND p.ends_on >= $1::date AND (p.item_id = ANY($2::uuid[]) OR p.category_id IN (
          WITH RECURSIVE up AS (SELECT c.id, c.parent_id FROM item_category c WHERE c.id IN (SELECT category_id FROM item WHERE id = ANY($2::uuid[]))
                                UNION SELECT c.id, c.parent_id FROM item_category c JOIN up ON c.id = up.parent_id) SELECT id FROM up))`,
      [today, ids],
    );
    const ancestors = new Map<string, string[]>();
    for (const cid of new Set(items.map((i) => i.category_id))) {
      const rows: { id: string }[] = await m.query(`WITH RECURSIVE up AS (SELECT id, parent_id FROM item_category WHERE id = $1 UNION SELECT c.id, c.parent_id FROM item_category c JOIN up ON c.id = up.parent_id) SELECT id FROM up`, [cid]);
      ancestors.set(cid, rows.map((r) => r.id));
    }
    const defaultClass = (await this.settings.get('pos.defaultSalesClass', m)) as SalesClass;
    const blocked: string[] = [];
    const lines: QuoteLine[] = [];
    for (const l of input.lines) {
      const it = items.find((i) => i.id === l.itemId);
      if (!it || !it.is_active) throw new BadRequestException('An item is unknown or inactive');
      const p = await this.billing.priceFor(m, list, it.id);
      const cats = ancestors.get(it.category_id) ?? [it.category_id];
      const promo = promos
        .filter((x) => (x.item_id === it.id || (x.category_id && cats.includes(x.category_id))) && Number(x.min_qty) <= l.quantity)
        .sort((a, b) => Number(b.discount_percent) - Number(a.discount_percent))[0];
      const manual = l.discountPercent ?? 0;
      const discountPercent = Math.min(100, (promo ? Number(promo.discount_percent) : 0) + manual);
      const controlled = it.is_controlled || (it.controlled_schedule && it.controlled_schedule !== ControlledSchedule.NONE);
      const salesClass = controlled ? SalesClass.CD : (it.sales_class ?? defaultClass);
      if (salesClass === SalesClass.CD) blocked.push(`${it.name} is a controlled drug and cannot be sold over the counter`);
      // Same rounding as the invoice line (computeLine).
      const before = round2(l.quantity * p.price);
      const gross = round2(before - round2((before * discountPercent) / 100));
      lines.push({
        itemId: it.id,
        code: it.code,
        name: it.name,
        genericId: it.generic_id,
        generic: it.inn_name ? `${it.inn_name}${it.strength ? ` ${it.strength}` : ''}` : null,
        salesClass,
        quantity: l.quantity,
        listPrice: p.price,
        promotion: promo ? { code: promo.code, name: promo.name, percent: Number(promo.discount_percent) } : null,
        manualDiscountPercent: manual,
        discountPercent,
        gross,
        available: it.available,
        lowStock: it.reorder_level !== null ? it.available - l.quantity <= it.reorder_level : false,
      });
      if (l.quantity > it.available) blocked.push(`Only ${it.available} of ${it.name} usable in stock`);
    }
    // Quantity limits per generic across its brands.
    const byGeneric = new Map<string, number>();
    for (const l of lines) if (l.genericId) byGeneric.set(l.genericId, r4((byGeneric.get(l.genericId) ?? 0) + l.quantity));
    for (const [gid, q] of byGeneric) {
      const it = items.find((i) => i.generic_id === gid)!;
      if (it.max_qty_per_sale !== null && q > Number(it.max_qty_per_sale)) blocked.push(`${it.inn_name}: at most ${Number(it.max_qty_per_sale)} per sale over the counter`);
    }

    // Interactions: basket generics against each other and the customer's recent medicines.
    const med = (r: { generic_id: string; inn_name: string; strength: string | null; therapeutic_class: string | null; pregnancy_contraindicated: boolean | null; min_age_years: string | null }, lineId: string | null): MedForCheck => ({
      lineId,
      genericId: r.generic_id,
      inn: r.inn_name,
      therapeuticClass: r.therapeutic_class,
      pregnancyContraindicated: !!r.pregnancy_contraindicated,
      minAgeYears: r.min_age_years === null ? null : Number(r.min_age_years),
      label: `${r.inn_name}${r.strength ? ` ${r.strength}` : ''}`,
    });
    const basket = items.filter((i) => i.generic_id && i.inn_name).map((i) => med(i as Parameters<typeof med>[0], i.id));
    let active: MedForCheck[] = [];
    let patient: Patient | null = null;
    if (input.customer) {
      const days = await this.settings.get('pharmacy.activeMedicationDays', m);
      const recent: Parameters<typeof med>[0][] = await m.query(
        `SELECT DISTINCT g.id AS generic_id, g.inn_name, g.strength, g.therapeutic_class, g.pregnancy_contraindicated, g.min_age_years
           FROM pos_sale ps JOIN sales_invoice_line sl ON sl.invoice_id = ps.invoice_id JOIN item i ON i.id = sl.item_id JOIN generic g ON g.id = i.generic_id
          WHERE ps.customer_id = $1 AND ps.status <> 'VOIDED' AND ps.sold_at >= now() - ($2 || ' days')::interval`,
        [input.customer.id, String(days)],
      );
      active = recent.map((r) => med(r, null));
      if (input.customer.patientId) patient = await m.findOneBy(Patient, { id: input.customer.patientId });
    }
    const terms = [...new Set([...basket, ...active].flatMap(termsOf))];
    const pairs = await this.interactions.find(m, terms);
    const blockingSeverities = new Set(await this.settings.get('pharmacy.blockingSeverities', m));
    const alerts = runChecks({ ageYears: patient ? ageInYears(patient.dateOfBirth, today) : null, isPregnant: patient?.isPregnant ?? false, allergies: patient?.allergies ?? [] }, basket, active, pairs).map((a) => ({ ...a, blocking: blockingSeverities.has(a.severity) }));

    const total = round2(lines.reduce((s, l) => s + l.gross, 0));
    const discountAmount = round2(lines.reduce((s, l) => s + round2(l.listPrice * l.quantity), 0) - total);
    let loyalty: Quote['loyalty'] = null;
    if (input.redeemPoints) {
      const cfg = await this.settings.get('pos.loyalty', m);
      if (!cfg.enabled) blocked.push('Loyalty is switched off');
      else if (!input.customer) blocked.push('Choose the customer whose points are redeemed');
      else if (input.redeemPoints > input.customer.loyaltyPoints) blocked.push(`${input.customer.name} has ${input.customer.loyaltyPoints} points`);
      else if (input.redeemPoints < cfg.minRedeemPoints) blocked.push(`Redeem at least ${cfg.minRedeemPoints} points`);
      else loyalty = { points: input.redeemPoints, value: Math.min(total, round2(input.redeemPoints * cfg.pointValue)) };
    }
    const maxDiscountPercent = await this.discountLimit(m, input.actor);
    return {
      priceListId: list.id,
      lines,
      total,
      discountAmount,
      loyalty,
      needs: {
        pharmacist: lines.some((l) => l.salesClass === SalesClass.P || l.salesClass === SalesClass.POM) || alerts.some((a) => a.blocking),
        prescription: lines.some((l) => l.salesClass === SalesClass.POM),
        supervisor: lines.some((l) => l.manualDiscountPercent > maxDiscountPercent),
        interactionReason: alerts.some((a) => a.blocking),
      },
      blocked,
      alerts,
      maxDiscountPercent,
    };
  }

  /** Basket preview for the till: prices, promotions, controls and alerts before payment. */
  async check(dto: BasketCheckDto, actor: SessionUser) {
    return this.ds.transaction(async (m) => {
      const terminal = await this.terminal(m, dto.terminalId);
      const customer = dto.customerId ? await m.findOneBy(Customer, { id: dto.customerId, isActive: true }) : null;
      return this.quote(m, { terminal, customer, priceListId: dto.priceListId, lines: dto.lines, redeemPoints: dto.redeemPoints, actor });
    });
  }

  // ------------------------------------------------------------------ selling

  /** Completes a sale (online, or synced from an offline till). Idempotent on clientRef. */
  async sell(dto: PosSaleDto, actor: SessionUser) {
    const r = await this.ds.transaction(async (m) => {
      const prior = await m.findOneBy(PosSale, { clientRef: dto.clientRef });
      if (prior) return { saleId: prior.id, outboxId: null as string | null, change: 0, duplicate: true, warnings: [] as string[] };
      const terminal = await this.terminal(m, dto.terminalId);
      const shift = await m.findOne(PosShift, { where: { terminalId: terminal.id, cashierId: actor.id, status: PosShiftStatus.OPEN }, lock: { mode: 'pessimistic_read' } });
      if (!shift) throw new ConflictException({ code: 'NO_OPEN_SHIFT', message: 'Open a shift on this till to sell' });
      const soldAt = dto.soldAt ? new Date(dto.soldAt) : new Date();
      if (dto.offline) {
        const maxH = await this.settings.get('pos.offlineMaxHours', m);
        if (Date.now() - soldAt.getTime() > maxH * 3_600_000) throw new BadRequestException(`Offline sale older than ${maxH} hours`);
      }

      let customer = dto.customerId ? await m.findOneBy(Customer, { id: dto.customerId, isActive: true }) : null;
      if (dto.customerId && !customer) throw new BadRequestException('Customer not found or inactive');
      if (!customer && dto.newCustomer) {
        const phone = dto.newCustomer.phone?.trim() || null;
        customer = (phone ? await m.findOneBy(Customer, { phone }) : null) ?? (await m.save(m.create(Customer, { code: await this.numbering.next(DocumentType.CUSTOMER, { manager: m }), name: dto.newCustomer.name, phone, kraPin: dto.newCustomer.kraPin ?? null })));
      }

      const q = await this.quote(m, { terminal, customer, priceListId: dto.priceListId, lines: dto.lines, redeemPoints: dto.redeemPoints, actor });
      if (q.blocked.length) throw new BadRequestException({ code: 'SALE_BLOCKED', message: q.blocked.join('; '), blocked: q.blocked });
      let pharmacistId: string | null = null;
      if (q.needs.pharmacist) {
        if (q.needs.prescription && !dto.prescriptionRef?.trim()) throw new BadRequestException({ code: 'PRESCRIPTION_REQUIRED', message: 'Prescription-only medicine: enter the prescription reference' });
        if (q.needs.interactionReason && !dto.interactionOverrideReason?.trim()) throw new ConflictException({ code: 'INTERACTION_BLOCKED', message: 'A serious interaction needs a pharmacist’s reason to proceed', alerts: q.alerts.filter((a) => a.blocking) });
        pharmacistId = await this.approver(dto.pharmacist, actor, Permissions.POS_APPROVE_POM, 'Selling pharmacy-only or prescription-only medicines');
      }
      const overrideBy = q.needs.supervisor ? await this.approver(dto.supervisor, actor, Permissions.POS_OVERRIDE, `A discount above ${q.maxDiscountPercent}%`) : null;

      // Payments: everything must be covered (cash may exceed: change).
      const loyaltyValue = q.loyalty?.value ?? 0;
      const tendered = round2(dto.payments.reduce((s, p) => s + p.amount, 0) + loyaltyValue);
      if (tendered + 0.001 < q.total) throw new BadRequestException(`Payments (${tendered}) do not cover the total (${q.total})`);
      const nonCash = round2(dto.payments.filter((p) => p.modeCode !== 'CASH').reduce((s, p) => s + p.amount, 0) + loyaltyValue);
      if (nonCash > q.total + 0.001) throw new BadRequestException('Only cash can exceed the total (change)');

      const saleId = randomUUID();
      const invoiceId = randomUUID();
      const payments: { modeCode: string; amount: number; reference?: string }[] = [];
      let unverifiedMpesa = false;
      let onCredit = 0;
      for (const p of dto.payments) {
        if (p.modeCode === 'MPESA') {
          const c = await this.mpesa.claim(m, { transactionId: p.mpesaTransactionId, code: p.reference, amount: p.amount, shiftId: shift.id, terminalId: terminal.id, saleId, actor });
          unverifiedMpesa ||= !c.verified;
          payments.push({ modeCode: 'MPESA', amount: p.amount, reference: c.receiptNo });
        } else if (p.modeCode === 'CREDIT') {
          if (!customer?.creditAllowed) throw new BadRequestException('Only customers with a credit account can buy on account');
          const [{ balance }] = await m.query(`SELECT COALESCE(SUM(amount), 0)::float AS balance FROM customer_ledger WHERE customer_id = $1`, [customer.id]);
          if (balance + p.amount > customer.creditLimit + 0.001) throw new BadRequestException(`${customer.name}: credit limit ${customer.creditLimit}, owing ${balance}`);
          onCredit = round2(onCredit + p.amount);
          payments.push({ modeCode: 'CREDIT', amount: p.amount, reference: customer.code });
        } else if (p.modeCode === 'LOYALTY') {
          throw new BadRequestException('Redeem loyalty points with redeemPoints');
        } else {
          payments.push({ modeCode: p.modeCode, amount: p.amount, reference: p.reference });
        }
      }
      if (q.loyalty) payments.push({ modeCode: 'LOYALTY', amount: q.loyalty.value, reference: `${q.loyalty.points} points` });

      const number = await this.numbering.next(DocumentType.SALES_INVOICE, { storeId: terminal.storeId, manager: m });
      const ctx = await this.inventory.postingContext(actor, { type: DocumentType.SALES_INVOICE, id: invoiceId, number }, undefined, null, m);
      const { allocations } = await takeStock(m, ctx, terminal.storeId, dto.lines.map((l, i) => ({ key: String(i), itemId: l.itemId, quantity: l.quantity })));
      const inv = await this.billing.createInvoice(
        m,
        {
          id: invoiceId,
          number,
          storeId: terminal.storeId,
          source: SalesSource.OTC,
          sourceId: saleId,
          patientId: customer?.patientId ?? null,
          customerName: customer?.name ?? null,
          customerPin: customer?.kraPin ?? null,
          customerPhone: customer?.phone ?? null,
          priceListId: q.priceListId,
          notes: [dto.offline ? 'Offline sale' : null, dto.prescriptionRef ? `Rx ${dto.prescriptionRef}` : null].filter(Boolean).join(' · ') || null,
          payments,
          lines: q.lines.map((l, i) => ({ itemId: l.itemId, quantity: l.quantity, unitPrice: l.listPrice, discountPercent: l.discountPercent, allocations: allocations.get(String(i)) ?? [] })),
        },
        actor,
      );

      // Customer account and loyalty.
      let pointsEarned = 0;
      if (customer) {
        if (onCredit > 0) await m.save(m.create(CustomerLedger, { customerId: customer.id, type: CustomerLedgerType.SALE, amount: onCredit, invoiceId, reference: number, userId: actor.id }));
        const cfg = await this.settings.get('pos.loyalty', m);
        if (cfg.enabled) {
          pointsEarned = Math.floor(Math.max(0, inv.invoice.totalAmount - loyaltyValue - onCredit) / cfg.earnPerAmount);
          await m.update(Customer, customer.id, { loyaltyPoints: customer.loyaltyPoints - (q.loyalty?.points ?? 0) + pointsEarned });
        }
      }
      await m.save(
        m.create(PosSale, {
          id: saleId,
          invoiceId,
          clientRef: dto.clientRef,
          shiftId: shift.id,
          terminalId: terminal.id,
          storeId: terminal.storeId,
          cashierId: actor.id,
          customerId: customer?.id ?? null,
          offline: !!dto.offline,
          soldAt,
          total: inv.invoice.totalAmount,
          discountAmount: q.discountAmount,
          prescriptionRef: dto.prescriptionRef?.trim() || null,
          pharmacistId,
          overrideBy,
          pointsEarned,
          pointsRedeemed: q.loyalty?.points ?? 0,
        }),
      );
      const base = { shiftId: shift.id, terminalId: terminal.id, saleId, userId: actor.id };
      for (const v of dto.voidedLines ?? []) await this.event(m, { ...base, type: PosEventType.VOID_LINE, reason: v.reason ?? null, details: { itemId: v.itemId, quantity: v.quantity } });
      if (overrideBy) await this.event(m, { ...base, type: PosEventType.DISCOUNT_OVERRIDE, approvedBy: overrideBy, amount: q.discountAmount, details: { lines: q.lines.filter((l) => l.manualDiscountPercent > q.maxDiscountPercent).map((l) => ({ itemId: l.itemId, percent: l.manualDiscountPercent })) } });
      if (pharmacistId) await this.event(m, { ...base, type: PosEventType.PHARMACIST_APPROVAL, approvedBy: pharmacistId, reason: dto.prescriptionRef ?? null, details: { classes: [...new Set(q.lines.map((l) => l.salesClass))] } });
      if (q.needs.interactionReason) await this.event(m, { ...base, type: PosEventType.INTERACTION_OVERRIDE, approvedBy: pharmacistId, reason: dto.interactionOverrideReason!, details: { alerts: q.alerts.filter((a) => a.blocking).map((a) => a.message) } });
      await m.update(PosTerminal, terminal.id, { lastSeenAt: new Date() });
      const warnings = [...q.lines.filter((l) => l.lowStock).map((l) => `${l.name} is at or below its reorder level`), ...(unverifiedMpesa ? ['M-Pesa code not yet confirmed by Safaricom: it is checked at cash-up'] : [])];
      return { saleId, outboxId: inv.outboxId, change: inv.change, duplicate: false, warnings };
    });
    if (r.outboxId) await this.etims.trySendNow(r.outboxId);
    return { ...(await this.sale(r.saleId)), change: r.change, duplicate: r.duplicate, warnings: r.warnings };
  }

  /** Offline sales sent when the till is back online: each is recorded once; refusals are logged for a supervisor. */
  async sync(sales: PosSaleDto[], actor: SessionUser) {
    const results: { clientRef: string; status: 'CREATED' | 'DUPLICATE' | 'REJECTED'; saleId?: string; invoiceNo?: string; error?: string }[] = [];
    for (const s of [...sales].sort((a, b) => (a.soldAt ?? '').localeCompare(b.soldAt ?? ''))) {
      try {
        const r = await this.sell({ ...s, offline: s.offline ?? true }, actor);
        results.push({ clientRef: s.clientRef, status: r.duplicate ? 'DUPLICATE' : 'CREATED', saleId: r.id, invoiceNo: r.invoice?.number });
      } catch (e) {
        const resp = e instanceof HttpException ? e.getResponse() : null;
        const error = typeof resp === 'object' && resp && 'message' in resp ? String((resp as { message: unknown }).message) : (e as Error).message;
        results.push({ clientRef: s.clientRef, status: 'REJECTED', error });
        await this.ds.manager.save(this.ds.manager.create(PosEvent, { type: PosEventType.OFFLINE_REJECTED, terminalId: s.terminalId, userId: actor.id, reason: error.slice(0, 500), amount: s.payments.reduce((x, p) => x + p.amount, 0), details: { sale: s as unknown as Record<string, unknown> } }));
      }
    }
    return { results, created: results.filter((r) => r.status === 'CREATED').length, duplicates: results.filter((r) => r.status === 'DUPLICATE').length, rejected: results.filter((r) => r.status === 'REJECTED').length };
  }

  async sale(id: string) {
    const s = await this.ds.getRepository(PosSale).findOne({ where: { id }, relations: { customer: true } });
    if (!s) throw new NotFoundException('Sale not found');
    StoreScope.assert(s.storeId);
    const invoice = await this.billing.get(s.invoiceId);
    const events = await this.ds.getRepository(PosEvent).find({ where: { saleId: id }, order: { at: 'ASC' } });
    return { ...s, invoice, events };
  }

  // ------------------------------------------------------------------ voids and refunds

  private async refundShift(m: EntityManager, actor: SessionUser, terminalId: string | undefined, fallback: PosShift | null): Promise<PosShift | null> {
    const where = terminalId ? { terminalId, cashierId: actor.id, status: PosShiftStatus.OPEN } : { cashierId: actor.id, status: PosShiftStatus.OPEN };
    return (await m.findOneBy(PosShift, where)) ?? fallback;
  }

  /** Cancels a sale of the current open shift: full credit note (eTIMS), stock back, account and points reversed. */
  async voidSale(id: string, dto: VoidSaleDto, actor: SessionUser) {
    const s = await this.ds.getRepository(PosSale).findOneBy({ id });
    if (!s) throw new NotFoundException('Sale not found');
    StoreScope.assert(s.storeId);
    if (s.status !== PosSaleStatus.COMPLETED) throw new ConflictException(`Sale is ${s.status.toLowerCase()}`);
    const shift = await this.ds.getRepository(PosShift).findOneByOrFail({ id: s.shiftId });
    if (shift.status !== PosShiftStatus.OPEN) throw new ConflictException('Only sales of an open shift can be voided; refund it instead');
    const approvedBy = await this.approver(dto.supervisor, actor, Permissions.POS_VOID, 'Voiding a sale');
    await this.billing.creditNote(s.invoiceId, { reason: `Void: ${dto.reason}`, reasonCode: '13', restock: true }, actor, async (m, cn) => {
      await m.update(PosSale, s.id, { status: PosSaleStatus.VOIDED });
      await this.reverseAccount(m, s, cn, null, actor);
      await this.event(m, { type: PosEventType.VOID_SALE, shiftId: shift.id, terminalId: s.terminalId, saleId: s.id, userId: actor.id, approvedBy: approvedBy === actor.id ? null : approvedBy, amount: cn.totalAmount, reason: dto.reason, details: { creditNote: cn.number, modeCode: await this.refundMode(m, cn.id) } });
    });
    return this.sale(id);
  }

  /** Returns part or all of a sale: credit note (eTIMS), stock back if resaleable, paid out from the refunding till's shift. */
  async refund(id: string, dto: RefundDto, actor: SessionUser) {
    const s = await this.ds.getRepository(PosSale).findOneBy({ id });
    if (!s) throw new NotFoundException('Sale not found');
    StoreScope.assert(s.storeId);
    if (s.status === PosSaleStatus.VOIDED || s.status === PosSaleStatus.REFUNDED) throw new ConflictException(`Sale is ${s.status.toLowerCase()}`);
    if (!actor.permissions.includes(Permissions.POS_REFUND)) throw new ForbiddenException('Refunds need the refund permission');
    await this.billing.creditNote(s.invoiceId, { lines: dto.lines, reason: `Refund: ${dto.reason}`, restock: dto.restock ?? true }, actor, async (m, cn) => {
      const [{ credited, total }] = await m.query(
        `SELECT COALESCE(SUM(c.total_amount), 0)::float AS credited, (SELECT total_amount::float FROM sales_invoice WHERE id = $1) AS total FROM sales_invoice c WHERE c.original_invoice_id = $1 AND c.status = 'ISSUED'`,
        [s.invoiceId],
      );
      await m.update(PosSale, s.id, { status: credited + 0.005 >= total ? PosSaleStatus.REFUNDED : PosSaleStatus.PARTLY_REFUNDED });
      const shift = await this.refundShift(m, actor, dto.terminalId, null);
      await this.reverseAccount(m, s, cn, credited + 0.005 >= total ? null : cn.totalAmount, actor);
      await this.event(m, { type: PosEventType.REFUND, shiftId: shift?.id ?? null, terminalId: shift?.terminalId ?? s.terminalId, saleId: s.id, userId: actor.id, amount: cn.totalAmount, reason: dto.reason, details: { creditNote: cn.number, modeCode: await this.refundMode(m, cn.id) } });
    });
    return this.sale(id);
  }

  private async refundMode(m: EntityManager, creditNoteId: string): Promise<string | null> {
    const [p] = await m.query(`SELECT mode_code FROM sales_payment WHERE invoice_id = $1 ORDER BY amount DESC LIMIT 1`, [creditNoteId]);
    return p?.mode_code ?? null;
  }

  /** Credit bought on account is taken off the account; redeemed points are given back on a full reversal. */
  private async reverseAccount(m: EntityManager, s: PosSale, cn: SalesInvoice, partial: number | null, actor: SessionUser) {
    if (!s.customerId) return;
    const [{ credit }] = await m.query(`SELECT COALESCE(SUM(amount), 0)::float AS credit FROM sales_payment WHERE invoice_id = $1 AND mode_code = 'CREDIT'`, [s.invoiceId]);
    if (credit > 0) {
      const back = partial === null ? credit : Math.min(credit, partial);
      await m.save(m.create(CustomerLedger, { customerId: s.customerId, type: CustomerLedgerType.REFUND, amount: -round2(back), invoiceId: cn.id, reference: cn.number, userId: actor.id }));
    }
    if (partial === null) await m.query(`UPDATE customer SET loyalty_points = GREATEST(0, loyalty_points + $2 - $3) WHERE id = $1`, [s.customerId, s.pointsRedeemed, s.pointsEarned]);
  }

  // ------------------------------------------------------------------ till catalog and search

  /**
   * Everything a till needs to keep selling offline: sellable items with
   * prices (default list and promotions applied), sales class, limits, stock
   * and reorder level; customers; payment modes. Refresh it while online.
   */
  async catalog(terminalId: string, actor: SessionUser) {
    return this.ds.transaction(async (m) => {
      const terminal = await this.terminal(m, terminalId);
      const list = terminal.defaultPriceListId ? await m.findOneByOrFail(PriceList, { id: terminal.defaultPriceListId }) : await this.billing.defaultPriceList(m);
      const rows: { id: string }[] = await m.query(
        `SELECT DISTINCT i.id FROM item i JOIN stock_balance sb ON sb.item_id = i.id AND sb.store_id = $1 WHERE i.is_active AND sb.on_hand > 0`,
        [terminal.storeId],
      );
      const lines = rows.length ? (await this.quote(m, { terminal, customer: null, priceListId: list.id, lines: rows.map((r) => ({ itemId: r.id, quantity: 1 })), actor })).lines : [];
      const meta: { id: string; barcode: string | null; gtin: string | null; max_qty_per_sale: string | null; uom: string | null }[] = rows.length
        ? await m.query(`SELECT i.id, i.barcode, i.gtin, g.max_qty_per_sale, u.code AS uom FROM item i LEFT JOIN generic g ON g.id = i.generic_id LEFT JOIN unit_of_measure u ON u.id = i.base_uom_id WHERE i.id = ANY($1::uuid[])`, [rows.map((r) => r.id)])
        : [];
      const customers = await m.query(`SELECT id, code, name, phone, price_list_id AS "priceListId", credit_allowed AS "creditAllowed", loyalty_points AS "loyaltyPoints" FROM customer WHERE is_active ORDER BY name LIMIT 5000`);
      const modes = await m.query(`SELECT code, name, requires_reference AS "requiresReference" FROM payment_mode WHERE is_active AND code IN ('CASH', 'MPESA', 'CARD', 'CREDIT') ORDER BY code`);
      return {
        terminal: { id: terminal.id, code: terminal.code, name: terminal.name, storeId: terminal.storeId },
        priceList: { id: list.id, code: list.code, name: list.name },
        snapshotAt: new Date().toISOString(),
        items: lines.map((l) => {
          const x = meta.find((y) => y.id === l.itemId);
          return { itemId: l.itemId, code: l.code, name: l.name, generic: l.generic, barcode: x?.barcode ?? null, gtin: x?.gtin ?? null, uom: x?.uom ?? null, salesClass: l.salesClass, price: l.listPrice, promotion: l.promotion, maxQtyPerSale: x?.max_qty_per_sale ? Number(x.max_qty_per_sale) : null, available: l.available, lowStock: l.lowStock };
        }),
        customers,
        paymentModes: modes,
        discountLimit: await this.discountLimit(m, actor),
      };
    });
  }

  /** Till search: name, generic, code, barcode or GTIN; with price, class and stock at the till's store. */
  async searchItems(terminalId: string, q: string, actor: SessionUser) {
    return this.ds.transaction(async (m) => {
      const terminal = await this.terminal(m, terminalId);
      const term = q.trim();
      const rows: { id: string }[] = await m.query(
        `SELECT i.id FROM item i LEFT JOIN generic g ON g.id = i.generic_id
          WHERE i.is_active AND (i.gtin = $1 OR i.barcode = $1 OR i.code ILIKE $1 OR i.name ILIKE $2 OR i.brand_name ILIKE $2 OR g.inn_name ILIKE $2)
          ORDER BY (i.gtin = $1 OR i.barcode = $1 OR i.code ILIKE $1) DESC, i.name LIMIT 25`,
        [term, `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
      );
      if (!rows.length) return [];
      const quote = await this.quote(m, { terminal, customer: null, lines: rows.map((r) => ({ itemId: r.id, quantity: 1 })), actor });
      return quote.lines.map((l) => ({ itemId: l.itemId, code: l.code, name: l.name, generic: l.generic, salesClass: l.salesClass, price: l.listPrice, promotion: l.promotion, available: l.available, lowStock: l.lowStock }));
    });
  }

  saleIdsByInvoice(invoiceIds: string[]) {
    return this.ds.getRepository(PosSale).find({ where: { invoiceId: In(invoiceIds) } });
  }
}
