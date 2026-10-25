import { BadRequestException, Controller, Get, Header, Injectable, Module, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import bwipjs from 'bwip-js';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { Permissions } from '@sil/shared';
import { RequirePermissions, StoreScoped } from '../../common/decorators';
import { esc, fmtDate } from '../../common/html';
import { StoreScope } from '../../common/store-scope';
import { PdfService } from '../mail/pdf.service';
import { SettingsService } from '../settings/settings.service';

/** GS1 check digit of the first 13 digits of a GTIN-14. */
export function gs1CheckDigit(digits13: string): number {
  const sum = digits13.split('').reduce((s, ch, i) => s + Number(ch) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

/** GTIN-8/12/13/14 → GTIN-14 when its check digit is right; otherwise null. */
export function gtin14(gtin: string | null | undefined): string | null {
  if (!gtin || !/^\d{8}$|^\d{12,14}$/.test(gtin)) return null;
  const g = gtin.padStart(14, '0');
  return gs1CheckDigit(g.slice(0, 13)) === Number(g[13]) ? g : null;
}

/** GS1 element string for a batch: (01) GTIN, (17) expiry YYMMDD, (10) batch. */
export function gs1BatchString(gtin: string, expiry: string | null, batchNo: string): string {
  const exp = expiry ? `(17)${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}` : '';
  return `(01)${gtin}${exp}(10)${batchNo.replace(/[^\x21-\x7A]/g, '').slice(0, 20)}`;
}

function svg(bcid: string, text: string, opts: Record<string, unknown> = {}): string {
  return bwipjs.toSVG({ bcid, text, scale: 2, height: bcid.includes('datamatrix') ? undefined : 10, includetext: false, ...opts } as never);
}

class ShelfQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ description: 'Comma-separated item ids' }) @IsOptional() @IsString() @MaxLength(20_000) itemIds?: string;
}

class BatchQueryDto {
  @ApiPropertyOptional({ description: 'Comma-separated batch ids' }) @IsString() @MaxLength(20_000) batchIds: string;
  @ApiPropertyOptional({ description: 'Copies of each label' }) @IsOptional() @IsString() @MaxLength(3) copies?: string;
}

