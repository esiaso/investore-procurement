import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccountingProvider, AccountMappingKind } from '@sil/shared';
import { AccountingService } from '../../modules/accounting/accounting.service';

/** Mock QuickBooks company ids (modules/accounting/qbo.ts) for each local key. */
export const SAMPLE_QBO_MAPPINGS: [AccountMappingKind, string, string][] = [
  ...(['DRUG', 'SVC'] as const).flatMap((c): [AccountMappingKind, string, string][] => [
    [AccountMappingKind.CATEGORY_INVENTORY, c, '30'],
    [AccountMappingKind.CATEGORY_COGS, c, '50'],
    [AccountMappingKind.CATEGORY_INCOME, c, '40'],
    [AccountMappingKind.CATEGORY_CONSUMPTION, c, '60'],
  ]),
  ...(['SUP', 'EQUIP'] as const).flatMap((c): [AccountMappingKind, string, string][] => [
    [AccountMappingKind.CATEGORY_INVENTORY, c, '31'],
    [AccountMappingKind.CATEGORY_COGS, c, '51'],
    [AccountMappingKind.CATEGORY_INCOME, c, '41'],
    [AccountMappingKind.CATEGORY_CONSUMPTION, c, '60'],
  ]),
  [AccountMappingKind.STORE_CLASS, 'MS', '100'],
  [AccountMappingKind.STORE_CLASS, 'MP', '101'],
  [AccountMappingKind.STORE_CLASS, 'OPD-PH', '102'],
  [AccountMappingKind.STORE_CLASS, 'IPD-PH', '103'],
  [AccountMappingKind.DEPARTMENT_CLASS, 'IPD-MED', '110'],
  [AccountMappingKind.DEPARTMENT_CLASS, 'IPD-SURG', '111'],
  [AccountMappingKind.DEPARTMENT_CLASS, 'MAT', '112'],
  [AccountMappingKind.DEPARTMENT_CLASS, 'THEATRE', '113'],
  [AccountMappingKind.TAX_CODE, 'STANDARD', '1'],
  [AccountMappingKind.TAX_CODE, 'EXEMPT', '2'],
  [AccountMappingKind.TAX_CODE, 'ZERO', '3'],
  [AccountMappingKind.PAYMENT_ACCOUNT, 'CASH', '1'],
  [AccountMappingKind.PAYMENT_ACCOUNT, 'MPESA', '2'],
  [AccountMappingKind.PAYMENT_ACCOUNT, 'CARD', '4'],
  [AccountMappingKind.PAYMENT_ACCOUNT, 'LOYALTY', '63'],
  [AccountMappingKind.PAYMENT_ACCOUNT, 'BANK', '3'],
  [AccountMappingKind.PAYMENT_ACCOUNT, 'EFT', '3'],
  [AccountMappingKind.SYSTEM, 'AP', '20'],
  [AccountMappingKind.SYSTEM, 'AR', '10'],
  [AccountMappingKind.SYSTEM, 'GRNI', '33'],
  [AccountMappingKind.SYSTEM, 'VAT_INPUT', '22'],
  [AccountMappingKind.SYSTEM, 'VAT_OUTPUT', '21'],
  [AccountMappingKind.SYSTEM, 'STOCK_IN_TRANSIT', '32'],
  [AccountMappingKind.SYSTEM, 'STOCK_ADJUSTMENT', '62'],
  [AccountMappingKind.SYSTEM, 'STOCK_WRITE_OFF', '61'],
  [AccountMappingKind.SYSTEM, 'OPENING_BALANCE', '70'],
  [AccountMappingKind.SYSTEM, 'BANK', '3'],
];

/**
 * Sample QuickBooks: the in-process mock company, connected, with every
 * category, store, tax category and payment mode mapped. Nothing is posted:
 * preview a batch on the QuickBooks screen. Runs once.
 */
export async function seedSampleAccounting(app: INestApplicationContext, log: (m: string) => void = (m) => console.log(`[seed] ${m}`)) {
  const ds = app.get(DataSource);
  const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM accounting_connection`);
  if (n > 0) return;
  const acc = app.get(AccountingService);
  try {
    await acc.saveConnection({ provider: AccountingProvider.MOCK, redirectUri: '/api/v1/callbacks/quickbooks' });
    const { url } = await acc.startOAuth();
    const q = new URL(url, 'http://local/').searchParams;
    await acc.oauthCallback({ code: q.get('code')!, state: q.get('state')!, realmId: q.get('realmId')! }, null);
    for (const [kind, localKey, externalId] of SAMPLE_QBO_MAPPINGS) await acc.saveMapping({ kind, localKey, externalId });
    log(`sample QuickBooks: mock company connected, ${SAMPLE_QBO_MAPPINGS.length} mappings`);
  } catch (e) {
    log(`sample QuickBooks incomplete: ${(e as Error).message}`);
  }
}
