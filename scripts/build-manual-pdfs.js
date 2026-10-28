// Builds PDFs of docs/user-manuals/*.md into docs/user-manuals/pdf/: one per manual
// (cover page, contents, page numbers, screenshots embedded) plus all of them in one volume.
//
//   pnpm docs:pdf      (CHROMIUM_PATH = a Chrome / Chromium binary; default: Playwright's own)
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const repo = path.resolve(__dirname, '..');
const SRC = path.join(repo, 'docs/user-manuals');
const OUT = path.join(SRC, 'pdf');
const { chromium } = require(path.join(repo, 'apps/api/node_modules/playwright'));
fs.mkdirSync(OUT, { recursive: true });

const TITLE = 'SIL Procurement, Supply Chain & Inventory';
const DATE = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.md')).sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b)));
const pdfName = (md) => (md === 'README.md' ? '00-index.pdf' : md.replace(/\.md$/, '.pdf'));
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
function dataUri(rel) {
  const p = path.join(SRC, rel);
  return `data:${mime[path.extname(p).toLowerCase()]};base64,${fs.readFileSync(p).toString('base64')}`;
}

/** Renders one manual's Markdown: heading ids (prefixed), images inlined, links to other manuals rewritten. */
function render(md, prefix, combined) {
  const text = fs.readFileSync(path.join(SRC, md), 'utf8');
  const title = (text.match(/^# (.+)$/m) || [, md])[1];
  const headings = [];
  const renderer = new marked.Renderer();
  renderer.heading = (txt, level) => {
    const id = `${prefix}-${slug(txt)}`;
    if (level === 2 || level === 3) headings.push({ level, txt, id });
    return `<h${level} id="${id}">${txt}</h${level}>`;
  };
  renderer.image = (href, _t, alt) =>
    href.startsWith('images/') ? `<figure><img src="${dataUri(href)}" alt="${alt}"><figcaption>${alt}</figcaption></figure>` : `<img src="${href}" alt="${alt}">`;
  renderer.link = (href, _t, txt) => {
    let h = href;
    const m = href.match(/^([\w.-]+\.md)(#.*)?$/);
    if (m) h = combined ? `#m-${slug(m[1].replace(/\.md$/, ''))}` : pdfName(m[1]);
    else if (href.startsWith('../')) h = `https://github.com/esiaso/investore-procurement/blob/main/docs/${href.slice(3)}`;
    return `<a href="${h}">${txt}</a>`;
  };
  const body = marked.parse(text.replace(/^# .+\n/m, ''), { renderer, gfm: true });
  return { title, headings, body };
}

const CSS = `
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }
* { box-sizing: border-box; }
body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1d2733; }
h1 { font-size: 22pt; color: #0b6b6b; margin: 0 0 10pt; }
h2 { font-size: 15pt; color: #0b6b6b; border-bottom: 1.5pt solid #0b6b6b; padding-bottom: 3pt; margin: 20pt 0 8pt; page-break-after: avoid; }
h3 { font-size: 12pt; color: #12404a; margin: 14pt 0 6pt; page-break-after: avoid; }
h4 { font-size: 11pt; margin: 10pt 0 4pt; }
p, li { orphans: 3; widows: 3; }
a { color: #0b6b6b; text-decoration: none; }
code { font-family: Menlo, Consolas, monospace; font-size: 9pt; background: #eef3f4; padding: 0 3pt; border-radius: 2pt; }
pre { background: #f3f6f7; border: 0.5pt solid #d5dee1; padding: 7pt 9pt; font-size: 8.5pt; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0 12pt; font-size: 9.5pt; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th { background: #0b6b6b; color: #fff; text-align: left; font-weight: 600; }
th, td { border: 0.5pt solid #c9d3d6; padding: 4pt 6pt; vertical-align: top; }
tr:nth-child(even) td { background: #f6f9fa; }
figure { margin: 10pt 0 14pt; text-align: center; page-break-inside: avoid; }
figure img { max-width: 100%; max-height: 120mm; border: 0.5pt solid #c9d3d6; box-shadow: 0 1pt 4pt rgba(0,0,0,.15); }
figcaption { font-size: 8.5pt; color: #5b6b73; margin-top: 4pt; font-style: italic; }
hr { border: none; border-top: 0.5pt solid #c9d3d6; margin: 14pt 0; }
blockquote { border-left: 3pt solid #0b6b6b; margin: 8pt 0; padding: 2pt 10pt; color: #3c4a52; background: #f3f8f8; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
.cover .band { background: #0b6b6b; color: #fff; padding: 26pt 24pt; border-radius: 4pt; }
.cover .system { font-size: 12pt; letter-spacing: .5pt; text-transform: uppercase; opacity: .85; }
.cover h1 { color: #fff; font-size: 30pt; margin: 8pt 0 0; }
.cover .sub { font-size: 13pt; margin-top: 10pt; opacity: .95; }
.cover .meta { margin-top: 26pt; color: #5b6b73; font-size: 10pt; }
.toc { page-break-after: always; }
.toc h2 { margin-top: 0; }
.toc ol { list-style: none; padding: 0; margin: 0; }
.toc li { margin: 3pt 0; }
.toc li.l3 { margin-left: 16pt; font-size: 9.5pt; color: #3c4a52; }
.toc li.manual { font-weight: 600; margin-top: 8pt; }
.manual { page-break-before: always; }
.manual-title { font-size: 22pt; color: #0b6b6b; margin: 0 0 10pt; }
`;

const footer = (label) => `<div style="font-family: Helvetica, Arial, sans-serif; font-size:7.5pt; color:#7a8a92; width:100%; padding:0 16mm; display:flex; justify-content:space-between;">
  <span>${label}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

function cover(title, sub) {
  return `<section class="cover"><div class="band"><div class="system">${TITLE}</div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
  <div class="meta">User manual · ${DATE}<br>Figures, limits and approval chains are the system defaults; your hospital may have changed them.</div></section>`;
}

const AUDIENCE = {
  'README.md': 'Which manual is for whom',
  '00-getting-started.md': 'For every user',
  '01-staff-and-heads-of-department.md': 'For all staff and department in-charges',
  '02-procurement.md': 'For procurement officers and managers',
  '03-stores.md': 'For storekeepers',
  '04-pharmacy.md': 'For pharmacists and pharmacy technicians',
  '05-point-of-sale.md': 'For cashiers and supervisors',
  '06-finance.md': 'For finance officers, accountants and the finance manager',
  '07-petty-cash-custodian.md': 'For petty cash float custodians',
  '08-supply-chain-and-quality.md': 'For the supply chain manager, quality officer and tender committee',
  '09-management-and-audit.md': 'For hospital management and internal audit',
  '10-system-administrator.md': 'For the system administrator',
  '11-supplier-portal.md': "For suppliers' staff",
};

const short = (t) => t.replace(/\s*\(.*\)\s*$/, '');
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext();
  const print = async (html, file, label) => {
    const p = await ctx.newPage();
    await p.setContent(html, { waitUntil: 'load' });
    await p.pdf({ path: path.join(OUT, file), format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: '<div></div>', footerTemplate: footer(label), margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' } });
    await p.close();
    console.log('wrote', file);
  };

  // One PDF per manual.
  for (const f of files) {
    const r = render(f, 's', false);
    const toc = `<section class="toc"><h2>Contents</h2><ol>${r.headings.map((h) => `<li class="l${h.level}"><a href="#${h.id}">${h.txt}</a></li>`).join('')}</ol></section>`;
    await print(page(cover(short(r.title), AUDIENCE[f]) + toc + `<h1>${r.title}</h1>` + r.body), pdfName(f), `${TITLE} · ${short(r.title)}`);
  }

  // Combined PDF.
  const parts = files.map((f) => ({ f, ...render(f, `m-${slug(f.replace(/\.md$/, ''))}`, true) }));
  const toc = `<section class="toc"><h2>Contents</h2><ol>${parts
    .map((p) => `<li class="manual"><a href="#m-${slug(p.f.replace(/\.md$/, ''))}">${p.title}</a></li>` + p.headings.filter((h) => h.level === 2).map((h) => `<li class="l3"><a href="#${h.id}">${h.txt}</a></li>`).join(''))
    .join('')}</ol></section>`;
  const body = parts.map((p) => `<section class="manual"><h1 class="manual-title" id="m-${slug(p.f.replace(/\.md$/, ''))}">${p.title}</h1><p style="color:#5b6b73;margin-top:-6pt">${AUDIENCE[p.f]}</p>${p.body}</section>`).join('');
  await print(page(cover('User manuals', 'All user groups in one volume') + toc + body), 'SIL-user-manuals-complete.pdf', `${TITLE} · User manuals`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