@Injectable()
export class LabelsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    private readonly pdf: PdfService,
  ) {}

  private async page(labels: string[]): Promise<Buffer> {
    const { widthMm, heightMm } = await this.settings.get('labels.size');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: A4; margin: 8mm; }
      body { font-family: Arial, sans-serif; margin: 0; }
      .sheet { display: flex; flex-wrap: wrap; gap: 2mm; }
      .label { width: ${widthMm}mm; height: ${heightMm}mm; border: 0.2mm dashed #999; box-sizing: border-box; padding: 1.5mm; overflow: hidden; display: flex; gap: 2mm; page-break-inside: avoid; }
      .label .txt { flex: 1; font-size: 8pt; line-height: 1.2; overflow: hidden; }
      .label .txt b { font-size: 9pt; }
      .label svg { max-height: ${heightMm - 4}mm; max-width: 60%; }
      .label.shelf { flex-direction: column; } .label.shelf svg { max-width: 100%; height: 9mm; }
    </style></head><body><div class="sheet">${labels.join('')}</div></body></html>`;
    return this.pdf.render(html);
  }

  /** Shelf labels: item name, code, bin, Code128 of the barcode (or GTIN, or item code). */
  async shelf(q: { storeId?: string; itemIds?: string }): Promise<Buffer> {
    const ids = q.itemIds ? q.itemIds.split(',').filter(Boolean) : [];
    if (!ids.length && !q.storeId) throw new BadRequestException('Choose a store or items');
    if (q.storeId) StoreScope.assert(q.storeId);
    const params: unknown[] = [];
    const where: string[] = [];
    let bin = 'NULL';
    if (q.storeId) {
      params.push(q.storeId);
      bin = `(SELECT string_agg(DISTINCT bn.code, ', ') FROM stock_balance sb JOIN bin bn ON bn.id = sb.bin_id WHERE sb.item_id = i.id AND sb.store_id = $1 AND sb.on_hand > 0)`;
      if (!ids.length) where.push(`EXISTS (SELECT 1 FROM stock_balance sb WHERE sb.item_id = i.id AND sb.store_id = $1 AND sb.on_hand > 0)`);
    }
    if (ids.length) {
      params.push(ids);
      where.push(`i.id = ANY($${params.length}::uuid[])`);
    }
    const rows: { code: string; name: string; barcode: string | null; gtin: string | null; uom: string; bin: string | null }[] = await this.ds.query(
      `SELECT i.code, i.name, i.barcode, i.gtin, u.code AS uom, ${bin} AS bin
         FROM item i JOIN unit_of_measure u ON u.id = i.base_uom_id
        WHERE ${where.join(' AND ')} ORDER BY i.name LIMIT 1000`,
      params,
    );
    if (!rows.length) throw new BadRequestException('No items to label');
    return this.page(rows.map((r) => `<div class="label shelf"><div class="txt"><b>${esc(r.name)}</b><br>${esc(r.code)} · ${esc(r.uom)}${r.bin ? ` · Bin ${esc(r.bin)}` : ''}</div>${svg('code128', r.barcode || r.gtin || r.code)}</div>`));
  }

  /** Batch labels: GS1 DataMatrix (GTIN, expiry, batch) when the item has a valid GTIN, otherwise Code128 of item code + batch. */
  async batches(q: { batchIds: string; copies?: string }): Promise<Buffer> {
    const ids = q.batchIds.split(',').filter(Boolean);
    if (!ids.length) throw new BadRequestException('Choose batches');
    const copies = Math.min(50, Math.max(1, Number(q.copies ?? 1) || 1));
    const rows: { code: string; name: string; gtin: string | null; batch_no: string; expiry: string | null; hold: string }[] = await this.ds.query(
      `SELECT i.code, i.name, i.gtin, b.batch_no, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry, b.hold_status AS hold
         FROM batch b JOIN item i ON i.id = b.item_id WHERE b.id = ANY($1::uuid[]) ORDER BY i.name, b.batch_no`,
      [ids],
    );
    if (!rows.length) throw new BadRequestException('No batches found');
    const fmt = await this.settings.get('locale.dateFormat');
    const tz = await this.settings.get('locale.timezone');
    const labels: string[] = [];
    for (const r of rows) {
      const g = gtin14(r.gtin);
      let code: string;
      try {
        code = g ? svg('gs1datamatrix', gs1BatchString(g, r.expiry, r.batch_no)) : svg('code128', `${r.code}|${r.batch_no}`);
      } catch {
        code = svg('code128', `${r.code}|${r.batch_no}`);
      }
      const label = `<div class="label"><div class="txt"><b>${esc(r.name)}</b><br>${esc(r.code)}<br>Batch ${esc(r.batch_no)}<br>Exp ${esc(fmtDate(r.expiry, fmt, tz) || '—')}${r.hold !== 'NONE' ? `<br><b>${esc(r.hold)}</b>` : ''}</div>${code}</div>`;
      for (let i = 0; i < copies; i++) labels.push(label);
    }
    return this.page(labels);
  }
}

@ApiTags('labels')
@Controller('labels')
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  @Get('shelf') @RequirePermissions(Permissions.INVENTORY_READ) @StoreScoped('query.storeId') @Header('Content-Type', 'application/pdf')
  async shelf(@Query() q: ShelfQueryDto, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Disposition', 'inline; filename="shelf-labels.pdf"');
    return new StreamableFile(await this.labels.shelf(q));
  }

  @Get('batches') @RequirePermissions(Permissions.INVENTORY_READ) @Header('Content-Type', 'application/pdf')
  async batches(@Query() q: BatchQueryDto, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Disposition', 'inline; filename="batch-labels.pdf"');
    return new StreamableFile(await this.labels.batches(q));
  }
}

/** Printable shelf and batch labels (Code128 / GS1 DataMatrix). */
@Module({ controllers: [LabelsController], providers: [LabelsService] })
export class LabelsModule {}
