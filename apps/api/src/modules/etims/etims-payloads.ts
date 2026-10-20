import { round2, TAX_TYPES } from '../billing/tax-calc';
import { etimsDate, etimsDateTime, PROGRESS, PURCHASE_RECEIPT_TYPE, RECEIPT_TYPE, REGISTRATION_TYPE, SALES_TYPE } from './etims-spec';

/** Who registered / modified the record (regrId/regrNm/modrId/modrNm are mandatory in every save). */
export interface Actor {
  id: string;
  name: string;
}

const actorFields = (a: Actor) => ({ regrId: a.id.slice(0, 20), regrNm: a.name.slice(0, 60), modrId: a.id.slice(0, 20), modrNm: a.name.slice(0, 60) });

export interface SaleLine {
  itemCd: string;
  itemClsCd: string;
  itemNm: string;
  bcd: string | null;
  pkgUnitCd: string;
  qtyUnitCd: string;
  qty: number;
  /** VAT inclusive unit price. */
  prc: number;
  splyAmt: number;
  dcRt: number;
  dcAmt: number;
  taxTyCd: string;
  taxblAmt: number;
  taxAmt: number;
  totAmt: number;
  isrccCd?: string | null;
  isrccNm?: string | null;
  isrcRt?: number | null;
  isrcAmt?: number | null;
}

export interface SaleInput {
  trdInvcNo: string;
  invcNo: number;
  /** Credit notes: the original invoice's invcNo. */
  orgInvcNo: number;
  isCreditNote: boolean;
  creditReasonCode?: string | null;
  custTin: string | null;
  custNm: string | null;
  custMblNo: string | null;
  pmtTyCd: string;
  issuedAt: Date;
  /** Rates per tax type A..E. */
  rates: Record<string, number>;
  lines: SaleLine[];
  remark?: string | null;
  timeZone: string;
  actor: Actor;
}

/** TrnsSalesSaveWrReq (saveTrnsSalesOsdc) without tin/bhfId (added by the adapter). */
export function buildSalePayload(s: SaleInput): Record<string, unknown> {
  const dt = etimsDateTime(s.issuedAt, s.timeZone);
  const head: Record<string, unknown> = {
    trdInvcNo: s.trdInvcNo,
    invcNo: s.invcNo,
    orgInvcNo: s.orgInvcNo,
    custTin: s.custTin,
    custNm: s.custNm,
    salesTyCd: SALES_TYPE.NORMAL,
    rcptTyCd: s.isCreditNote ? RECEIPT_TYPE.CREDIT_NOTE : RECEIPT_TYPE.SALE,
    pmtTyCd: s.pmtTyCd,
    salesSttsCd: s.isCreditNote ? PROGRESS.CREDIT_NOTE : PROGRESS.APPROVED,
    cfmDt: dt,
    salesDt: etimsDate(s.issuedAt, s.timeZone),
    stockRlsDt: dt,
    cnclReqDt: null,
    cnclDt: null,
    rfdDt: s.isCreditNote ? dt : null,
    rfdRsnCd: s.isCreditNote ? (s.creditReasonCode ?? '06') : null,
    totItemCnt: s.lines.length,
  };
  for (const t of TAX_TYPES) {
    const ls = s.lines.filter((l) => l.taxTyCd === t);
    head[`taxblAmt${t}`] = round2(ls.reduce((a, l) => a + l.taxblAmt, 0));
  }
  for (const t of TAX_TYPES) head[`taxRt${t}`] = s.rates[t] ?? 0;
  for (const t of TAX_TYPES) {
    const ls = s.lines.filter((l) => l.taxTyCd === t);
    head[`taxAmt${t}`] = round2(ls.reduce((a, l) => a + l.taxAmt, 0));
  }
  head.totTaxblAmt = round2(s.lines.reduce((a, l) => a + l.taxblAmt, 0));
  head.totTaxAmt = round2(s.lines.reduce((a, l) => a + l.taxAmt, 0));
  head.totAmt = round2(s.lines.reduce((a, l) => a + l.totAmt, 0));
  head.prchrAcptcYn = 'N';
  head.remark = s.remark ?? null;
  Object.assign(head, actorFields(s.actor));
  head.receipt = { custTin: s.custTin, custMblNo: s.custMblNo, rcptPbctDt: dt, trdeNm: null, adrs: null, topMsg: null, btmMsg: null, prchrAcptcYn: 'N' };
  head.itemList = s.lines.map((l, i) => ({
    itemSeq: i + 1,
    itemCd: l.itemCd,
    itemClsCd: l.itemClsCd,
    itemNm: l.itemNm.slice(0, 200),
    bcd: l.bcd,
    pkgUnitCd: l.pkgUnitCd,
    pkg: l.qty,
    qtyUnitCd: l.qtyUnitCd,
    qty: l.qty,
    prc: l.prc,
    splyAmt: l.splyAmt,
    dcRt: l.dcRt,
    dcAmt: l.dcAmt,
    isrccCd: l.isrccCd ?? null,
    isrccNm: l.isrccNm ?? null,
    isrcRt: l.isrcRt ?? null,
    isrcAmt: l.isrcAmt ?? null,
    taxTyCd: l.taxTyCd,
    taxblAmt: l.taxblAmt,
    taxAmt: l.taxAmt,
    totAmt: l.totAmt,
  }));
  return head;
}

