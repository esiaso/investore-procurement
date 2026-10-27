import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import type { Browser } from 'playwright';
import { loadEnv } from '../../config/env';

/** HTML → PDF with headless Chromium (Playwright). One shared browser. */
@Injectable()
export class PdfService implements OnModuleDestroy {
  private browser: Promise<Browser> | null = null;

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
      await tab.setContent(html, { waitUntil: 'load' });
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
