import { randomBytes } from 'node:crypto';
import { CODE_CLASSES, ETIMS_PATHS, etimsDateTime, EtimsOperation, RESULT } from '../etims-spec';

/**
 * A fake KRA eTIMS control unit for development and tests. It speaks the
 * OSCU/VSCU JSON protocol, keeps its own state (devices, registered items,
 * received sales with receipt numbers, stock movements, purchases offered by
 * suppliers, import declarations) and can be told to fail:
 *   timeout  – never answers (the client times out)
 *   http500  – answers HTTP 503
 *   business – answers resultCd <code> (a KRA business error)
 *   offline  – refuses the connection (HTTP server) / throws (in-process)
 * for the next `count` requests or until `until`.
 * DEMO DATA: code tables and item classes are a small illustrative subset, not KRA's full lists.
 */

export type FailureMode = 'timeout' | 'http500' | 'business' | 'offline';
export interface Failure {
  mode: FailureMode;
  count?: number;
  until?: string;
  resultCd?: string;
  resultMsg?: string;
  /** Only fail these operations (default: all). */
  operations?: EtimsOperation[];
}

export interface MockReply {
  status: number;
  body?: Record<string, unknown>;
  /** Simulated network failure. */
  network?: 'timeout' | 'offline';
}

/** KRA's servers stamp East Africa Time (the mock stands in for them, so this is not a local setting). */
const KRA_TIME_ZONE = 'Africa/Nairobi';
const now14 = () => etimsDateTime(new Date(), KRA_TIME_ZONE);
const b32 = (n: number) => randomBytes(n).toString('base64').replace(/[^A-Z2-7]/gi, '').toUpperCase().padEnd(n, 'Q').slice(0, n);

