/**
 * KRA eTIMS protocol constants, taken from the KRA specifications
 * "OSCU Requirements & Communication Protocols v2.0" (April 2023),
 * "VSCU Specification v2.0" and "Technical Specification of TIS for OSCU/VSCU v2.0"
 * (kra.go.ke/images/publications). Field names in the payload builders follow
 * those documents exactly. Everything the documents leave open is listed in
 * ETIMS_ASSUMPTIONS below — the single place to review before certification.
 */

export type EtimsOperation =
  | 'init'
  | 'codes'
  | 'itemClasses'
  | 'customer'
  | 'saveItem'
  | 'items'
  | 'saveSale'
  | 'purchases'
  | 'savePurchase'
  | 'stockIO'
  | 'stockMaster'
  | 'imports'
  | 'updateImport'
  | 'notices';

/** Endpoint paths (relative to the configured base URL) per control-unit type. */
export const ETIMS_PATHS: Record<'OSCU' | 'VSCU', Record<EtimsOperation, string>> = {
  OSCU: {
    init: '/selectInitOsdcInfo',
    codes: '/selectCodeList',
    itemClasses: '/selectItemClsList',
    customer: '/selectCustomer',
    saveItem: '/saveItem',
    items: '/selectItemList',
    saveSale: '/saveTrnsSalesOsdc',
    purchases: '/selectTrnsPurchaseSalesList',
    savePurchase: '/insertTrnsPurchase',
    stockIO: '/insertStockIO',
    stockMaster: '/saveStockMaster',
    imports: '/selectImportItemList',
    updateImport: '/updateImportItem',
    notices: '/selectNoticeList',
  },
  VSCU: {
    init: '/initializer/selectInitInfo',
    codes: '/code/selectCodes',
    itemClasses: '/itemClass/selectItemsClass',
    customer: '/customers/selectCustomer',
    saveItem: '/items/saveItems',
    items: '/items/selectItems',
    saveSale: '/trnsSales/saveSales',
    purchases: '/trnsPurchase/selectTrnsPurchaseSales',
    savePurchase: '/trnsPurchase/savePurchases',
    stockIO: '/stock/saveStockItems',
    stockMaster: '/stockMaster/saveStockMaster',
    imports: '/imports/selectImportItems',
    updateImport: '/imports/updateImportItems',
    notices: '/notices/selectNotices',
  },
};

/** Default base URLs from the OSCU spec (VSCU runs at the hospital; its URL is configured). */
export const OSCU_BASE_URLS = {
  production: 'https://etims-api.kra.go.ke/etims-api',
  test: 'https://etims-api-sbx.kra.go.ke/etims-api',
};

/** API response codes (spec 4.18). */
export const RESULT = {
  OK: '000',
  NO_DATA: '001',
  DUPLICATE: '994',
} as const;

/** Server-side result codes that will not succeed on retry (business errors: fix data, then reprocess). */
export const NON_RETRYABLE = new Set(['900', '901', '902', '903', '910', '911', '912', '921', '922', '991', '992', '993']);

/** Code classes synchronised from selectCodeList (spec chapter 4). */
export const CODE_CLASSES = {
  TAX_TYPE: '04',
  COUNTRY: '05',
  PAYMENT_TYPE: '07',
  QTY_UNIT: '10',
  TRANSACTION_PROGRESS: '11',
  STOCK_IO_TYPE: '12',
  TRANSACTION_TYPE: '14',
  PACKAGING_UNIT: '17',
  PRODUCT_TYPE: '24',
  CREDIT_NOTE_REASON: '32',
  CURRENCY: '33',
  SALES_RECEIPT_TYPE: '37',
  PURCHASE_RECEIPT_TYPE: '38',
} as const;

export const SALES_TYPE = { NORMAL: 'N', COPY: 'C', PROFORMA: 'P', TRAINING: 'T' } as const;
export const RECEIPT_TYPE = { SALE: 'S', CREDIT_NOTE: 'R' } as const;
export const PURCHASE_RECEIPT_TYPE = { PURCHASE: 'P', CREDIT_NOTE: 'R' } as const;
/** Transaction progress (4.12): 02 approved, 04 cancelled, 05 credit note generated. */
export const PROGRESS = { WAITING: '01', APPROVED: '02', CANCEL_REQUESTED: '03', CANCELLED: '04', CREDIT_NOTE: '05', TRANSFERRED: '06' } as const;
export const PRODUCT_TYPE = { RAW: '1', FINISHED: '2', SERVICE: '3' } as const;
export const REGISTRATION_TYPE = { AUTOMATIC: 'A', MANUAL: 'M' } as const;
/** Stock in/out types (4.15). */
export const SAR_TYPE = {
  IN_IMPORT: '01',
  IN_PURCHASE: '02',
  IN_RETURN: '03',
  IN_STOCK_MOVEMENT: '04',
  IN_PROCESSING: '05',
  IN_ADJUSTMENT: '06',
  OUT_SALE: '11',
  OUT_RETURN: '12',
  OUT_STOCK_MOVEMENT: '13',
  OUT_PROCESSING: '14',
  OUT_DISCARDING: '15',
  OUT_ADJUSTMENT: '16',
} as const;
/** Import item status (4.16). */
export const IMPORT_STATUS = { UNSENT: '1', WAITING: '2', APPROVED: '3', CANCELLED: '4' } as const;

