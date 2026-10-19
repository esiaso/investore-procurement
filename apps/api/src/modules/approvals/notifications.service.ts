import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { NotificationCategory } from '@sil/shared';
import { MailService } from '../mail/mail.service';
import { SettingsService } from '../settings/settings.service';
import { Notification, NotificationPreference } from './approvals.entities';
import { EmailNotifier, InAppNotifier, Message, Notifier, Recipient, SmsNotifierStub } from './notifiers';

export interface PreferenceView {
  category: NotificationCategory;
  inApp: boolean;
  email: boolean;
  sms: boolean;
}

/** In-app notifications, plus channel dispatch by per-user preference. */
@Injectable()
export class NotificationsService {
  private readonly notifiers: Notifier[];

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
    mail: MailService,
  ) {
    this.notifiers = [new InAppNotifier(), new EmailNotifier(mail), new SmsNotifierStub()];
  }

  /** In-app only (approvals and other workflow messages). */
  async notify(m: EntityManager, userIds: string[], n: { title: string; body?: string | null; link?: string | null }): Promise<void> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return;
    await m.getRepository(Notification).insert(ids.map((userId) => ({ userId, title: n.title, body: n.body ?? null, link: n.link ?? null })));
  }

  /**
   * Sends a message on every channel each user has on for the category.
   * Returns how many users received it on at least one channel.
   */
  async dispatch(m: EntityManager, userIds: string[], category: NotificationCategory, msg: Message): Promise<number> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return 0;
    const users: Recipient[] = await m.query(`SELECT id, email, phone FROM app_user WHERE id = ANY($1::uuid[]) AND is_active`, [ids]);
    const prefs = await this.preferencesFor(m, users.map((u) => u.id), category);
    const reached = new Set<string>();
    for (const notifier of this.notifiers) {
      const to = users.filter((u) => prefs.get(u.id)![notifier.channel]);
      if (!to.length) continue;
      await notifier.send(m, to, msg);
      for (const u of to) if (notifier.channel !== 'sms') reached.add(u.id);
    }
    return reached.size;
  }

  private async preferencesFor(m: EntityManager, userIds: string[], category: NotificationCategory) {
    const emailDefault = await this.settings.get('notify.emailDefault', m);
    const rows = await m.find(NotificationPreference, { where: { userId: In(userIds), category } });
    return new Map(
      userIds.map((id) => {
        const p = rows.find((r) => r.userId === id);
        return [id, { inApp: p?.inApp ?? true, email: p?.email ?? emailDefault, sms: p?.sms ?? false }];
      }),
    );
  }

  async preferences(userId: string): Promise<PreferenceView[]> {
    const emailDefault = await this.settings.get('notify.emailDefault');
    const rows = await this.ds.getRepository(NotificationPreference).find({ where: { userId } });
    return Object.values(NotificationCategory).map((category) => {
      const p = rows.find((r) => r.category === category);
      return { category, inApp: p?.inApp ?? true, email: p?.email ?? emailDefault, sms: p?.sms ?? false };
    });
  }

  async setPreferences(userId: string, prefs: PreferenceView[]): Promise<PreferenceView[]> {
    const repo = this.ds.getRepository(NotificationPreference);
    for (const p of prefs) {
      const existing = await repo.findOneBy({ userId, category: p.category });
      if (existing) await repo.save(Object.assign(existing, { inApp: p.inApp, email: p.email, sms: p.sms }));
      else await repo.save(repo.create({ userId, category: p.category, inApp: p.inApp, email: p.email, sms: p.sms }));
    }
    return this.preferences(userId);
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
