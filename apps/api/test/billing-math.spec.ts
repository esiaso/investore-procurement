import { InteractionSeverity } from '@sil/shared';
import { computeLine, inclusivePrice, KRA_PIN, splitPayer, summarise } from '../src/modules/billing/tax-calc';
import { buildSalePayload, maskSecrets } from '../src/modules/etims/etims-payloads';
import { etimsDateTime, groupsOf4 } from '../src/modules/etims/etims-spec';
import { MockEtims } from '../src/modules/etims/mock/mock-etims';
import { ageInYears, InteractionPair, MedForCheck, orderPair, parseInteractionCsv, runChecks } from '../src/modules/pharmacy/interactions';

describe('tax calculation (VAT-inclusive prices)', () => {
  it('extracts 16% VAT from the gross: tax = gross × 16/116', () => {
    const l = computeLine({ quantity: 3, unitPrice: 116, taxRatePercent: 16, taxTypeCode: 'B' });
    expect(l).toEqual({ grossBeforeDiscount: 348, discountAmount: 0, grossAmount: 348, taxAmount: 48, netAmount: 300 });
  });

  it('applies the discount before VAT and rounds to cents', () => {
    const l = computeLine({ quantity: 1, unitPrice: 99.99, discountPercent: 10, taxRatePercent: 16, taxTypeCode: 'B' });
    expect(l.discountAmount).toBe(10);
    expect(l.grossAmount).toBe(89.99);
    expect(l.taxAmount).toBe(12.41); // 89.99 × 16/116 = 12.412…
    expect(l.netAmount).toBe(77.58);
  });

  it('exempt and zero-rated lines carry no tax', () => {
    expect(computeLine({ quantity: 2, unitPrice: 50, taxRatePercent: 0, taxTypeCode: 'A' }).taxAmount).toBe(0);
    expect(computeLine({ quantity: 2, unitPrice: 50, taxRatePercent: 0, taxTypeCode: 'C' }).netAmount).toBe(100);
  });

  it('refuses negative quantities or prices', () => {
    expect(() => computeLine({ quantity: -1, unitPrice: 1, taxRatePercent: 16, taxTypeCode: 'B' })).toThrow();
  });

  it('summarises per eTIMS tax type A–E with totals', () => {
    const lines = [
      { ...computeLine({ quantity: 1, unitPrice: 116, taxRatePercent: 16, taxTypeCode: 'B' }), taxTypeCode: 'B', taxRatePercent: 16 },
      { ...computeLine({ quantity: 2, unitPrice: 58, taxRatePercent: 16, taxTypeCode: 'B' }), taxTypeCode: 'B', taxRatePercent: 16 },
      { ...computeLine({ quantity: 4, unitPrice: 25, taxRatePercent: 0, taxTypeCode: 'A' }), taxTypeCode: 'A', taxRatePercent: 0 },
    ];
    const s = summarise(lines);
    expect(s.buckets.B).toEqual({ taxable: 232, tax: 32, rate: 16 });
    expect(s.buckets.A).toEqual({ taxable: 100, tax: 0, rate: 0 });
    expect(s.buckets.C).toEqual({ taxable: 0, tax: 0, rate: 0 });
    expect(s).toMatchObject({ totalAmount: 332, totalTax: 32, totalNet: 300 });
  });

  it('splits co-pay and payer shares that add up to the line', () => {
    expect(splitPayer(333.33, 10)).toEqual({ patientShare: 33.33, payerShare: 300 });
    expect(splitPayer(100, 0)).toEqual({ patientShare: 0, payerShare: 100 });
    expect(splitPayer(100, null)).toEqual({ patientShare: 100, payerShare: 0 });
  });

  it('derives a shelf price from the VAT-exclusive base, a list adjustment and the rate', () => {
    expect(inclusivePrice(100, 0, 16)).toBe(116);
    expect(inclusivePrice(100, -10, 16)).toBe(104.4);
    expect(inclusivePrice(10, 0, 0)).toBe(10);
  });

  it('validates KRA PINs', () => {
    expect(KRA_PIN.test('P051234567X')).toBe(true);
    expect(KRA_PIN.test('A123456789Z')).toBe(true);
    expect(KRA_PIN.test('P05123456X')).toBe(false);
    expect(KRA_PIN.test('p051234567x')).toBe(false);
  });
});

