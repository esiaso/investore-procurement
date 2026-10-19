import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import {
  AuditAction,
  ControlledSchedule,
  DocumentType,
  ImportIssue,
  ImportReport,
  ITEM_IMPORT_COLUMNS,
  ItemImportRow,
  itemImportRowSchema,
} from '@sil/shared';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { SettingsService } from '../settings/settings.service';
import { TaxCategory } from '../tax/tax.entities';
import { Generic, Item, ItemCategory, UnitOfMeasure } from './catalog.entities';

type RawRow = Record<string, unknown>;

interface PlannedRow {
  row: number;
  data: ItemImportRow;
  category: ItemCategory;
  uom: UnitOfMeasure;
  taxCategory: TaxCategory;
  genericKey: string | null;
  existingGenericId: string | null;
}

const REQUIRED_COLUMNS = ['name', 'category_code', 'base_uom', 'unit_price', 'tax_category'];

export const normaliseHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export function genericKey(inn: string, strength?: string | null, form?: string | null, route?: string | null): string {
  return [inn, strength, form, route].map(lc).join('|');
}

/** Same brand of the same generic in the same pack, or same name+pack for non-drugs. */
function identityKey(genericKeyValue: string | null, brandOrName: string, packSize?: string | null): string {
  return `${genericKeyValue ?? 'non-drug'}#${lc(brandOrName)}#${lc(packSize)}`;
}

