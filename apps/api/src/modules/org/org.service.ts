import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { Paginated } from '@sil/shared';
import { likeTerm, paginate, PageQueryDto } from '../../common/pagination';
import { StoreScope } from '../../common/store-scope';
import {
  BinQueryDto,
  CreateBinDto,
  CreateDepartmentDto,
  CreateFacilityDto,
  CreateStoreDto,
  StoreQueryDto,
  UpdateBinDto,
  UpdateDepartmentDto,
  UpdateFacilityDto,
  UpdateStoreDto,
} from './org.dto';
import { Bin, Department, Facility, Store } from './org.entities';

@Injectable()
export class OrgService {
  constructor(
    @InjectRepository(Facility) private readonly facilities: Repository<Facility>,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(Bin) private readonly bins: Repository<Bin>,
    @InjectRepository(Department) private readonly departments: Repository<Department>,
  ) {}

  // ------------------------------------------------------------ facilities

  listFacilities(): Promise<Facility[]> {
    return this.facilities.find({ order: { name: 'ASC' } });
  }

  async getFacility(id: string): Promise<Facility> {
    const f = await this.facilities.findOneBy({ id });
    if (!f) throw new NotFoundException('Facility not found');
    return f;
  }

  createFacility(dto: CreateFacilityDto): Promise<Facility> {
    return this.facilities.save(this.facilities.create(dto));
  }

  async updateFacility(id: string, dto: UpdateFacilityDto): Promise<Facility> {
    const f = await this.getFacility(id);
    return this.facilities.save(Object.assign(f, dto));
  }

  // ------------------------------------------------------------ stores (store-scoped)

  listStores(query: StoreQueryDto): Promise<Paginated<Store>> {
    const qb = this.stores
      .createQueryBuilder('store')
      .leftJoinAndSelect('store.parentStore', 'parent')
      .orderBy('store.name', 'ASC');
    StoreScope.apply(qb, 'store.id');
    if (query.type) qb.andWhere('store.type = :type', { type: query.type });
    if (query.active !== undefined) qb.andWhere('store.is_active = :active', { active: query.active });
    if (query.search) {
      qb.andWhere('(store.name ILIKE :q OR store.code ILIKE :q)', { q: likeTerm(query.search) });
    }
    return paginate(qb, query);
  }

  /** Throws 404 for stores outside the caller's scope (no existence leak). */
  async getStore(id: string): Promise<Store> {
    const qb = this.stores.createQueryBuilder('store').where('store.id = :id', { id });
    StoreScope.apply(qb, 'store.id');
    const store = await qb.getOne();
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async createStore(dto: CreateStoreDto): Promise<Store> {
    await this.getFacility(dto.facilityId);
    if (dto.parentStoreId) await this.getStore(dto.parentStoreId);
    return this.stores.save(this.stores.create(dto));
  }

  async updateStore(id: string, dto: UpdateStoreDto): Promise<Store> {
    const store = await this.getStore(id);
    if (dto.parentStoreId === id) throw new BadRequestException('A store cannot be its own parent');
    if (dto.parentStoreId) await this.getStore(dto.parentStoreId);
    return this.stores.save(Object.assign(store, dto));
  }

  /** Used by other modules (users) to validate store assignments. */
  async findStoresByIds(ids: string[]): Promise<Store[]> {
    if (!ids.length) return [];
    return this.stores.findBy({ id: In(ids) });
  }

  // ------------------------------------------------------------ bins (store-scoped)

  listBins(query: BinQueryDto): Promise<Paginated<Bin>> {
    const qb = this.bins
      .createQueryBuilder('bin')
      .leftJoinAndSelect('bin.store', 'store')
      .orderBy('store.name', 'ASC')
      .addOrderBy('bin.code', 'ASC');
    StoreScope.apply(qb, 'bin.store_id');
    if (query.storeId) qb.andWhere('bin.store_id = :storeId', { storeId: query.storeId });
    if (query.active !== undefined) qb.andWhere('bin.is_active = :active', { active: query.active });
    if (query.search) qb.andWhere('(bin.code ILIKE :q OR bin.name ILIKE :q)', { q: likeTerm(query.search) });
    return paginate(qb, query);
  }

  async getBin(id: string): Promise<Bin> {
    const qb = this.bins.createQueryBuilder('bin').leftJoinAndSelect('bin.store', 'store').where('bin.id = :id', { id });
    StoreScope.apply(qb, 'bin.store_id');
    const bin = await qb.getOne();
    if (!bin) throw new NotFoundException('Bin not found');
    return bin;
  }

  async createBin(dto: CreateBinDto): Promise<Bin> {
    await this.getStore(dto.storeId);
    return this.bins.save(this.bins.create(dto));
  }

  async updateBin(id: string, dto: UpdateBinDto): Promise<Bin> {
    const bin = await this.getBin(id);
    delete bin.store;
    return this.bins.save(Object.assign(bin, dto));
  }

  async deleteBin(id: string): Promise<void> {
    const bin = await this.getBin(id);
    delete bin.store;
    await this.bins.remove(bin);
  }

  // ------------------------------------------------------------ departments

  listDepartments(query: PageQueryDto): Promise<Paginated<Department>> {
    const qb = this.departments.createQueryBuilder('d').orderBy('d.name', 'ASC');
    if (query.search) {
      qb.andWhere('(d.name ILIKE :q OR d.code ILIKE :q OR d.cost_centre_code ILIKE :q)', { q: likeTerm(query.search) });
    }
    return paginate(qb, query);
  }

  async getDepartment(id: string): Promise<Department> {
    const d = await this.departments.findOneBy({ id });
    if (!d) throw new NotFoundException('Department not found');
    return d;
  }

  async createDepartment(dto: CreateDepartmentDto): Promise<Department> {
    await this.getFacility(dto.facilityId);
    return this.departments.save(this.departments.create(dto));
  }

  async updateDepartment(id: string, dto: UpdateDepartmentDto): Promise<Department> {
    const d = await this.getDepartment(id);
    if (dto.facilityId) await this.getFacility(dto.facilityId);
    return this.departments.save(Object.assign(d, dto));
  }

  async deleteDepartment(id: string): Promise<void> {
    await this.departments.remove(await this.getDepartment(id));
  }
}