/** ItemSaveReq (saveItem). */
export function buildItemPayload(i: {
  itemCd: string;
  itemClsCd: string;
  itemTyCd: string;
  itemNm: string;
  orgnNatCd: string;
  pkgUnitCd: string;
  qtyUnitCd: string;
  taxTyCd: string;
  bcd: string | null;
  dftPrc: number;
  insuranceApplicable: boolean;
  actor: Actor;
}): Record<string, unknown> {
  return {
    itemCd: i.itemCd,
    itemClsCd: i.itemClsCd,
    itemTyCd: i.itemTyCd,
    itemNm: i.itemNm.slice(0, 200),
    itemStdNm: null,
    orgnNatCd: i.orgnNatCd,
    pkgUnitCd: i.pkgUnitCd,
    qtyUnitCd: i.qtyUnitCd,
    taxTyCd: i.taxTyCd,
    btchNo: null,
    bcd: i.bcd,
    dftPrc: round2(i.dftPrc),
    grpPrcL1: null,
    grpPrcL2: null,
    grpPrcL3: null,
    grpPrcL4: null,
    grpPrcL5: null,
    addInfo: null,
    sftyQty: null,
    isrcAplcbYn: i.insuranceApplicable ? 'Y' : 'N',
    useYn: 'Y',
    ...actorFields(i.actor),
  };
}

export interface StockLine {
  itemCd: string;
  itemClsCd: string;
  itemNm: string;
  bcd: string | null;
  pkgUnitCd: string;
  qtyUnitCd: string;
  qty: number;
  itemExprDt: string | null;
  prc: number;
  taxTyCd: string;
  taxRate: number;
}

/** StockIOSaveReq (insertStockIO). Amounts are VAT inclusive at the given unit price. */
export function buildStockIOPayload(s: {
  sarNo: number;
  sarTyCd: string;
  ocrnDt: string;
  custTin?: string | null;
  custNm?: string | null;
  custBhfId?: string | null;
  remark?: string | null;
  lines: StockLine[];
  actor: Actor;
}): Record<string, unknown> {
  const itemList = s.lines.map((l, i) => {
    const amt = round2(l.qty * l.prc);
    const tax = l.taxRate > 0 ? round2((amt * l.taxRate) / (100 + l.taxRate)) : 0;
    return {
      itemSeq: i + 1,
      itemCd: l.itemCd,
      itemClsCd: l.itemClsCd,
      itemNm: l.itemNm.slice(0, 200),
      bcd: l.bcd,
      pkgUnitCd: l.pkgUnitCd,
      pkg: l.qty,
      qtyUnitCd: l.qtyUnitCd,
      qty: l.qty,
      itemExprDt: l.itemExprDt,
      prc: round2(l.prc),
      splyAmt: amt,
      totDcAmt: 0,
      taxblAmt: amt,
      taxTyCd: l.taxTyCd,
      taxAmt: tax,
      totAmt: amt,
    };
  });
  return {
    sarNo: s.sarNo,
    orgSarNo: s.sarNo,
    regTyCd: REGISTRATION_TYPE.AUTOMATIC,
    custTin: s.custTin ?? null,
    custNm: s.custNm ?? null,
    custBhfId: s.custBhfId ?? null,
    sarTyCd: s.sarTyCd,
    ocrnDt: s.ocrnDt,
    totItemCnt: itemList.length,
    totTaxblAmt: round2(itemList.reduce((a, l) => a + l.taxblAmt, 0)),
    totTaxAmt: round2(itemList.reduce((a, l) => a + l.taxAmt, 0)),
    totAmt: round2(itemList.reduce((a, l) => a + l.totAmt, 0)),
    remark: s.remark ?? null,
    ...actorFields(s.actor),
    itemList,
  };
}