const CODE_TABLES: { cdCls: string; cdClsNm: string; codes: [cd: string, nm: string, userDfnCd1?: string][] }[] = [
  { cdCls: CODE_CLASSES.TAX_TYPE, cdClsNm: 'Taxation Type', codes: [['A', 'A-Exempt', '0'], ['B', 'B-16.00%', '16'], ['C', 'C-0%', '0'], ['D', 'D-Non-VAT', '0'], ['E', 'E-8%', '8']] },
  { cdCls: CODE_CLASSES.COUNTRY, cdClsNm: 'Nation', codes: [['KE', 'Kenya'], ['IN', 'India'], ['CN', 'China'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['US', 'United States'], ['ZA', 'South Africa'], ['UG', 'Uganda'], ['TZ', 'Tanzania']] },
  { cdCls: CODE_CLASSES.PAYMENT_TYPE, cdClsNm: 'Payment Type', codes: [['01', 'CASH'], ['02', 'CREDIT'], ['03', 'CASH/CREDIT'], ['04', 'BANK CHECK'], ['05', 'DEBIT&CREDIT CARD'], ['06', 'MOBILE MONEY'], ['07', 'OTHER']] },
  {
    cdCls: CODE_CLASSES.QTY_UNIT,
    cdClsNm: 'Quantity Unit',
    codes: [['U', 'Pieces/item [Number]'], ['4B', 'Pair'], ['AV', 'Cap'], ['BX', 'box'], ['GRM', 'Gram'], ['KG', 'Kilo-Gramme'], ['L', 'Litre'], ['MGM', 'milligram'], ['PA', 'packet'], ['RO', 'roll'], ['SET', 'set'], ['TU', 'tube'], ['NO', 'Number']],
  },
  {
    cdCls: CODE_CLASSES.PACKAGING_UNIT,
    cdClsNm: 'Packaging Unit',
    codes: [['NT', 'Net'], ['AM', 'Ampoule'], ['BG', 'Bag'], ['BQ', 'Bottle, protected cylindrical'], ['BV', 'Bottle, bulbous'], ['CT', 'Carton'], ['JR', 'Jar'], ['OU', 'Non-Exterior Packaging Unit'], ['PU', 'Traypack'], ['RO', 'Roll']],
  },
  { cdCls: CODE_CLASSES.PRODUCT_TYPE, cdClsNm: 'Product Type', codes: [['1', 'Raw Material'], ['2', 'Finished Product'], ['3', 'Service']] },
  { cdCls: CODE_CLASSES.CREDIT_NOTE_REASON, cdClsNm: 'Credit Note Reason', codes: [['01', 'Missing Quantity'], ['02', 'Missing data'], ['03', 'Damaged'], ['04', 'Wasted'], ['05', 'Raw Material Shortage'], ['06', 'Refund']] },
  { cdCls: CODE_CLASSES.SALES_RECEIPT_TYPE, cdClsNm: 'Sales Receipt Type', codes: [['S', 'Sale'], ['R', 'Credit Note after Sale']] },
  {
    cdCls: CODE_CLASSES.STOCK_IO_TYPE,
    cdClsNm: 'Stock Movement Type',
    codes: [['01', 'Import'], ['02', 'Purchase'], ['03', 'Return'], ['04', 'Stock Movement'], ['05', 'Processing'], ['06', 'Adjustment'], ['11', 'Sale'], ['12', 'Return'], ['13', 'Stock Movement'], ['14', 'Processing'], ['15', 'Discarding'], ['16', 'Adjustment']],
  },
];

const ITEM_CLASSES: [cd: string, nm: string, lvl: number, tax: string | null][] = [
  ['5100000000', 'Drugs and Pharmaceutical Products (demo)', 1, null],
  ['5110000000', 'Anti-infective drugs (demo)', 2, 'A'],
  ['5114000000', 'Central nervous system drugs (demo)', 2, 'A'],
  ['5112000000', 'Cardiovascular drugs (demo)', 2, 'A'],
  ['5118000000', 'Hormones and hormone antagonists (demo)', 2, 'A'],
  ['5119000000', 'Agents affecting water and electrolytes (demo)', 2, 'A'],
  ['5120000000', 'Immunomodulating drugs and vaccines (demo)', 2, 'A'],
  ['5130000000', 'Analgesics and anti-inflammatories (demo)', 2, 'A'],
  ['4200000000', 'Medical Equipment and Accessories and Supplies (demo)', 1, null],
  ['4214000000', 'Patient care and treatment products and supplies (demo)', 2, 'B'],
  ['4213000000', 'Medical fabrics and gloves (demo)', 2, 'B'],
  ['4229000000', 'Surgical products (demo)', 2, 'B'],
  ['4127000000', 'Laboratory supplies (demo)', 2, 'B'],
  ['8510000000', 'Comprehensive health services (demo)', 1, 'A'],
];

const OP_BY_PATH = new Map<string, EtimsOperation>(
  (['OSCU', 'VSCU'] as const).flatMap((k) => Object.entries(ETIMS_PATHS[k]).map(([op, path]) => [path, op as EtimsOperation] as const)),
);

export class MockEtims {
  failure: Failure | null = null;
  readonly devices = new Map<string, { cmcKey: string; sdcId: string; mrcNo: string; rcptNo: number }>();
  readonly items = new Map<string, Record<string, unknown>>();
  /** key tin|bhfId|invcNo → request + response */
  readonly sales = new Map<string, { request: Record<string, unknown>; response: Record<string, unknown> }>();
  readonly stockIO: Record<string, unknown>[] = [];
  readonly stockMaster: Record<string, unknown>[] = [];
  readonly purchaseConfirmations: Record<string, unknown>[] = [];
  /** Supplier sales to a buyer PIN, offered by selectTrnsPurchaseSalesList. */
  readonly offeredPurchases: (Record<string, unknown> & { buyerTin: string; at: string })[] = [];
  readonly imports: (Record<string, unknown> & { buyerTin: string })[] = [];
  readonly importUpdates: Record<string, unknown>[] = [];
  requests = 0;

  operationFor(path: string): EtimsOperation | undefined {
    return OP_BY_PATH.get(path.replace(/\/+$/, ''));
  }

  private failing(op: EtimsOperation): Failure | null {
    const f = this.failure;
    if (!f) return null;
    if (f.until && new Date(f.until) < new Date()) {
      this.failure = null;
      return null;
    }
    if (f.operations?.length && !f.operations.includes(op)) return null;
    if (f.count !== undefined) {
      if (f.count <= 0) {
        this.failure = null;
        return null;
      }
      f.count--;
    }
    return f;
  }

  private ok(data: Record<string, unknown> | null = null): MockReply {
    return { status: 200, body: { resultCd: RESULT.OK, resultMsg: 'It is succeeded', resultDt: now14(), data } };
  }

  private err(resultCd: string, resultMsg: string): MockReply {
    return { status: 200, body: { resultCd, resultMsg, resultDt: now14(), data: null } };
  }

  handle(op: EtimsOperation, headers: Record<string, string | undefined>, body: Record<string, unknown>): MockReply {
    this.requests++;
    const f = this.failing(op);
    if (f?.mode === 'timeout') return { status: 0, network: 'timeout' };
    if (f?.mode === 'offline') return { status: 0, network: 'offline' };
    if (f?.mode === 'http500') return { status: 503, body: { message: 'Service temporarily unavailable (mock)' } };
    if (f?.mode === 'business') return this.err(f.resultCd ?? '921', f.resultMsg ?? 'Sales or sales invoice data which is declared cannot be received. (mock)');

    const tin = String(body.tin ?? headers.tin ?? '');
    const bhfId = String(body.bhfId ?? headers.bhfid ?? headers.bhfId ?? '');
    if (!tin || !bhfId) return this.err('900', 'There is no Header information');
    const devKey = `${tin}|${bhfId}`;

    if (op === 'init') {
      if (!body.dvcSrlNo) return this.err('910', 'Request parameter error');
      let d = this.devices.get(devKey);
      if (!d) {
        d = { cmcKey: randomBytes(16).toString('hex'), sdcId: `KRACU0${String(this.devices.size + 1).padStart(9, '0')}`, mrcNo: `WIS0${String(this.devices.size + 1).padStart(7, '0')}`, rcptNo: 0 };
        this.devices.set(devKey, d);
      }
      return this.ok({
        info: { tin, taxprNm: 'SAMPLE HOSPITAL (mock)', bsnsActv: 'Health', bhfId, bhfNm: bhfId === '00' ? 'Headquarter' : `Branch ${bhfId}`, bhfOpenDt: '20200101',
          prvncNm: 'NAIROBI CITY', dstrtNm: 'WESTLANDS', sctrNm: 'WON', locDesc: 'Mock', hqYn: bhfId === '00' ? 'Y' : 'N', mgrNm: 'Mock', mgrTelNo: '0700000000', mgrEmail: 'mock@example.com',
          dvcId: `${tin}${bhfId}01`, sdcId: d.sdcId, mrcNo: d.mrcNo, cmcKey: d.cmcKey },
      });
    }
    const device = this.devices.get(devKey);
    if (!device) return this.err('901', 'It is not valid device');
    if ((headers.cmckey ?? headers.cmcKey) !== device.cmcKey) return this.err('900', 'There is no Header information (cmcKey)');

    switch (op) {
      case 'codes':
        return this.ok({
          clsList: CODE_TABLES.map((t) => ({
            cdCls: t.cdCls, cdClsNm: t.cdClsNm, cdClsDesc: null, useYn: 'Y', userDfnNm1: null, userDfnNm2: null, userDfnNm3: null,
            dtlList: t.codes.map(([cd, cdNm, u1], i) => ({ cd, cdNm, cdDesc: cdNm, useYn: 'Y', srtOrd: i + 1, userDfnCd1: u1 ?? null, userDfnCd2: null, userDfnCd3: null })),
          })),
        });
      case 'itemClasses':
        return this.ok({ itemClsList: ITEM_CLASSES.map(([itemClsCd, itemClsNm, itemClsLvl, taxTyCd]) => ({ itemClsCd, itemClsNm, itemClsLvl, taxTyCd, mjrTgYn: 'N', useYn: 'Y' })) });
      case 'saveItem': {
        for (const k of ['itemCd', 'itemClsCd', 'itemNm', 'pkgUnitCd', 'qtyUnitCd', 'taxTyCd', 'orgnNatCd', 'itemTyCd']) {
          if (!body[k]) return this.err('910', `Request parameter error: ${k}`);
        }
        if (!['A', 'B', 'C', 'D', 'E'].includes(String(body.taxTyCd))) return this.err('910', 'Request parameter error: taxTyCd');
        this.items.set(`${devKey}|${body.itemCd}`, body);
        return this.ok();
      }
      case 'saveSale': {
        const key = `${devKey}|${body.invcNo}`;
        const prev = this.sales.get(key);
        if (prev) {
          // Same invoice resent (e.g. after a lost response): hand back the original result.
          if (JSON.stringify({ ...prev.request, receipt: undefined }) === JSON.stringify({ ...body, receipt: undefined })) return this.ok(prev.response);
          return this.err(RESULT.DUPLICATE, 'There is an overlapped Data');
        }
        const items = (body.itemList as Record<string, unknown>[]) ?? [];
        for (const it of items) {
          if (!this.items.has(`${devKey}|${it.itemCd}`)) return this.err('910', `Request parameter error: item ${it.itemCd} is not registered`);
        }
        for (const t of ['A', 'B', 'C', 'D', 'E']) {
          const sum = items.filter((i) => i.taxTyCd === t).reduce((s, i) => s + Number(i.taxblAmt), 0);
          if (Math.abs(sum - Number(body[`taxblAmt${t}`] ?? 0)) > 0.01) return this.err('910', `Request parameter error: taxblAmt${t}`);
        }
        if (body.rcptTyCd === 'R' && !this.sales.has(`${devKey}|${body.orgInvcNo}`)) return this.err('910', 'Request parameter error: orgInvcNo');
        device.rcptNo++;
        const response = { curRcptNo: device.rcptNo, totRcptNo: device.rcptNo, intrlData: b32(26), rcptSign: b32(16), sdcDateTime: now14() };
        this.sales.set(key, { request: body, response });
        return this.ok(response);
      }
      case 'stockIO': {
        for (const it of (body.itemList as Record<string, unknown>[]) ?? []) {
          if (!this.items.has(`${devKey}|${it.itemCd}`)) return this.err('910', `Request parameter error: item ${it.itemCd} is not registered`);
        }
        this.stockIO.push(body);
        return this.ok();
      }
      case 'stockMaster':
        if (!this.items.has(`${devKey}|${body.itemCd}`)) return this.err('910', `Request parameter error: item ${body.itemCd} is not registered`);
        this.stockMaster.push(body);
        return this.ok();
      case 'purchases': {
        const since = String(body.lastReqDt ?? '00000000000000');
        const list = this.offeredPurchases.filter((p) => p.buyerTin === tin && p.at > since).map(({ buyerTin: _b, at: _a, ...p }) => p);
        return list.length ? this.ok({ saleList: list }) : this.err(RESULT.NO_DATA, 'There is no search result');
      }
      case 'savePurchase':
        this.purchaseConfirmations.push(body);
        return this.ok();
      case 'imports': {
        const list = this.imports.filter((p) => p.buyerTin === tin).map(({ buyerTin: _b, ...p }) => p);
        return list.length ? this.ok({ itemList: list }) : this.err(RESULT.NO_DATA, 'There is no search result');
      }
      case 'updateImport':
        this.importUpdates.push(body);
        return this.ok();
      case 'items':
        return this.ok({ itemList: [...this.items.entries()].filter(([k]) => k.startsWith(devKey)).map(([, v]) => v) });
      case 'customer':
        return this.ok({ custList: [{ tin: body.custmTin, taxprNm: `TAXPAYER ${body.custmTin} (mock)`, taxprSttsCd: 'A', prvncNm: 'NAIROBI CITY', dstrtNm: '', sctrNm: '', locDesc: '' }] });
      case 'notices':
        return this.err(RESULT.NO_DATA, 'There is no search result');
      default:
        return this.err('912', 'There is a request Method error.');
    }
  }

  /** Test helper: a supplier's sale to `buyerTin` appears on eTIMS. */
  offerPurchase(buyerTin: string, sale: Record<string, unknown>) {
    this.offeredPurchases.push({ ...sale, buyerTin, at: now14() });
  }

  reset() {
    this.failure = null;
    this.devices.clear();
    this.items.clear();
    this.sales.clear();
    this.stockIO.length = 0;
    this.stockMaster.length = 0;
    this.purchaseConfirmations.length = 0;
    this.offeredPurchases.length = 0;
    this.imports.length = 0;
    this.importUpdates.length = 0;
    this.requests = 0;
  }
}

/** The process-wide mock used by the in-process adapter (tests, dev without the container). */
export const sharedMockEtims = new MockEtims();
