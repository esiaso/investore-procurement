import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Paginated } from '@sil/shared';
import { likeTerm, paginate } from '../../common/pagination';
import { orderPair, parseInteractionCsv } from './interactions';
import { DrugInteraction } from './pharmacy.entities';
import { InteractionDto, InteractionImportDto, InteractionQueryDto } from './pharmacy.dto';

/** The curated interaction table: CRUD and CSV import (upsert by substance pair). */
@Injectable()
export class DrugInteractionsService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  list(q: InteractionQueryDto): Promise<Paginated<DrugInteraction>> {
    const qb = this.ds.getRepository(DrugInteraction).createQueryBuilder('d').orderBy('d.innA').addOrderBy('d.innB');
    if (q.search) qb.andWhere('(d.inn_a ILIKE :q OR d.inn_b ILIKE :q)', { q: likeTerm(q.search.toLowerCase()) });
    if (q.severity) qb.andWhere('d.severity = :s', { s: q.severity });
    return paginate(qb, q);
  }

  async save(id: string | null, dto: InteractionDto) {
    const [innA, innB] = orderPair(dto.innA, dto.innB);
    if (innA === innB) throw new BadRequestException('Two different substances are needed');
    const repo = this.ds.getRepository(DrugInteraction);
    const row = id ? await repo.findOneBy({ id }) : ((await repo.findOneBy({ innA, innB })) ?? repo.create({ source: 'LOCAL' }));
    if (!row) throw new NotFoundException('Interaction not found');
    Object.assign(row, { innA, innB, severity: dto.severity, mechanism: dto.mechanism, management: dto.management, isActive: dto.isActive ?? true });
    // Editing a demo row makes it a local (curated) one.
    if (row.source === 'DEMO') row.source = 'LOCAL';
    return repo.save(row);
  }

  async import(dto: InteractionImportDto) {
    const { rows, errors } = parseInteractionCsv(dto.csv);
    if (dto.dryRun || errors.length) return { imported: 0, updated: 0, errors, valid: rows.length };
    let imported = 0;
    let updated = 0;
    await this.ds.transaction(async (m) => {
      const repo = m.getRepository(DrugInteraction);
      for (const r of rows) {
        const existing = await repo.findOneBy({ innA: r.innA, innB: r.innB });
        if (existing) updated++;
        else imported++;
        await repo.save(Object.assign(existing ?? repo.create(), { innA: r.innA, innB: r.innB, severity: r.severity, mechanism: r.mechanism, management: r.management, source: r.source ?? 'IMPORT', isActive: true }));
      }
    });
    return { imported, updated, errors, valid: rows.length };
  }
}
