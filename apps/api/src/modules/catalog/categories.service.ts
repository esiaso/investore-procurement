import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttributeType } from '@sil/shared';
import { AttributeDefinitionDto, CreateItemCategoryDto, UpdateItemCategoryDto } from './catalog.dto';
import { ItemCategory } from './catalog.entities';

@Injectable()
export class CategoriesService {
  constructor(@InjectRepository(ItemCategory) private readonly categories: Repository<ItemCategory>) {}

  list(): Promise<ItemCategory[]> {
    return this.categories.find({ order: { name: 'ASC' } });
  }

  async get(id: string): Promise<ItemCategory> {
    const cat = await this.categories.findOneBy({ id });
    if (!cat) throw new NotFoundException('Item category not found');
    return cat;
  }

  findByCode(code: string): Promise<ItemCategory | null> {
    return this.categories.createQueryBuilder('c').where('lower(c.code) = lower(:code)', { code }).getOne();
  }

  async create(dto: CreateItemCategoryDto): Promise<ItemCategory> {
    this.validateSchema(dto.attributeSchema ?? []);
    if (dto.parentId) await this.get(dto.parentId);
    return this.categories.save(
      this.categories.create({
        ...dto,
        parentId: dto.parentId ?? null,
        attributeSchema: (dto.attributeSchema ?? []).map((a) => ({ ...a, required: a.required ?? false })),
      }),
    );
  }

  async update(id: string, dto: UpdateItemCategoryDto): Promise<ItemCategory> {
    const cat = await this.get(id);
    if (dto.attributeSchema) this.validateSchema(dto.attributeSchema);
    if (dto.parentId === id) throw new BadRequestException('A category cannot be its own parent');
    if (dto.parentId) await this.get(dto.parentId);
    Object.assign(cat, dto);
    if (dto.attributeSchema) cat.attributeSchema = dto.attributeSchema.map((a) => ({ ...a, required: a.required ?? false }));
    return this.categories.save(cat);
  }

  async remove(id: string): Promise<void> {
    await this.categories.remove(await this.get(id));
  }

  private validateSchema(defs: AttributeDefinitionDto[]): void {
    const keys = new Set<string>();
    for (const def of defs) {
      if (keys.has(def.key)) throw new BadRequestException(`Duplicate attribute key "${def.key}"`);
      keys.add(def.key);
      if (def.type === AttributeType.ENUM && !def.options?.length) {
        throw new BadRequestException(`Attribute "${def.key}" needs options`);
      }
    }
  }
}