describe('eTIMS payloads', () => {
  const actor = { id: 'tester', name: 'Tester' };
  const line = (taxTyCd: string, amt: number, tax: number) => ({
    itemCd: 'KE2NTU0000001', itemClsCd: '5100000000', itemNm: 'X', bcd: null, pkgUnitCd: 'NT', qtyUnitCd: 'U',
    qty: 1, prc: amt, splyAmt: amt, dcRt: 0, dcAmt: 0, taxTyCd, taxblAmt: amt, taxAmt: tax, totAmt: amt,
    isrccCd: null, isrccNm: null, isrcRt: null, isrcAmt: null,
  });

  it('builds a sale with per-type taxable amounts, rates and Nairobi time stamps', () => {
    const p = buildSalePayload({
      trdInvcNo: 'SI/1', invcNo: 7, orgInvcNo: 0, isCreditNote: false, custTin: null, custNm: null, custMblNo: null, pmtTyCd: '01',
      issuedAt: new Date('2026-03-01T21:30:00Z'), rates: { A: 0, B: 16, C: 0, D: 0, E: 8 }, lines: [line('B', 116, 16), line('A', 50, 0)], timeZone: 'Africa/Nairobi', actor,
    });
    expect(p).toMatchObject({ invcNo: 7, rcptTyCd: 'S', salesTyCd: 'N', taxblAmtA: 50, taxblAmtB: 116, taxAmtB: 16, taxRtB: 16, totAmt: 166, totTaxAmt: 16, cfmDt: '20260302003000', salesDt: '20260302' });
  });

  it('marks credit notes (R) with the original invoice and refund reason', () => {
    const p = buildSalePayload({
      trdInvcNo: 'CN/1', invcNo: 8, orgInvcNo: 7, isCreditNote: true, creditReasonCode: '06', custTin: null, custNm: null, custMblNo: null, pmtTyCd: '01',
      issuedAt: new Date(), rates: { B: 16 }, lines: [line('B', 116, 16)], timeZone: 'Africa/Nairobi', actor,
    });
    expect(p).toMatchObject({ rcptTyCd: 'R', orgInvcNo: 7, rfdRsnCd: '06', salesSttsCd: '05' });
  });

  it('masks the communication key in logs', () => {
    expect(maskSecrets({ tin: 'P1', cmcKey: 'secret', data: { info: { cmcKey: 'k', sdcId: 'CU' } } })).toEqual({ tin: 'P1', cmcKey: '***', data: { info: { cmcKey: '***', sdcId: 'CU' } } });
  });

  it('prints internal data and signature in groups of 4; dates as yyyyMMddHHmmss', () => {
    expect(groupsOf4('ABCDEFGHIJ')).toBe('ABCD-EFGH-IJ');
    expect(etimsDateTime(new Date('2026-01-31T22:05:09Z'), 'Africa/Nairobi')).toBe('20260201010509');
  });

  it('mock control unit: an identical resend returns the original receipt, a different one is 994', () => {
    const mock = new MockEtims();
    const h = (key?: string) => ({ tin: 'P051234567X', bhfid: '00', cmckey: key });
    const init = mock.handle('init', h(), { tin: 'P051234567X', bhfId: '00', dvcSrlNo: 'D1' });
    const key = (init.body!.data as { info: { cmcKey: string } }).info.cmcKey;
    expect(mock.handle('saveItem', h(key), { tin: 'P051234567X', bhfId: '00', itemCd: 'KE2NTU0000001', itemClsCd: '5100000000', itemNm: 'X', pkgUnitCd: 'NT', qtyUnitCd: 'U', taxTyCd: 'A', orgnNatCd: 'KE', itemTyCd: '2' }).body!.resultCd).toBe('000');
    const sale = { tin: 'P051234567X', bhfId: '00', invcNo: 1, rcptTyCd: 'S', taxblAmtA: 10, itemList: [{ itemCd: 'KE2NTU0000001', taxTyCd: 'A', taxblAmt: 10 }] };
    const first = mock.handle('saveSale', h(key), sale);
    const again = mock.handle('saveSale', h(key), sale);
    expect(again.body).toMatchObject({ resultCd: '000', data: first.body!.data });
    expect(mock.handle('saveSale', h(key), { ...sale, taxblAmtA: 11, itemList: [{ ...sale.itemList[0], taxblAmt: 11 }] }).body!.resultCd).toBe('994');
    expect(mock.handle('saveSale', h('wrong'), sale).body!.resultCd).toBe('900');
  });
});

