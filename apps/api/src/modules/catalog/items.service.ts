import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ControlledSchedule, DocumentType, Paginated, validateAttributes } from '@sil/shared';
import { likeTerm, paginate } from '../../common/pagination';
import { NumberingService } from '../numbering/numbering.service';
import { TaxService } from '../tax/tax.service';
import { CategoriesService } from './categories.service';
import { CreateItemDto, ItemQueryDto, UpdateItemDto } from './catalog.dto';
import { Generic, Item, ItemCategory } from './catalog.entities';
import { GenericsService } from './generics.service';
import { UnitsService } from './units.service';

@Injectable()
export class ItemsService {
  constructor(
    @InjectRepository(Item) private readonly items: Repository<Item>,
    private readonly generics: GenericsService,
    private readonly categories: CategoriesService,
    private readonly units: UnitsService,
    private readonly tax: TaxService,
    private readonly numbering: NumberingService,
  ) {}

  private baseQuery() {
    return this.items
      .createQueryBuilder('item')
      .leftJoinAndSelect('item.generic', 'generic')
      .leftJoinAndSelect('item.category', 'category')
      .leftJoinAndSelect('item.baseUom', 'baseUom')
      .leftJoinAndSelect('item.taxCategory', 'taxCategory');
  }

  /** Search matches item name, brand, code, GTIN/barcode and the generic (INN) name. */
  list(query: ItemQueryDto): Promise<Paginated<Item>> {
    const qb = this.baseQuery().orderBy('item.name', 'ASC');
    if (query.search) {
      qb.andWhere(
        `(item.name ILIKE :q OR item.brand_name ILIKE :q OR item.code ILIKE :q OR item.gtin = :exact
          OR item.barcode = :exact OR generic.inn_name ILIKE :q OR item.manufacturer ILIKE :q)`,
        { q: likeTerm(query.search), exact: query.search.trim() },
      );
    }
    if (query.genericId) qb.andWhere('item.generic_id = :genericId', { genericId: query.genericId });
    if (query.categoryId) qb.andWhere('item.category_id = :categoryId', { categoryId: query.categoryId });
    if (query.formulary !== undefined) qb.andWhere('item.is_formulary = :f', { f: query.formulary });
    if (query.active !== undefined) qb.andWhere('item.is_active = :a', { a: query.active });
    return paginate(qb, query);
  }

  async get(id: string): Promise<Item> {
    const item = await this.baseQuery().where('item.id = :id', { id }).getOne();
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

  /** Other active brands of the same generic (substitution candidates), cheapest first. */
  async equivalents(id: string): Promise<Item[]> {
    const item = await this.get(id);
    if (!item.genericId) return [];
    return this.baseQuery()
      .where('item.generic_id = :genericId', { genericId: item.genericId })
      .andWhere('item.id <> :id', { id })
      .andWhere('item.is_active = true')
      .orderBy('item.unitPrice', 'ASC')
      .addOrderBy('item.name', 'ASC')
      .getMany();
  }

  async create(dto: CreateItemDto, manager?: EntityManager): Promise<Item> {
    const { category, generic } = await this.validateRefs(dto);
    const run = async (m: EntityManager) => {
      const code = dto.code || (await this.numbering.next(DocumentType.ITEM, { manager: m }));
      const entity = m.create(Item, {
        ...dto,
        code,
        genericId: generic?.id ?? null,
        isControlled: dto.isControlled ?? (generic ? generic.controlledSchedule !== ControlledSchedule.NONE : false),
        attributes: dto.attributes ?? {},
      });
      this.assertAttributes(category, entity.attributes);
      return m.save(entity);
    };
    const saved = manager ? await run(manager) : await this.items.manager.transaction(run);
    return manager ? saved : this.get(saved.id);
  }

  async update(id: string, dto: UpdateItemDto): Promise<Item> {
    const item = await this.items.findOneBy({ id });
    if (!item) throw new NotFoundException('Item not found');
    const merged = { ...item, ...dto } as Item;
    const { category } = await this.validateRefs(merged);
    this.assertAttributes(category, merged.attributes ?? {});
    if (dto.code === null || dto.code === '') delete dto.code; // codes are never cleared
    Object.assign(item, dto);
    await this.items.save(item);
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const item = await this.items.findOneBy({ id });
    if (!item) throw new NotFoundException('Item not found');
    await this.items.remove(item);
  }

  private async validateRefs(
    dto: Pick<CreateItemDto, 'categoryId' | 'genericId' | 'baseUomId' | 'taxCategoryId'>,
  ): Promise<{ category: ItemCategory; generic: Generic | null }> {
    const category = await this.categories.get(dto.categoryId);
    const generic = dto.genericId ? await this.generics.get(dto.genericId) : null;
    if (category.isDrug && !generic) throw new BadRequestException('Items in a drug category must map to a generic');
    await this.units.getUom(dto.baseUomId);
    await this.tax.getCategory(dto.taxCategoryId);
    return { category, generic };
  }

  private assertAttributes(category: ItemCategory, attributes: Record<string, unknown>): void {
    const errors = validateAttributes(category.attributeSchema ?? [], attributes);
    if (Object.keys(errors).length) {
      throw new BadRequestException({ message: 'Invalid category attributes', errors, code: 'ATTRIBUTES' });
    }
  }
}
