import { PdfService } from '../src/modules/mail/pdf.service';
import { LETTERHEAD_LOGO, LETTERHEAD_LOGO_SMALL, letterhead } from '../src/common/html';
import { Client, createTestApp, loggedIn, TestContext } from './helpers';

// 1×1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('Hospital details', () => {
  let ctx: TestContext;
  let admin: Client;
  let storekeeper: Client;
  let original: Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await loggedIn(ctx, 'admin');
    storekeeper = await loggedIn(ctx, 'storekeeper');
    original = (await admin.get('/hospital').expect(200)).body;
  });
  afterAll(async () => {
    await admin.put('/hospital', { name: original.name, address: original.address, phone: original.phone, email: original.email, kraPin: original.kraPin, mailFrom: original.mailFrom });
    await admin.delete('/hospital/logo');
    await ctx.close();
  });

  it('shows the main facility and the e-mail sender', async () => {
    expect(original).toMatchObject({ name: expect.any(String), hasLogo: false, mailFrom: expect.stringContaining('@') });
    await storekeeper.get('/hospital').expect(200);
  });

  it('lets administrators change name, contacts, KRA PIN and sender, and audits it', async () => {
    const res = await admin.put('/hospital', { name: 'Upendo Mission Hospital', address: 'P.O. Box 1, Kisumu', phone: '+254 711 000111', email: 'info@upendo.example', kraPin: 'P051234567X', mailFrom: 'Upendo Procurement <procurement@upendo.example>' }).expect(200);
    expect(res.body).toMatchObject({ name: 'Upendo Mission Hospital', kraPin: 'P051234567X', mailFrom: 'Upendo Procurement <procurement@upendo.example>' });
    const [audit] = await ctx.ds.query(`SELECT after FROM audit_log WHERE entity_type = 'Facility' ORDER BY id DESC LIMIT 1`);
    expect(audit.after).toMatchObject({ name: 'Upendo Mission Hospital' });

    await storekeeper.put('/hospital', { name: 'X', mailFrom: 'a@b.co' }).expect(403);
    const bad = await admin.put('/hospital', { name: 'X', kraPin: '12345', mailFrom: 'not an address' }).expect(400);
    expect(JSON.stringify(bad.body.message)).toMatch(/kraPin[\s\S]*mailFrom|mailFrom[\s\S]*kraPin/);
  });

  it('takes a PNG or JPEG logo only, checks its content and records a fingerprint, not the image', async () => {
    await admin.put('/hospital/logo', { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }).expect(400);
    const fake = await admin.put('/hospital/logo', { dataUrl: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64') }).expect(400);
    expect(fake.body.code).toBe('LOGO_TYPE');
    await storekeeper.put('/hospital/logo', { dataUrl: PNG }).expect(403);

    expect((await admin.put('/hospital/logo', { dataUrl: PNG }).expect(200)).body.hasLogo).toBe(true);
    expect((await storekeeper.get('/hospital/logo').expect(200)).body.dataUrl).toBe(PNG);
    const [audit] = await ctx.ds.query(`SELECT after FROM audit_log WHERE entity_type = 'Facility' ORDER BY id DESC LIMIT 1`);
    expect(audit.after.logo).toMatch(/^image\/png, 1 KB, sha256 [0-9a-f]{16}$/);
  });

  it('puts the logo on every letterhead, or keeps the LOGO box when there is none', async () => {
    const pdf = ctx.app.get(PdfService) as unknown as { withLogo(html: string): Promise<string> };
    const html = `${letterhead({ name: 'H', address: null, phone: null, email: null })}<p>${LETTERHEAD_LOGO_SMALL}</p>`;
    expect(html).toContain(LETTERHEAD_LOGO);
    const withLogo = await pdf.withLogo(html);
    expect(withLogo.match(new RegExp(PNG.replace(/[+/]/g, '\\$&'), 'g'))).toHaveLength(2);
    expect(withLogo).not.toContain('LOGO</div>');

    await admin.delete('/hospital/logo').expect(200);
    const without = await pdf.withLogo(html);
    expect(without).toContain('<div class="logo">LOGO</div>');
    expect(without).not.toContain('<img');
  });
});