describe('clinical checks (generic level)', () => {
  const med = (inn: string, cls: string | null, lineId: string | null, extra: Partial<MedForCheck> = {}): MedForCheck => ({
    lineId, genericId: `g-${inn}`, inn, therapeuticClass: cls, pregnancyContraindicated: false, minAgeYears: null, label: inn, ...extra,
  });
  const pair = (a: string, b: string, severity: InteractionSeverity): InteractionPair => {
    const [innA, innB] = orderPair(a, b);
    return { innA, innB, severity, mechanism: 'm', management: 'x', source: 'TEST' };
  };
  const adult = { ageYears: 40, isPregnant: false, allergies: [] as string[] };

  it('finds an interaction by substance and by therapeutic class, against active medications too', () => {
    const lines = [med('Ibuprofen', 'NSAID', 'l1')];
    const active = [med('Enoxaparin sodium', 'Low molecular weight heparin', null)];
    const alerts = runChecks(adult, lines, active, [pair('enoxaparin sodium', 'class:nsaid', InteractionSeverity.MAJOR)]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'INTERACTION', severity: 'MAJOR', lineIds: ['l1'] });
    expect(alerts[0].message).toContain('active medication');
  });

  it('matches components of combination products', () => {
    const lines = [med('Sulfamethoxazole + Trimethoprim', 'Sulfonamide combination', 'l1'), med('Glibenclamide', 'Sulfonylurea', 'l2')];
    const alerts = runChecks(adult, lines, [], [pair('trimethoprim', 'glibenclamide', InteractionSeverity.MODERATE)]);
    expect(alerts.map((a) => a.type)).toEqual(['INTERACTION']);
    expect(alerts[0].lineIds).toEqual(['l1', 'l2']);
  });

  it('raises each pair once, ordered by severity', () => {
    const lines = [med('A', null, 'l1'), med('B', null, 'l2'), med('C', null, 'l3')];
    const alerts = runChecks(adult, lines, [], [pair('a', 'b', InteractionSeverity.MINOR), pair('b', 'c', InteractionSeverity.CONTRAINDICATED)]);
    expect(alerts.map((a) => a.severity)).toEqual(['CONTRAINDICATED', 'MINOR']);
  });

  it('flags allergies by substance or class (plural allergy terms)', () => {
    const lines = [med('Amoxicillin', 'Penicillin antibiotic', 'l1'), med('Paracetamol', 'Analgesic / antipyretic', 'l2')];
    const alerts = runChecks({ ...adult, allergies: ['Penicillins'] }, lines, [], []);
    expect(alerts).toEqual([expect.objectContaining({ type: 'ALLERGY', severity: 'CONTRAINDICATED', lineIds: ['l1'] })]);
    expect(runChecks({ ...adult, allergies: ['paracetamol'] }, lines, [], [])[0].lineIds).toEqual(['l2']);
  });

  it('flags duplicate therapy: same substance (moderate) and same class (minor)', () => {
    const lines = [med('Omeprazole', 'Proton pump inhibitor', 'l1')];
    const dupInn = runChecks(adult, lines, [{ ...med('Omeprazole', 'Proton pump inhibitor', null), genericId: 'g-omeprazole-40' }], []);
    expect(dupInn).toEqual([expect.objectContaining({ type: 'DUPLICATE_THERAPY', severity: 'MODERATE' })]);
    const dupClass = runChecks(adult, lines, [med('Esomeprazole', 'Proton pump inhibitor', null)], []);
    expect(dupClass).toEqual([expect.objectContaining({ type: 'DUPLICATE_THERAPY', severity: 'MINOR' })]);
  });

  it('checks minimum age and pregnancy', () => {
    const doxy = med('Doxycycline', 'Tetracycline', 'l1', { pregnancyContraindicated: true, minAgeYears: 8 });
    expect(runChecks({ ageYears: 5, isPregnant: false, allergies: [] }, [doxy], [], [])).toEqual([expect.objectContaining({ type: 'AGE', severity: 'MAJOR' })]);
    expect(runChecks({ ageYears: 30, isPregnant: true, allergies: [] }, [doxy], [], [])).toEqual([expect.objectContaining({ type: 'PREGNANCY', severity: 'CONTRAINDICATED' })]);
    expect(runChecks({ ageYears: null, isPregnant: false, allergies: [] }, [doxy], [], [])).toEqual([]);
  });

  it('gives stable fingerprints so a recheck does not raise the same alert twice', () => {
    const lines = [med('A', null, 'l1'), med('B', null, 'l2')];
    const p = [pair('a', 'b', InteractionSeverity.MAJOR)];
    expect(runChecks(adult, lines, [], p)[0].fingerprint).toBe(runChecks(adult, [...lines].reverse(), [], p)[0].fingerprint);
  });

  it('computes age in years from the date of birth', () => {
    expect(Math.floor(ageInYears('2018-06-15', '2026-06-14')!)).toBe(7);
    expect(Math.floor(ageInYears('2018-06-15', '2026-06-16')!)).toBe(8);
    expect(ageInYears(null, '2026-01-01')).toBeNull();
  });

  it('parses interaction CSV (quoted fields, severity check, pair ordering)', () => {
    const csv = 'inn_a,inn_b,severity,mechanism,management\nWarfarin,Aspirin,major,"Bleeding, additive","Avoid; monitor INR"\nX,X,MINOR,m,n\nA,B,SEVERE,m,n\n';
    const { rows, errors } = parseInteractionCsv(csv);
    expect(rows).toEqual([{ innA: 'aspirin', innB: 'warfarin', severity: 'MAJOR', mechanism: 'Bleeding, additive', management: 'Avoid; monitor INR', source: undefined }]);
    expect(errors).toHaveLength(2);
    expect(parseInteractionCsv('a,b\n1,2').errors[0]).toMatch(/Missing column/);
  });
});
