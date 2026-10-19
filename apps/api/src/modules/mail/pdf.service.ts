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

  async render(html: string): Promise<Buffer> {
    let browser: Browser;
    try {
      browser = await this.getBrowser();
    } catch (e) {
      throw new ServiceUnavailableException(`PDF rendering is unavailable (Chromium not installed?): ${(e as Error).message.split('\n')[0]}`);
    }
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } });
    } finally {
      await page.close();
    }
  }

  async onModuleDestroy() {
    if (this.browser) await (await this.browser.catch(() => null))?.close();
  }
}
