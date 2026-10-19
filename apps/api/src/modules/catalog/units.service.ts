import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { CreateUnitConversionDto, CreateUomDto, UpdateUomDto } from './catalog.dto';
import { Item, UnitConversion, UnitOfMeasure } from './catalog.entities';

/** Quantities are stored with 4 decimals. */
export function roundQty(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

@Injectable()
export class UnitsService {
  constructor(
    @InjectRepository(UnitOfMeasure) private readonly uoms: Repository<UnitOfMeasure>,
    @InjectRepository(UnitConversion) private readonly conversions: Repository<UnitConversion>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
  ) {}

  listUoms(): Promise<UnitOfMeasure[]> {
    return this.uoms.find({ order: { name: 'ASC' } });
  }

  async getUom(id: string): Promise<UnitOfMeasure> {
    const uom = await this.uoms.findOneBy({ id });
    if (!uom) throw new NotFoundException('Unit of measure not found');
    return uom;
  }

  findUomByCode(code: string): Promise<UnitOfMeasure | null> {
    return this.uoms.createQueryBuilder('u').where('lower(u.code) = lower(:code)', { code }).getOne();
  }

  createUom(dto: CreateUomDto): Promise<UnitOfMeasure> {
    return this.uoms.save(this.uoms.create({ ...dto, code: dto.code.toUpperCase() }));
  }

  async updateUom(id: string, dto: UpdateUomDto): Promise<UnitOfMeasure> {
    const uom = await this.getUom(id);
    return this.uoms.save(Object.assign(uom, dto, dto.code ? { code: dto.code.toUpperCase() } : {}));
  }

  listConversions(itemId?: string): Promise<UnitConversion[]> {
    return this.conversions.find({
      where: itemId ? [{ itemId }, { itemId: IsNull() }] : { itemId: IsNull() },
      relations: { fromUom: true, toUom: true },
      order: { createdAt: 'ASC' },
    });
  }

  async createConversion(dto: CreateUnitConversionDto): Promise<UnitConversion> {
    if (dto.fromUomId === dto.toUomId) throw new BadRequestException('From and to units must differ');
    await Promise.all([this.getUom(dto.fromUomId), this.getUom(dto.toUomId)]);
    if (dto.itemId && !(await this.items.existsBy({ id: dto.itemId }))) throw new NotFoundException('Item not found');
    return this.conversions.save(this.conversions.create({ ...dto, itemId: dto.itemId ?? null }));
  }

  async deleteConversion(id: string): Promise<void> {
    const conv = await this.conversions.findOneBy({ id });
    if (!conv) throw new NotFoundException('Conversion not found');
    await this.conversions.remove(conv);
  }

  /**
   * Factor f such that `qty in fromUom × f = qty in item base units`.
   * Walks item-specific and global conversions in both directions.
   */
  async factorToBase(itemId: string, fromUomId: string): Promise<number> {
    const item = await this.items.findOneBy({ id: itemId });
    if (!item) throw new NotFoundException('Item not found');
    if (fromUomId === item.baseUomId) return 1;

    const edges = new Map<string, { to: string; factor: number }[]>();
    const add = (from: string, to: string, factor: number) => {
      if (!edges.has(from)) edges.set(from, []);
      edges.get(from)!.push({ to, factor });
    };
    for (const c of await this.listConversions(itemId)) {
      add(c.fromUomId, c.toUomId, c.factor);
      add(c.toUomId, c.fromUomId, 1 / c.factor);
    }

    // Breadth-first: shortest chain wins (box → strip → tablet).
    const queue: { uom: string; factor: number }[] = [{ uom: fromUomId, factor: 1 }];
    const seen = new Set([fromUomId]);
    while (queue.length) {
      const { uom, factor } = queue.shift()!;
      for (const edge of edges.get(uom) ?? []) {
        if (seen.has(edge.to)) continue;
        const next = factor * edge.factor;
        if (edge.to === item.baseUomId) return next;
        seen.add(edge.to);
        queue.push({ uom: edge.to, factor: next });
      }
    }
    throw new BadRequestException('No conversion path from this unit to the item base unit');
  }

  async convert(itemId: string, quantity: number, fromUomId: string, toUomId?: string): Promise<number> {
    const toBase = await this.factorToBase(itemId, fromUomId);
    if (!toUomId) return roundQty(quantity * toBase);
    const targetToBase = await this.factorToBase(itemId, toUomId);
    return roundQty((quantity * toBase) / targetToBase);
  }
}
