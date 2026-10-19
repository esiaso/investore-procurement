import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { financialYearOf, formatDocumentNumber } from './financial-year';
import { DocumentSequence, NumberingScheme } from './numbering.entities';
import { CreateNumberingSchemeDto, UpdateNumberingSchemeDto } from './numbering.dto';

export interface NextNumberOptions {
  storeId?: string | null;
  /** Document date (YYYY-MM-DD); defaults to today in the configured timezone. */
  date?: string;
  /**
   * Run inside the caller's transaction so the number is only consumed if the
   * document is committed (gap-free numbering).
   */
  manager?: EntityManager;
}

@Injectable()
export class NumberingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(NumberingScheme) private readonly schemes: Repository<NumberingScheme>,
    private readonly settings: SettingsService,
  ) {}

  list(): Promise<NumberingScheme[]> {
    return this.schemes.find({ relations: { store: true }, order: { documentType: 'ASC' } });
  }

  async create(dto: CreateNumberingSchemeDto): Promise<NumberingScheme> {
    this.validateFormat(dto.format);
    return this.schemes.save(this.schemes.create(dto));
  }

  async update(id: string, dto: UpdateNumberingSchemeDto): Promise<NumberingScheme> {
    const scheme = await this.schemes.findOneBy({ id });
    if (!scheme) throw new NotFoundException('Numbering scheme not found');
    if (dto.format) this.validateFormat(dto.format);
    Object.assign(scheme, dto);
    return this.schemes.save(scheme);
  }

  private validateFormat(format: string): void {
    if (!format.includes('{SEQ}')) throw new BadRequestException('Format must contain {SEQ}');
  }

  /** Allocates the next number for a document type. */
  async next(documentType: string, options: NextNumberOptions = {}): Promise<string> {
    if (options.manager) return this.allocate(options.manager, documentType, options);
    return this.dataSource.transaction((manager) => this.allocate(manager, documentType, options));
  }

  private async allocate(manager: EntityManager, documentType: string, options: NextNumberOptions): Promise<string> {
    const repo = manager.getRepository(NumberingScheme);
    const storeId = options.storeId ?? null;
    const scheme =
      (storeId &&
        (await repo.findOne({ where: { documentType, storeId, isActive: true }, relations: { store: true } }))) ||
      (await repo.findOne({ where: { documentType, storeId: IsNull(), isActive: true } }));
    if (!scheme) throw new BadRequestException(`No numbering scheme configured for ${documentType}`);

    const date = options.date ?? (await this.settings.today(manager));
    const fy = financialYearOf(date, await this.settings.get('finance.fyStartMonth', manager));
    const period = scheme.resetEachYear ? fy.label : 'ALL';

    // Make sure the counter row exists, then lock it for the rest of the transaction.
    await manager.query(
      `INSERT INTO document_sequence (scheme_id, period, next_value) VALUES ($1, $2, 1)
       ON CONFLICT (scheme_id, period) DO NOTHING`,
      [scheme.id, period],
    );
    const [row] = await manager.query(
      `SELECT id, next_value FROM document_sequence WHERE scheme_id = $1 AND period = $2 FOR UPDATE`,
      [scheme.id, period],
    );
    const seq = Number(row.next_value);
    await manager.query(`UPDATE document_sequence SET next_value = next_value + 1 WHERE id = $1`, [row.id]);

    let storeCode: string | null = scheme.store?.code ?? null;
    if (!storeCode && storeId && scheme.format.includes('{STORE}')) {
      const [store] = await manager.query(`SELECT code FROM store WHERE id = $1`, [storeId]);
      storeCode = store?.code ?? null;
    }

    return formatDocumentNumber(scheme.format, {
      prefix: scheme.prefix,
      storeCode,
      fyLabel: fy.label,
      date,
      seq,
      padding: scheme.padding,
    });
  }

  /** For DocumentSequence lookups in tests and admin screens. */
  sequences(): Promise<DocumentSequence[]> {
    return this.dataSource.getRepository(DocumentSequence).find();
  }
}
