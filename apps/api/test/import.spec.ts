import ExcelJS from 'exceljs';
import { ITEM_IMPORT_COLUMNS } from '@sil/shared';
import { sampleGtin } from '../src/database/seeds/seed';
import { API, Client, createTestApp, loggedIn, TestContext, uniq } from './helpers';

type Row = Partial<Record<(typeof ITEM_IMPORT_COLUMNS)[number] | `attr_${string}`, string>>;

function csv(rows: Row[]): Buffer {
  const attrColumns = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k.startsWith('attr_'))))];
  const columns = [...ITEM_IMPORT_COLUMNS, ...attrColumns] as (keyof Row)[];
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => r[c] ?? '').join(','));
  return Buffer.from(lines.join('\n'));
}

describe('Item bulk import', () => {
  let ctx: TestContext;
  let officer: Client;
  const tag = uniq('imp');

  // GTINs well above the sample seed range.
  let gtinSeq = 900_000 + Math.floor(Math.random() * 90_000);
  const gtin = () => sampleGtin(gtinSeq++);

  const drug = (over: Row = {}): Row => ({
    name: `Importocin ${tag} 500mg Tab`,
    category_code: 'DRUG-ANTIINF',
    generic_inn: `Importocin ${tag}`,
    generic_strength: '500 mg',
    generic_dosage_form: 'Tablet',
    generic_route: 'Oral',
    atc_code: 'J01XX99',
    keml: 'N',
    brand_name: 'Importa',
    manufacturer: 'Test Pharma',
    pack_size: '10x10',
    gtin: gtin(),
    base_uom: 'TAB',
    unit_price: '5.50',
    sales_class: 'POM',
    tax_category: 'EXEMPT',
    formulary: 'Y',
    ...over,
  });

  const upload = (file: Buffer, name: string, query = '') =>
    officer.agent.post(`${API}/catalog/import/items${query}`).set('x-csrf-token', officer.csrf).attach('file', file, name);

  beforeAll(async () => {
    ctx = await createTestApp();
    officer = await loggedIn(ctx, 'proc.officer');
  });
  afterAll(() => ctx.close());

  it('serves a CSV template with every column', async () => {
    const res = await officer.get('/catalog/import/items/template').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0].startsWith(ITEM_IMPORT_COLUMNS.join(','))).toBe(true);
  });

  it('validates rows and reports errors by row and field (dry run by default)', async () => {
    const file = csv([
      drug(),
      drug({ name: '', brand_name: 'NoName' }),
      drug({ unit_price: 'abc', brand_name: 'BadPrice' }),
      drug({ category_code: 'NOPE', brand_name: 'BadCat' }),
      drug({ gtin: '1234567890123', brand_name: 'BadGtin' }),
      drug({ generic_inn: '', brand_name: 'NoGeneric' }),
      drug({ sales_class: 'XYZ', brand_name: 'BadClass' }),
    ]);
    const res = await upload(file, 'items.csv').expect(200);
    expect(res.body).toMatchObject({ dryRun: true, totalRows: 7, validRows: 1, committed: false, createdItems: 0 });
    const errs = res.body.errors.map((e: { row: number; field: string }) => `${e.row}:${e.field}`);
    expect(errs).toEqual(
      expect.arrayContaining(['3:name', '4:unit_price', '5:category_code', '6:gtin', '7:generic_inn', '8:sales_class']),
    );
    const [{ count }] = await ctx.ds.query(`SELECT count(*)::int AS count FROM item WHERE name LIKE $1`, [`%${tag}%`]);
    expect(count).toBe(0);
  });

  it('validates category attributes from attr_* columns', async () => {
    const supply = { name: `Attr gloves ${tag}`, category_code: 'SUP-PPE', base_uom: 'PCS', unit_price: '1', tax_category: 'STANDARD' };
    const res = await upload(
      csv([
        { ...supply, attr_sterile: 'Y' }, // size missing
        { ...supply, name: `Attr gloves 2 ${tag}`, attr_size: 'XXL', attr_sterile: 'Y' },
        { ...supply, name: `Attr gloves 3 ${tag}`, attr_size: 'S', attr_sterile: 'maybe' },
      ]),
      'attrs.csv',
    ).expect(200);
    const errs = res.body.errors.map((e: { row: number; field: string }) => `${e.row}:${e.field}`);
    expect(errs).toEqual(['2:attr_size', '3:attr_size', '4:attr_sterile']);
  });

  it('detects duplicates inside the file and against the database', async () => {
    const [existing] = await ctx.ds.query(`SELECT code, gtin FROM item WHERE gtin IS NOT NULL LIMIT 1`);
    const first = drug({ brand_name: 'DupBrand' });
    const file = csv([
      first,
      { ...first, gtin: gtin() }, // same generic + brand + pack
      drug({ brand_name: 'GtinTwin', gtin: first.gtin }), // same GTIN as row 2
      drug({ brand_name: 'DbGtin', gtin: existing.gtin }),
      drug({ brand_name: 'DbCode', code: existing.code }),
    ]);
    const res = await upload(file, 'dupes.csv').expect(200);
    expect(res.body.errors).toEqual([]);
    const dupes = res.body.duplicates.map((d: { row: number; field: string }) => `${d.row}:${d.field}`);
    expect(dupes).toEqual(expect.arrayContaining(['3:name', '4:gtin', '5:gtin', '6:code']));
    expect(res.body.validRows).toBe(1);
  });

  it('blocks the import while there are errors or unskipped duplicates', async () => {
    const res = await upload(csv([drug(), drug({ unit_price: '-1' })]), 'bad.csv', '?dryRun=false').expect(200);
    expect(res.body.committed).toBe(false);
    const [{ count }] = await ctx.ds.query(`SELECT count(*)::int AS count FROM generic WHERE inn_name = $1`, [`Importocin ${tag}`]);
    expect(count).toBe(0);
  });

  it('imports valid rows, creating generics once and auditing the import', async () => {
    const rows = [
      drug({ brand_name: 'ImportA' }),
      drug({ brand_name: 'ImportB', name: `ImportB ${tag}` }),
      {
        name: `Import gloves ${tag}`,
        category_code: 'SUP-PPE',
        base_uom: 'PCS',
        unit_price: '"1,250.00"',
        tax_category: 'standard',
        gtin: gtin(),
        attr_size: 'm',
        attr_sterile: 'N',
      },
    ];
    const res = await upload(csv(rows), 'good.csv', '?dryRun=false').expect(200);
    expect(res.body).toMatchObject({ committed: true, createdItems: 3, createdGenerics: 1, errors: [] });

    const items = await officer.get(`/items?search=${encodeURIComponent(`Importocin ${tag}`)}`).expect(200);
    expect(items.body.total).toBe(2);
    expect(items.body.items[0].code).toMatch(/^ITM\d{6}$/);
    const [glove] = await ctx.ds.query(`SELECT unit_price, attributes FROM item WHERE name = $1`, [`Import gloves ${tag}`]);
    expect(Number(glove.unit_price)).toBe(1250);
    expect(glove.attributes).toEqual({ size: 'M', sterile: false });

    const [audit] = await ctx.ds.query(`SELECT * FROM audit_log WHERE action = 'IMPORT' ORDER BY id DESC LIMIT 1`);
    expect(audit.after).toMatchObject({ createdItems: 3, createdGenerics: 1 });
  });

  it('can skip duplicates and import the rest', async () => {
    const again = drug({ brand_name: 'ImportA' }); // already imported above
    const fresh = drug({ brand_name: 'ImportC' });
    const res = await upload(csv([again, fresh]), 'skip.csv', '?dryRun=false&skipDuplicates=true').expect(200);
    expect(res.body).toMatchObject({ committed: true, createdItems: 1, createdGenerics: 0, skippedDuplicates: 1 });
  });

  it('reads Excel (.xlsx) files', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Items');
    sheet.addRow([...ITEM_IMPORT_COLUMNS]);
    const row = drug({ brand_name: 'ExcelBrand', unit_price: undefined });
    sheet.addRow(ITEM_IMPORT_COLUMNS.map((c) => (c === 'unit_price' ? 7.25 : (row[c] ?? null))));
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await upload(buffer, 'items.xlsx').expect(200);
    expect(res.body).toMatchObject({ totalRows: 1, validRows: 1, errors: [] });
  });

  it('rejects unsupported files and missing columns', async () => {
    await upload(Buffer.from('hello'), 'items.txt').expect(400);
    const res = await upload(Buffer.from('name,foo\nx,y'), 'items.csv').expect(400);
    expect(res.body.message).toMatch(/Missing column/);
  });

  it('requires the catalog.import permission', async () => {
    const tech = await loggedIn(ctx, 'pharm.tech');
    await tech.agent
      .post(`${API}/catalog/import/items`)
      .set('x-csrf-token', tech.csrf)
      .attach('file', csv([drug()]), 'x.csv')
      .expect(403);
  });
});
