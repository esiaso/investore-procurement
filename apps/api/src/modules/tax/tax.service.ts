import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TaxTreatment } from '@sil/shared';
import { SettingsService } from '../settings/settings.service';
import { CreateTaxCategoryDto, CreateTaxRateDto, UpdateTaxCategoryDto } from './tax.dto';
import { TaxCategory, TaxRate } from './tax.entities';

@Injectable()
export class TaxService {
  constructor(
    @InjectRepository(TaxCategory) private readonly categories: Repository<TaxCategory>,
    @InjectRepository(TaxRate) private readonly rates: Repository<TaxRate>,
    private readonly settings: SettingsService,
  ) {}

  listCategories(): Promise<TaxCategory[]> {
    return this.categories.find({ relations: { rates: true }, order: { code: 'ASC', rates: { effectiveFrom: 'DESC' } } });
  }

  async getCategory(id: string): Promise<TaxCategory> {
    const cat = await this.categories.findOne({ where: { id }, relations: { rates: true } });
    if (!cat) throw new NotFoundException('Tax category not found');
    return cat;
  }

  findCategoryByCode(code: string): Promise<TaxCategory | null> {
    return this.categories.createQueryBuilder('c').where('lower(c.code) = lower(:code)', { code }).getOne();
  }

  createCategory(dto: CreateTaxCategoryDto): Promise<TaxCategory> {
    return this.categories.save(this.categories.create(dto));
  }

  async updateCategory(id: string, dto: UpdateTaxCategoryDto): Promise<TaxCategory> {
    const cat = await this.getCategory(id);
    Object.assign(cat, dto);
    delete cat.rates;
    return this.categories.save(cat);
  }

  async addRate(dto: CreateTaxRateDto): Promise<TaxRate> {
    const category = await this.getCategory(dto.taxCategoryId);
    if (category.treatment !== TaxTreatment.STANDARD && dto.ratePercent !== 0) {
      throw new BadRequestException('Zero-rated and exempt categories must have a 0% rate');
    }
    const to = dto.effectiveTo ?? null;
    if (to && to < dto.effectiveFrom) throw new BadRequestException('effectiveTo is before effectiveFrom');
    const overlap = (category.rates ?? []).find(
      (r) => (r.effectiveTo === null || r.effectiveTo >= dto.effectiveFrom) && (to === null || r.effectiveFrom <= to),
    );
    if (overlap) {
      throw new BadRequestException(
        `Overlaps the rate effective from ${overlap.effectiveFrom}; close that rate (set effectiveTo) first`,
      );
    }
    return this.rates.save(this.rates.create({ ...dto, effectiveTo: to }));
  }

  async closeRate(id: string, effectiveTo: string): Promise<TaxRate> {
    const rate = await this.rates.findOneBy({ id });
    if (!rate) throw new NotFoundException('Tax rate not found');
    if (effectiveTo < rate.effectiveFrom) throw new BadRequestException('effectiveTo is before effectiveFrom');
    rate.effectiveTo = effectiveTo;
    return this.rates.save(rate);
  }

  /** The rate (percent) in force for a category on a date (YYYY-MM-DD, default today). */
  async rateFor(taxCategoryId: string, date?: string): Promise<number> {
    const on = date ?? (await this.settings.today());
    const rate = await this.rates
      .createQueryBuilder('r')
      .where('r.tax_category_id = :taxCategoryId', { taxCategoryId })
      .andWhere('r.effective_from <= :on', { on })
      .andWhere('(r.effective_to IS NULL OR r.effective_to >= :on)', { on })
      .orderBy('r.effectiveFrom', 'DESC')
      .getOne();
    if (!rate) throw new NotFoundException(`No tax rate configured for category on ${on}`);
    return rate.ratePercent;
  }
}
