import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type { Paginated } from '@sil/shared';
import { paginate } from '../../common/pagination';
import { AuditLog } from './audit-log.entity';
import { writeAudit } from './audit.subscriber';
import { AuditQueryDto } from './audit.dto';

@Injectable()
export class AuditService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Records a non-CRUD event (login, import, …) or an explicit change. */
  record(entry: Parameters<typeof writeAudit>[1], manager?: EntityManager): Promise<void> {
    return writeAudit(manager ?? this.dataSource.manager, entry);
  }

  list(query: AuditQueryDto): Promise<Paginated<AuditLog>> {
    const qb = this.dataSource.getRepository(AuditLog).createQueryBuilder('a').orderBy('a.id', 'DESC');
    if (query.entityType) qb.andWhere('a.entity_type = :entityType', { entityType: query.entityType });
    if (query.entityId) qb.andWhere('a.entity_id = :entityId', { entityId: query.entityId });
    if (query.userId) qb.andWhere('a.user_id = :userId', { userId: query.userId });
    if (query.action) qb.andWhere('a.action = :action', { action: query.action });
    if (query.from) qb.andWhere('a.occurred_at >= :from', { from: query.from });
    if (query.to) qb.andWhere('a.occurred_at < :to', { to: query.to });
    return paginate(qb, query);
  }
}
