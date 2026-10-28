import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Browser } from 'playwright';
import { DataSource } from 'typeorm';
import { LETTERHEAD_LOGO, LETTERHEAD_LOGO_SMALL } from '../../common/html';
import { loadEnv } from '../../config/env';

/** HTML → PDF with headless Chromium (Playwright). One shared browser. */
@Injectable()
export class PdfService implements OnModuleDestroy {
  private browser: Promise<Browser> | null = null;

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * Puts the hospital logo (Organisation → Hospital details) in place of the
   * letterhead placeholder; without a logo the placeholder box stays.
   */
  private async withLogo(html: string): Promise<string> {
    if (!html.includes(LETTERHEAD_LOGO) && !html.includes(LETTERHEAD_LOGO_SMALL)) return html;
    const [row] = await this.ds.query(`SELECT logo FROM facility WHERE is_active AND logo IS NOT NULL ORDER BY created_at LIMIT 1`).catch(() => []);
    const logo: string | null = row?.logo ?? null;
    return html
      .split(LETTERHEAD_LOGO)
      .join(logo ? `<div class="logo" style="border:none"><img src="${logo}" alt="" style="max-width:100%;max-height:100%;object-fit:contain"></div>` : '<div class="logo">LOGO</div>')
      .split(LETTERHEAD_LOGO_SMALL)
      .join(logo ? `<div><img src="${logo}" alt="" style="max-height:48px;max-width:160px;object-fit:contain;margin-bottom:6px"></div>` : '');
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = (async () => {
        const { chromium } = await import('playwright');
        return chromium.launch({ executablePath: loadEnv().chromiumPath ?? undefined, args: ['--no-sandbox'] });
      })();
      this.browser.catch(() => (this.browser = null));
    }
    return this.browser;
  }

  /** A4 by default (landscape on request); `page` sets e.g. a thermal roll ({ width: '80mm' }, height fitted to the content). */
  async render(html: string, page?: { width: string; marginMm?: number }, opts: { landscape?: boolean } = {}): Promise<Buffer> {
    let browser: Browser;
    try {
      browser = await this.getBrowser();
    } catch (e) {
      throw new ServiceUnavailableException(`PDF rendering is unavailable (Chromium not installed?): ${(e as Error).message.split('\n')[0]}`);
    }
    const tab = await browser.newPage();
    try {
      await tab.setContent(await this.withLogo(html), { waitUntil: 'load' });
      if (page) {
        const m = `${page.marginMm ?? 3}mm`;
        await tab.setViewportSize({ width: 302, height: 800 }); // 80 mm at 96 dpi
        const height = await tab.evaluate(() => document.documentElement.scrollHeight);
        return await tab.pdf({ width: page.width, height: `${Math.ceil((height * 25.4) / 96) + 2 * (page.marginMm ?? 3)}mm`, printBackground: true, margin: { top: m, bottom: m, left: m, right: m } });
      }
      return await tab.pdf({ format: 'A4', landscape: !!opts.landscape, printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } });
    } finally {
      await tab.close();
    }
  }

  async onModuleDestroy() {
    if (this.browser) await (await this.browser.catch(() => null))?.close();
  }
}