@Injectable()
export class ItemImportService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  template(): string {
    const example1 = [
      '', 'Amoxil 500mg Capsules', 'DRUG-ANTIINF', 'Amoxicillin', '500 mg', 'Capsule', 'Oral', 'J01CA04', 'Y',
      'Amoxil', 'GlaxoSmithKline', 'PPB/SAMPLE/0001', '10x10', '', 'CAP', '12.50', 'POM', 'EXEMPT', 'Y', 'Y', 'N', 'N',
    ];
    const example2 = [
      '', 'Examination gloves nitrile M (box 100)', 'SUP-PPE', '', '', '', '', '', '', '', 'Sample Medical Ltd', '',
      'Box of 100', '', 'PCS', '9.00', '', 'STANDARD', 'N', 'N', 'N', 'N',
    ];
    return [ITEM_IMPORT_COLUMNS.join(','), example1.join(','), example2.join(',')].join('\n') + '\n';
  }

  async parseFile(buffer: Buffer, filename: string): Promise<RawRow[]> {
    const name = filename.toLowerCase();
    if (name.endsWith('.csv')) {
      try {
        return parseCsv(buffer, {
          columns: (header: string[]) => header.map(normaliseHeader),
          bom: true,
          trim: true,
          skip_empty_lines: true,
        }) as RawRow[];
      } catch (e) {
        throw new BadRequestException(`Could not read CSV: ${(e as Error).message}`);
      }
    }
    if (name.endsWith('.xlsx')) {
      const workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      } catch (e) {
        throw new BadRequestException(`Could not read Excel file: ${(e as Error).message}`);
      }
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new BadRequestException('The workbook has no sheets');
      const headers: string[] = [];
      sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
        headers[col] = normaliseHeader(cell.text ?? '');
      });
      const rows: RawRow[] = [];
      for (let r = 2; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const out: RawRow = {};
        let empty = true;
        row.eachCell({ includeEmpty: false }, (cell, col) => {
          const key = headers[col];
          if (!key) return;
          const v = cell.value;
          const text = typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'Y' : 'N') : (cell.text ?? '');
          if (text.trim() !== '') empty = false;
          out[key] = text.trim();
        });
        if (!empty) rows.push(out);
      }
      return rows;
    }
    throw new BadRequestException('Upload a .csv or .xlsx file');
  }

  async run(rows: RawRow[], options: { dryRun: boolean; skipDuplicates: boolean }): Promise<ImportReport> {
    const maxRows = await this.settings.get('import.maxRows');
    if (rows.length === 0) throw new BadRequestException('The file has no data rows');
    if (rows.length > maxRows) throw new BadRequestException(`Too many rows (${rows.length}); the limit is ${maxRows}`);
    const missing = REQUIRED_COLUMNS.filter((c) => !(c in rows[0]));
    if (missing.length) throw new BadRequestException(`Missing column(s): ${missing.join(', ')}`);

    const m = this.dataSource.manager;
    const [categories, uoms, taxCategories, generics, existingItems] = await Promise.all([
      m.find(ItemCategory),
      m.find(UnitOfMeasure, { where: { isActive: true } }),
      m.find(TaxCategory, { where: { isActive: true } }),
      m.find(Generic),
      m
        .createQueryBuilder(Item, 'i')
        .leftJoin('i.generic', 'g')
        .select(['i.code AS code', 'i.gtin AS gtin', 'i.name AS name', 'i.brand_name AS brand', 'i.pack_size AS pack'])
        .addSelect(['g.inn_name AS inn', 'g.strength AS strength', 'g.dosage_form AS form', 'g.route AS route'])
        .getRawMany<{ code: string; gtin: string | null; name: string; brand: string | null; pack: string | null; inn: string | null; strength: string | null; form: string | null; route: string | null }>(),
    ]);

    const byCode = <T extends { code: string }>(list: T[]) => new Map(list.map((x) => [lc(x.code), x]));
    const categoryByCode = byCode(categories);
    const uomByCode = byCode(uoms);
    const taxByCode = byCode(taxCategories);
    const genericByKey = new Map(generics.map((g) => [genericKey(g.innName, g.strength, g.dosageForm, g.route), g]));

    const dbCodes = new Set(existingItems.map((i) => lc(i.code)));
    const dbGtins = new Set(existingItems.filter((i) => i.gtin).map((i) => i.gtin!));
    const dbIdentities = new Set(
      existingItems.map((i) =>
        identityKey(i.inn ? genericKey(i.inn, i.strength, i.form, i.route) : null, i.inn ? (i.brand ?? i.name) : i.name, i.pack),
      ),
    );

    const errors: ImportIssue[] = [];
    const duplicates: ImportIssue[] = [];
    const planned: PlannedRow[] = [];
    const fileCodes = new Map<string, number>();
    const fileGtins = new Map<string, number>();
    const fileIdentities = new Map<string, number>();

    rows.forEach((raw, index) => {
      const row = index + 2; // header is row 1
      const parsed = itemImportRowSchema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          errors.push({ row, field: String(issue.path[0] ?? ''), message: issue.message });
        }
        return;
      }
      const data = parsed.data;
      const rowErrors: ImportIssue[] = [];
      const category = categoryByCode.get(lc(data.category_code));
      const uom = uomByCode.get(lc(data.base_uom));
      const taxCategory = taxByCode.get(lc(data.tax_category));
      if (!category) rowErrors.push({ row, field: 'category_code', message: `Unknown category "${data.category_code}"` });
      if (!uom) rowErrors.push({ row, field: 'base_uom', message: `Unknown unit "${data.base_uom}"` });
      if (!taxCategory) rowErrors.push({ row, field: 'tax_category', message: `Unknown tax category "${data.tax_category}"` });
      if (category?.isDrug && !data.generic_inn) {
        rowErrors.push({ row, field: 'generic_inn', message: 'Drug items need a generic (INN) name' });
      }
      if (category && !category.isDrug && data.generic_inn) {
        rowErrors.push({ row, field: 'generic_inn', message: 'Non-drug category items must not have a generic' });
      }
      if (rowErrors.length) {
        errors.push(...rowErrors);
        return;
      }

      const gKey = data.generic_inn
        ? genericKey(data.generic_inn, data.generic_strength, data.generic_dosage_form, data.generic_route)
        : null;
      const identity = identityKey(gKey, gKey ? (data.brand_name ?? data.name) : data.name, data.pack_size);

      const dupes: ImportIssue[] = [];
      if (data.code) {
        const code = lc(data.code);
        if (dbCodes.has(code)) dupes.push({ row, field: 'code', message: `Code ${data.code} already exists` });
        else if (fileCodes.has(code)) dupes.push({ row, field: 'code', message: `Code ${data.code} repeats row ${fileCodes.get(code)}` });
        else fileCodes.set(code, row);
      }
      if (data.gtin) {
        if (dbGtins.has(data.gtin)) dupes.push({ row, field: 'gtin', message: `GTIN ${data.gtin} already exists` });
        else if (fileGtins.has(data.gtin)) dupes.push({ row, field: 'gtin', message: `GTIN ${data.gtin} repeats row ${fileGtins.get(data.gtin)}` });
        else fileGtins.set(data.gtin, row);
      }
      if (dbIdentities.has(identity)) {
        dupes.push({ row, field: 'name', message: 'Same item (generic/brand/pack) already exists' });
      } else if (fileIdentities.has(identity)) {
        dupes.push({ row, field: 'name', message: `Same item (generic/brand/pack) repeats row ${fileIdentities.get(identity)}` });
      } else {
        fileIdentities.set(identity, row);
      }
      if (dupes.length) {
        duplicates.push(...dupes);
        return;
      }

      planned.push({
        row,
        data,
        category: category!,
        uom: uom!,
        taxCategory: taxCategory!,
        genericKey: gKey,
        existingGenericId: gKey ? (genericByKey.get(gKey)?.id ?? null) : null,
      });
    });

    const blocked = errors.length > 0 || (duplicates.length > 0 && !options.skipDuplicates);
    const report: ImportReport = {
      dryRun: options.dryRun,
      totalRows: rows.length,
      validRows: planned.length,
      createdItems: 0,
      createdGenerics: 0,
      skippedDuplicates: options.skipDuplicates ? new Set(duplicates.map((d) => d.row)).size : 0,
      errors,
      duplicates,
      committed: false,
    };
    if (options.dryRun || blocked || planned.length === 0) return report;

    // All-or-nothing: one transaction for every generic, item and audit row.
    await this.dataSource.transaction(async (tm) => {
      const newGenerics = new Map<string, string>();
      for (const p of planned) {
        if (!p.genericKey || p.existingGenericId || newGenerics.has(p.genericKey)) continue;
        const g = await tm.save(
          tm.create(Generic, {
            innName: p.data.generic_inn!.trim(),
            strength: (p.data.generic_strength ?? '').trim(),
            dosageForm: (p.data.generic_dosage_form ?? '').trim(),
            route: (p.data.generic_route ?? '').trim(),
            atcCode: p.data.atc_code || null,
            isKeml: p.data.keml ?? false,
            controlledSchedule: ControlledSchedule.NONE,
          }),
        );
        newGenerics.set(p.genericKey, g.id);
      }
      for (const p of planned) {
        const d = p.data;
        await tm.save(
          tm.create(Item, {
            code: d.code ?? (await this.numbering.next(DocumentType.ITEM, { manager: tm })),
            name: d.name,
            categoryId: p.category.id,
            genericId: p.genericKey ? (p.existingGenericId ?? newGenerics.get(p.genericKey)!) : null,
            brandName: d.brand_name ?? null,
            manufacturer: d.manufacturer ?? null,
            ppbRegNo: d.ppb_reg_no ?? null,
            packSize: d.pack_size ?? null,
            gtin: d.gtin ?? null,
            baseUomId: p.uom.id,
            unitPrice: d.unit_price,
            salesClass: d.sales_class ?? null,
            taxCategoryId: p.taxCategory.id,
            isFormulary: d.formulary ?? false,
            isBatchTracked: d.batch_tracked ?? p.category.isDrug,
            isColdChain: d.cold_chain ?? false,
            isControlled: d.controlled ?? false,
            attributes: {},
          }),
        );
      }
      report.createdGenerics = newGenerics.size;
      report.createdItems = planned.length;
      await this.audit.record(
        {
          action: AuditAction.IMPORT,
          entityType: 'Item',
          entityId: null,
          after: { createdItems: report.createdItems, createdGenerics: report.createdGenerics, rows: rows.length },
        },
        tm,
      );
    });
    report.committed = true;
    return report;
  }
}
