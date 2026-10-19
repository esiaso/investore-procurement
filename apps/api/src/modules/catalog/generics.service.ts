import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { Paginated } from '@sil/shared';
import { likeTerm, paginate } from '../../common/pagination';
import { CreateGenericDto, GenericQueryDto, UpdateGenericDto } from './catalog.dto';
import { Generic } from './catalog.entities';

/** Identity parts are stored as '' rather than NULL so the unique index applies. */
export function normaliseGenericIdentity(dto: Partial<CreateGenericDto>): DeepPartial<Generic> {
  const out: Record<string, unknown> = { ...dto };
  for (const key of ['strength', 'dosageForm', 'route'] as const) {
    if (key in dto) out[key] = (dto[key] ?? '').trim();
  }
  if (dto.innName !== undefined) out.innName = dto.innName.trim();
  return out as DeepPartial<Generic>;
}

@Injectable()
export class GenericsService {
  constructor(@InjectRepository(Generic) private readonly generics: Repository<Generic>) {}

  list(query: GenericQueryDto): Promise<Paginated<Generic>> {
    const qb = this.generics.createQueryBuilder('g').orderBy('g.innName', 'ASC').addOrderBy('g.strength', 'ASC');
    if (query.includeItems) {
      qb.leftJoinAndSelect('g.items', 'item', 'item.is_active = true').addOrderBy('item.name', 'ASC');
    }
    if (query.search) {
      const q = likeTerm(query.search);
      // A brand name or code also finds its generic.
      qb.andWhere(
        `(g.inn_name ILIKE :q OR g.atc_code ILIKE :q OR g.therapeutic_class ILIKE :q OR g.id IN (
           SELECT i.generic_id FROM item i WHERE i.generic_id IS NOT NULL AND (i.name ILIKE :q OR i.brand_name ILIKE :q OR i.code ILIKE :q)
         ))`,
        { q },
      );
    }
    if (query.keml !== undefined) qb.andWhere('g.is_keml = :keml', { keml: query.keml });
    if (query.active !== undefined) qb.andWhere('g.is_active = :active', { active: query.active });
    return paginate(qb, query);
  }

  async get(id: string, withItems = false): Promise<Generic> {
    const generic = await this.generics.findOne({
      where: { id },
      relations: withItems ? { items: { baseUom: true } } : undefined,
    });
    if (!generic) throw new NotFoundException('Generic not found');
    return generic;
  }

  create(dto: CreateGenericDto): Promise<Generic> {
    return this.generics.save(this.generics.create(normaliseGenericIdentity(dto)));
  }

  async update(id: string, dto: UpdateGenericDto): Promise<Generic> {
    const generic = await this.get(id);
    return this.generics.save(Object.assign(generic, normaliseGenericIdentity(dto)));
  }

  async remove(id: string): Promise<void> {
    await this.generics.remove(await this.get(id));
  }
}
