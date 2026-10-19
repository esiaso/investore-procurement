import { Client, createTestApp, idByCode, loggedIn, TestContext, uniq } from './helpers';

describe('Catalog: generics, brands, units', () => {
  let ctx: TestContext;
  let admin: Client;
  let ids: Record<string, string>;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await loggedIn(ctx, 'proc.officer');
    ids = {
      antiinf: await idByCode(ctx.ds, 'item_category', 'DRUG-ANTIINF'),
      ppe: await idByCode(ctx.ds, 'item_category', 'SUP-PPE'),
      tab: await idByCode(ctx.ds, 'unit_of_measure', 'TAB'),
      strip: await idByCode(ctx.ds, 'unit_of_measure', 'STRIP'),
      box: await idByCode(ctx.ds, 'unit_of_measure', 'BOX'),
      pcs: await idByCode(ctx.ds, 'unit_of_measure', 'PCS'),
      exempt: await idByCode(ctx.ds, 'tax_category', 'EXEMPT'),
      standard: await idByCode(ctx.ds, 'tax_category', 'STANDARD'),
    };
  });
  afterAll(() => ctx.close());

  const drugItem = (genericId: string, brandName: string, unitPrice: number) => ({
    genericId,
    categoryId: ids.antiinf,
    name: `${brandName} 250 mg Tablet`,
    brandName,
    manufacturer: 'Test Pharma',
    packSize: '10x10',
    baseUomId: ids.tab,
    unitPrice,
    taxCategoryId: ids.exempt,
  });

  describe('generic–brand mapping', () => {
    let genericId: string;
    let brandA: { id: string; code: string };
    let brandB: { id: string };
    const inn = `Testocillin ${uniq('x')}`;

    beforeAll(async () => {
      const g = await admin
        .post('/generics', { innName: inn, strength: '250 mg', dosageForm: 'Tablet', route: 'Oral', atcCode: 'J01CA99', isKeml: true })
        .expect(201);
      genericId = g.body.id;
      brandA = (await admin.post('/items', drugItem(genericId, 'Alphacil', 12)).expect(201)).body;
      brandB = (await admin.post('/items', drugItem(genericId, 'Betacil', 4)).expect(201)).body;
    });

    it('auto-numbers item codes from the ITEM scheme', () => {
      expect(brandA.code).toMatch(/^ITM\d{6}$/);
    });

    it('rejects a duplicate generic identity', async () => {
      await admin.post('/generics', { innName: inn, strength: '250 mg', dosageForm: 'Tablet', route: 'Oral' }).expect(409);
    });

    it('returns a generic with all its brands', async () => {
      const res = await admin.get(`/generics/${genericId}`).expect(200);
      expect(res.body.items.map((i: { brandName: string }) => i.brandName).sort()).toEqual(['Alphacil', 'Betacil']);
    });

    it('finds brands when searching items by generic name', async () => {
      const res = await admin.get(`/items?search=${encodeURIComponent(inn)}`).expect(200);
      expect(res.body.total).toBe(2);
      expect(res.body.items[0].generic.innName).toBe(inn);
    });

    it('finds the generic (with brands) when searching by a brand name', async () => {
      const res = await admin.get('/generics?search=Alphacil&includeItems=true').expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].items).toHaveLength(2);
    });

    it('lists substitutes of the same generic, cheapest first, excluding the item itself', async () => {
      const third = (await admin.post('/items', drugItem(genericId, 'Gammacil', 8)).expect(201)).body;
      const res = await admin.get(`/items/${brandA.id}/equivalents`).expect(200);
      expect(res.body.map((i: { id: string }) => i.id)).toEqual([brandB.id, third.id]);

      await admin.patch(`/items/${third.id}`, { isActive: false }).expect(200);
      const after = await admin.get(`/items/${brandA.id}/equivalents`).expect(200);
      expect(after.body.map((i: { id: string }) => i.id)).toEqual([brandB.id]);
    });

    it('returns no substitutes for non-drug items', async () => {
      const [glove] = await ctx.ds.query(`SELECT id FROM item WHERE generic_id IS NULL LIMIT 1`);
      const res = await admin.get(`/items/${glove.id}/equivalents`).expect(200);
      expect(res.body).toEqual([]);
    });

    it('refuses to delete a generic that still has brands', async () => {
      await admin.delete(`/generics/${genericId}`).expect(409);
    });
  });

  it('requires a generic for drug categories', async () => {
    const res = await admin.post('/items', { ...drugItem('', 'Orphan', 1), genericId: null });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/generic/);
  });

  it('validates category-specific attributes', async () => {
    const base = { categoryId: ids.ppe, name: `Glove ${uniq('g')}`, baseUomId: ids.pcs, unitPrice: 5, taxCategoryId: ids.standard };
    const missing = await admin.post('/items', { ...base, attributes: { material: 'Latex' } });
    expect(missing.status).toBe(400);
    expect(missing.body.errors).toHaveProperty('size');
    expect(missing.body.errors).toHaveProperty('sterile');

    const wrong = await admin.post('/items', { ...base, attributes: { size: 'XXL', sterile: true } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.errors.size).toMatch(/one of/);

    const unknown = await admin.post('/items', { ...base, attributes: { size: 'M', sterile: true, colour: 'blue' } });
    expect(unknown.body.errors).toHaveProperty('colour');

    await admin.post('/items', { ...base, attributes: { size: 'M', sterile: false, material: 'Nitrile' } }).expect(201);
  });

  it('rejects an invalid GTIN check digit', async () => {
    const res = await admin.post('/items', { ...drugItem((await anyGenericId()), 'BadGtin', 1), gtin: '2000000000010' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toMatch(/check digit/);
  });

  async function anyGenericId() {
    const [g] = await ctx.ds.query(`SELECT id FROM generic LIMIT 1`);
    return g.id as string;
  }

  it('converts box → strip → tablet into base units', async () => {
    const item = (await admin.post('/items', drugItem(await anyGenericId(), `Conv ${uniq('c')}`, 1)).expect(201)).body;
    await admin.post('/unit-conversions', { itemId: item.id, fromUomId: ids.box, toUomId: ids.strip, factor: 10 }).expect(201);
    await admin.post('/unit-conversions', { itemId: item.id, fromUomId: ids.strip, toUomId: ids.tab, factor: 10 }).expect(201);

    const toBase = await admin.get(`/items/${item.id}/convert?quantity=3&fromUomId=${ids.box}`).expect(200);
    expect(toBase.body.quantity).toBe(300);
    const toBoxes = await admin.get(`/items/${item.id}/convert?quantity=250&fromUomId=${ids.tab}&toUomId=${ids.box}`).expect(200);
    expect(toBoxes.body.quantity).toBe(2.5);
    const noPath = await admin.get(`/items/${item.id}/convert?quantity=1&fromUomId=${ids.pcs}`);
    expect(noPath.status).toBe(400);
  });

  it('paginates generics correctly when brands are included', async () => {
    const plain = await admin.get('/generics?pageSize=25').expect(200);
    const withItems = await admin.get('/generics?pageSize=25&includeItems=true').expect(200);
    const page2 = await admin.get('/generics?pageSize=25&page=2&includeItems=true').expect(200);
    expect(withItems.body.total).toBe(plain.body.total);
    expect(withItems.body.items).toHaveLength(25);
    expect(page2.body.total).toBe(plain.body.total);
    expect(withItems.body.items.map((g: { id: string }) => g.id)).toEqual(plain.body.items.map((g: { id: string }) => g.id));
    expect(withItems.body.items.some((g: { items: unknown[] }) => g.items.length > 1)).toBe(true);
  });

  it('seeds a realistic sample catalog', async () => {
    const [{ count }] = await ctx.ds.query(`SELECT count(*)::int AS count FROM item`);
    expect(count).toBeGreaterThanOrEqual(200);
    const [{ nondrug }] = await ctx.ds.query(`SELECT count(*)::int AS nondrug FROM item WHERE generic_id IS NULL`);
    expect(nondrug).toBeGreaterThan(20);
  });
});
