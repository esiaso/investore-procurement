import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { Notification } from './approvals.entities';

/** In-app notifications (email delivery comes later). */
@Injectable()
export class NotificationsService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async notify(m: EntityManager, userIds: string[], n: { title: string; body?: string | null; link?: string | null }): Promise<void> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return;
    await m.getRepository(Notification).insert(ids.map((userId) => ({ userId, title: n.title, body: n.body ?? null, link: n.link ?? null })));
  }

  async list(userId: string, unreadOnly: boolean) {
    const repo = this.ds.getRepository(Notification);
    const [items, unread] = await Promise.all([
      repo.find({ where: unreadOnly ? { userId, readAt: IsNull() } : { userId }, order: { createdAt: 'DESC' }, take: 50 }),
      repo.count({ where: { userId, readAt: IsNull() } }),
    ]);
    return { items, unread };
  }

  async markRead(userId: string, ids?: string[]): Promise<void> {
    await this.ds
      .getRepository(Notification)
      .update(ids?.length ? { userId, id: In(ids), readAt: IsNull() } : { userId, readAt: IsNull() }, { readAt: new Date() });
  }
}