/** StockMasterSaveReq (saveStockMaster). */
export const buildStockMasterPayload = (itemCd: string, rsdQty: number, actor: Actor) => ({ itemCd, rsdQty: round2(rsdQty), ...actorFields(actor) });

/** TrnsPurchaseSaveReq (insertTrnsPurchase): confirm (02) or reject (04) a supplier's sale. */
export function buildPurchasePayload(p: {
  invcNo: number;
  spplrTin: string;
  spplrBhfId: string | null;
  spplrNm: string | null;
  spplrInvcNo: string;
  accept: boolean;
  pmtTyCd: string;
  salesDt: string | null;
  at: Date;
  timeZone: string;
  totals: Record<string, number>;
  items: Record<string, unknown>[];
  remark?: string | null;
  actor: Actor;
}): Record<string, unknown> {
  const dt = etimsDateTime(p.at, p.timeZone);
  const body: Record<string, unknown> = {
    invcNo: p.invcNo,
    orgInvcNo: 0,
    spplrTin: p.spplrTin,
    spplrBhfId: p.spplrBhfId,
    spplrNm: p.spplrNm,
    spplrInvcNo: Number(p.spplrInvcNo) || p.spplrInvcNo,
    regTyCd: REGISTRATION_TYPE.MANUAL,
    pchsTyCd: SALES_TYPE.NORMAL,
    rcptTyCd: PURCHASE_RECEIPT_TYPE.PURCHASE,
    pmtTyCd: p.pmtTyCd,
    pchsSttsCd: p.accept ? PROGRESS.APPROVED : PROGRESS.CANCELLED,
    cfmDt: dt,
    pchsDt: p.salesDt ?? etimsDate(p.at, p.timeZone),
    wrhsDt: p.accept ? dt : '',
    cnclReqDt: '',
    cnclDt: p.accept ? '' : dt,
    rfdDt: '',
    totItemCnt: p.items.length,
  };
  for (const k of ['taxblAmtA', 'taxblAmtB', 'taxblAmtC', 'taxblAmtD', 'taxblAmtE', 'taxRtA', 'taxRtB', 'taxRtC', 'taxRtD', 'taxRtE', 'taxAmtA', 'taxAmtB', 'taxAmtC', 'taxAmtD', 'taxAmtE', 'totTaxblAmt', 'totTaxAmt', 'totAmt']) {
    body[k] = p.totals[k] ?? 0;
  }
  body.remark = p.remark ?? null;
  Object.assign(body, actorFields(p.actor));
  body.itemList = p.items.map((it, i) => ({
    itemSeq: i + 1,
    itemCd: it.itemCd ?? null,
    itemClsCd: it.itemClsCd ?? null,
    itemNm: it.itemNm,
    bcd: it.bcd ?? null,
    spplrItemClsCd: it.itemClsCd ?? null,
    spplrItemCd: it.itemCd ?? null,
    spplrItemNm: it.itemNm,
    pkgUnitCd: it.pkgUnitCd,
    pkg: it.pkg,
    qtyUnitCd: it.qtyUnitCd,
    qty: it.qty,
    prc: it.prc,
    splyAmt: it.splyAmt,
    dcRt: it.dcRt ?? 0,
    dcAmt: it.dcAmt ?? 0,
    taxblAmt: it.taxblAmt,
    taxTyCd: it.taxTyCd,
    taxAmt: it.taxAmt,
    totAmt: it.totAmt,
    itemExprDt: null,
  }));
  return body;
}

/** Masks credentials in logged requests. */
export function maskSecrets(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  for (const k of ['cmcKey', 'pwd']) if (k in out && out[k]) out[k] = '***';
  if (out.data && typeof out.data === 'object' && 'info' in (out.data as object)) {
    const info = { ...((out.data as Record<string, Record<string, unknown>>).info ?? {}) };
    if (info.cmcKey) info.cmcKey = '***';
    out.data = { ...(out.data as object), info };
  }
  return out;
}
