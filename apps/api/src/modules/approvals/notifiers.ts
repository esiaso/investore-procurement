import { Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { MailService } from '../mail/mail.service';
import { Notification } from './approvals.entities';

export interface Recipient {
  id: string;
  email: string | null;
  phone: string | null;
}

export interface Message {
  title: string;
  body?: string | null;
  link?: string | null;
  /** Longer text for email (defaults to body). */
  emailText?: string;
}

/** A delivery channel. Adapters are swapped without touching the callers. */
export interface Notifier {
  readonly channel: 'inApp' | 'email' | 'sms';
  send(m: EntityManager, to: Recipient[], msg: Message): Promise<number>;
}

export class InAppNotifier implements Notifier {
  readonly channel = 'inApp' as const;
  async send(m: EntityManager, to: Recipient[], msg: Message) {
    if (!to.length) return 0;
    await m.getRepository(Notification).insert(to.map((r) => ({ userId: r.id, title: msg.title, body: msg.body ?? null, link: msg.link ?? null })));
    return to.length;
  }
}

/** Queues mail in the outbox (same transaction); the mail poller sends it. */
export class EmailNotifier implements Notifier {
  readonly channel = 'email' as const;
  constructor(private readonly mail: MailService) {}
  async send(m: EntityManager, to: Recipient[], msg: Message) {
    let n = 0;
    for (const r of to) {
      if (!r.email) continue;
      await this.mail.enqueue(m, { to: r.email, subject: msg.title, text: msg.emailText ?? msg.body ?? msg.title });
      n++;
    }
    return n;
  }
}

/** Placeholder until an SMS provider (e.g. Africa's Talking) is chosen: logs and sends nothing. */
export class SmsNotifierStub implements Notifier {
  readonly channel = 'sms' as const;
  private readonly log = new Logger('SMS');
  async send(_m: EntityManager, to: Recipient[], msg: Message) {
    const withPhone = to.filter((r) => r.phone);
    if (withPhone.length) this.log.log(`SMS not configured; would send "${msg.title}" to ${withPhone.length} user(s)`);
    return 0;
  }
}
