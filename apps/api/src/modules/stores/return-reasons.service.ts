import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { ReturnReasonKind } from '@sil/shared';
import { ReturnReason } from '../inventory/documents.entities';
import { ReturnReasonDto } from './stores.dto';

/** Reason codes for department and supplier returns (data, editable at runtime). */
@Injectable()
export class ReturnReasonsService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  list(kind?: 'DEPARTMENT' | 'SUPPLIER', includeInactive = false) {
    const where: Record<string, unknown> = {};
    if (kind) where.kind = In([kind, ReturnReasonKind.BOTH]);
    if (!includeInactive) where.isActive = true;
    return this.ds.getRepository(ReturnReason).find({ where, order: { name: 'ASC' } });
  }

  async create(dto: ReturnReasonDto) {
    const repo = this.ds.getRepository(ReturnReason);
    const code = dto.code.trim().toUpperCase();
    if (await repo.existsBy({ code })) throw new ConflictException(`Reason ${code} already exists`);
    return repo.save(repo.create({ ...dto, code, isActive: dto.isActive ?? true }));
  }

  /** The code is the key used on documents and cannot change. */
  async update(id: string, dto: ReturnReasonDto) {
    const repo = this.ds.getRepository(ReturnReason);
    const r = await repo.findOneBy({ id });
    if (!r) throw new NotFoundException('Reason not found');
    if (dto.code.trim().toUpperCase() !== r.code) throw new ConflictException('The code of a reason cannot be changed; deactivate it and add a new one');
    r.name = dto.name;
    r.kind = dto.kind;
    if (dto.isActive !== undefined) r.isActive = dto.isActive;
    return repo.save(r);
  }
}