/** Dates: yyyyMMddHHmmss and yyyyMMdd in the hospital's time zone. */
export function etimsDateTime(d: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}
export const etimsDate = (d: Date, timeZone: string) => etimsDateTime(d, timeZone).slice(0, 8);

/** "ABCDEFGH" → "ABCD-EFGH" (receipts show internal data and signature in groups of 4). */
export const groupsOf4 = (s: string | null | undefined) => (s ?? '').replace(/(.{4})(?=.)/g, '$1-');

/**
 * The single list of interpretation choices made where the KRA documents are
 * silent or ambiguous. Shown on the eTIMS screen and in the README.
 */
export const ETIMS_ASSUMPTIONS: string[] = [
  'Authentication: tin, bhfId and cmcKey are sent as HTTP headers on every call (and tin/bhfId also in the JSON body, as in the spec samples). The spec lists cmcKey as a request attribute but shows no header table.',
  'salesTyCd ("N" normal) is sent on saveTrnsSalesOsdc although it is missing from the attribute table; it appears in the official JSON sample.',
  'Amounts are VAT inclusive: taxblAmtX = VAT-inclusive amount and taxAmtX = taxblAmtX × rate / (100 + rate), rounded to 2 decimals per line — consistent with the spec samples (10,500 at 18% → 1,602).',
  'Tax-type rates (taxRtA..E) are sent from the hospital tax tables (A exempt 0, B 16, C 0, D non-VAT 0, E 8) and refreshed from code class 04 (userDfnCd1) when code tables are synchronised.',
  'CU invoice number on receipts = sdcId (from selectInitOsdcInfo) + "/" + curRcptNo, per TIS spec 6.23.4.',
  'Receipt QR code = https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceptData?Data=<KRA PIN><branch id><receipt signature> (URL shown on the TIS sample receipt). TIS spec 6.23.8 describes a different "#"-separated string; the URL form is used and kept configurable (setting etims.qrUrlTemplate).',
  'invcNo is a per-control-unit sequence starting at 1 and never reused; trdInvcNo is our invoice number. A retry after a timeout resends the same invcNo with the identical payload. The specification does not say what the CU returns for a resend; we assume it either returns the original receipt data or 994 (overlapped data). 994 with receipt data is taken as accepted; 994 without it is a business error (FAILED, shown on the reprocessing screen for manual confirmation). The mock CU returns the original result for an identical resend and 994 for a different payload under the same invcNo.',
  'One control unit per KRA PIN + branch (bhfId), each with its own invcNo sequence; so every selling outlet with an eTIMS configuration is registered as its own KRA branch. Two outlets cannot share a branch.',
  'Credit notes: rcptTyCd "R", orgInvcNo = the original invcNo, salesSttsCd "05", rfdDt = credit date and rfdRsnCd from code class 32 (default 06 Refund).',
  'Stock movements (insertStockIO): sarNo is a per-control-unit sequence, orgSarNo = sarNo for originals; sarTyCd mapping: GRN 02, department/patient returns 03, transfer in 04, adjustment/count up 06, sale/dispense 11, return to supplier 12, transfer out 13, write-off with the disposal reason 15, issues to departments and other decreases 16. Each IO is followed by saveStockMaster with the remaining quantity at the outlet.',
  'Dispenses report stock out (sarTyCd 11) only after the sale was accepted, as the spec requires ("every stock in/out must have its sales invoice sent in advance").',
  'Purchase confirmation (insertTrnsPurchase) uses pchsSttsCd 02 to accept and 04 to reject, pchsTyCd "N", rcptTyCd "P", regTyCd "M"; spplrInvcNo is matched against the supplier invoice number captured locally.',
  'Item codes (itemCd) follow spec 4.19: country (KE) + product type + packaging unit + quantity unit + 7-digit sequence per control unit.',
  'VSCU uses the same JSON payloads as OSCU at the VSCU paths listed in ETIMS_PATHS (VSCU spec v2.0 function list).',
  'lastReqDt (code tables, purchases, imports) is sent in Kenyan time (setting locale.timezone), the time KRA stamps its records with; the next request starts from the previous request time and duplicates are ignored.',
  'Go-live: an outlet reports ledger movements made after its eTIMS configuration was created. Earlier history is not replayed; an item’s stock master is first sent with its first reported movement.',
  'Reverse invoicing (buyer-issued invoices for non-VAT-registered suppliers) is not specified in the OSCU/VSCU v2.0 documents; a hook records the need and queues nothing until KRA publishes the format.',
];
