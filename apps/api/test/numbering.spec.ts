import { financialYearOf, formatDocumentNumber } from '../src/modules/numbering/financial-year';
import { NumberingService } from '../src/modules/numbering/numbering.service';
import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

describe('financial year helpers', () => {
  it('uses the calendar year when the FY starts in January', () => {
    expect(financialYearOf('2026-01-01', 1)).toEqual({ startYear: 2026, label: '2026' });
    expect(financialYearOf('2026-12-31', 1)).toEqual({ startYear: 2026, label: '2026' });
  });

  it('spans two years for a July start', () => {
    expect(financialYearOf('2026-06-30', 7)).toEqual({ startYear: 2025, label: '2025/26' });
    expect(financialYearOf('2026-07-01', 7)).toEqual({ startYear: 2026, label: '2026/27' });
  });

  it('rejects invalid start months', () => {
    expect(() => financialYearOf('2026-01-01', 13)).toThrow();
  });

  it('formats tokens and collapses empty segments', () => {
    const parts = { prefix: 'PO', storeCode: null, fyLabel: '2026', date: '2026-10-19', seq: 7, padding: 5 };
    expect(formatDocumentNumber('{PREFIX}/{STORE}/{FY}/{SEQ}', parts)).toBe('PO/2026/00007');
    expect(formatDocumentNumber('{PREFIX}-{YYYY}{MM}-{SEQ}', parts)).toBe('PO-202610-00007');
    expect(formatDocumentNumber('{PREFIX}/{STORE}/{FY}/{SEQ}', { ...parts, storeCode: 'MS' })).toBe('PO/MS/2026/00007');
  });
});

describe('NumberingService', () => {
  let ctx: TestContext;
  let numbering: NumberingService;
  let admin: Client;

  beforeAll(async () => {
    ctx = await createTestApp();
    numbering = ctx.app.get(NumberingService);
    admin = await loggedIn(ctx, 'admin');
  });
  afterAll(() => ctx.close());

  async function newScheme(overrides: Record<string, unknown> = {}) {
    const documentType = uniq('T').replace('-', '_');
    const res = await admin.post('/numbering-schemes', {
      documentType,
      prefix: 'TST',
      format: '{PREFIX}/{FY}/{SEQ}',
      padding: 4,
      resetEachYear: true,
      ...overrides,
    });
    expect(res.status).toBe(201);
    return documentType;
  }

  it('numbers sequentially per financial year', async () => {
    const type = await newScheme();
    expect(await numbering.next(type, { date: '2026-03-01' })).toBe('TST/2026/0001');
    expect(await numbering.next(type, { date: '2026-11-30' })).toBe('TST/2026/0002');
    expect(await numbering.next(type, { date: '2027-01-02' })).toBe('TST/2027/0001');
  });

  it('follows the configured financial year start month', async () => {
    const type = await newScheme();
    await admin.put('/settings/finance.fyStartMonth', { value: 7 }).expect(200);
    try {
      expect(await numbering.next(type, { date: '2026-06-30' })).toBe('TST/2025/26/0001');
      expect(await numbering.next(type, { date: '2026-07-01' })).toBe('TST/2026/27/0001');
    } finally {
      await admin.put('/settings/finance.fyStartMonth', { value: 1 }).expect(200);
    }
  });

  it('never hands out the same number twice under concurrency', async () => {
    const type = await newScheme({ resetEachYear: false, format: '{PREFIX}{SEQ}', padding: 6 });
    const numbers = await Promise.all(Array.from({ length: 25 }, () => numbering.next(type)));
    expect(new Set(numbers).size).toBe(25);
    const seqs = numbers.map((n) => Number(n.replace('TST', ''))).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('does not consume a number when the caller rolls back', async () => {
    const type = await newScheme({ resetEachYear: false, format: '{PREFIX}{SEQ}' });
    await expect(
      ctx.ds.transaction(async (manager) => {
        await numbering.next(type, { manager });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await numbering.next(type)).toBe('TST0001');
  });

  it('prefers a store-specific scheme and fills {STORE}', async () => {
    const storeId = await idByCode(ctx.ds, 'store', 'OPD-PH');
    const type = await newScheme({ format: '{PREFIX}/{STORE}/{FY}/{SEQ}' });
    await admin
      .post('/numbering-schemes', { documentType: type, storeId, prefix: 'OPD', format: '{PREFIX}/{STORE}/{SEQ}', padding: 3, resetEachYear: false })
      .expect(201);
    expect(await numbering.next(type, { storeId })).toBe('OPD/OPD-PH/001');
    const msId = await idByCode(ctx.ds, 'store', 'MS');
    expect(await numbering.next(type, { storeId: msId, date: '2026-05-05' })).toBe('TST/MS/2026/0001');
  });

  it('fails clearly when no scheme is configured', async () => {
    await expect(numbering.next('NOPE')).rejects.toThrow(/No numbering scheme/);
  });

  it('requires {SEQ} in the format', async () => {
    const res = await admin.post('/numbering-schemes', {
      documentType: 'BAD_FMT',
      prefix: 'X',
      format: '{PREFIX}',
      padding: 3,
      resetEachYear: false,
    });
    expect(res.status).toBe(400);
  });
});
