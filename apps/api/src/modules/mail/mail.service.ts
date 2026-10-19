import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import nodemailer, { Transporter } from 'nodemailer';
import { DataSource, EntityManager } from 'typeorm';
import { EmailStatus } from '@sil/shared';
import { loadEnv } from '../../config/env';
import { SettingsService } from '../settings/settings.service';
import { EmailOutbox } from './mail.entities';

export type AttachmentRenderer = (id: string) => Promise<Buffer>;

const MAX_ATTEMPTS = 5;

@Injectable()
export class MailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Mail');
  private readonly renderers = new Map<string, AttachmentRenderer>();
  private timer: NodeJS.Timeout | null = null;
  private transporter: Transporter | null = null;
  private running = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  /** Attachment kinds (e.g. PO_PDF) are rendered by the owning module at send time. */
  registerAttachment(kind: string, renderer: AttachmentRenderer): void {
    this.renderers.set(kind, renderer);
  }

  async enqueue(
    m: EntityManager,
    mail: { to: string; subject: string; text: string; attachments?: { kind: string; id: string; filename: string }[]; doc?: { type: string; id: string } },
  ): Promise<EmailOutbox> {
    const repo = m.getRepository(EmailOutbox);
    return repo.save(
      repo.create({
        toAddress: mail.to,
        subject: mail.subject,
        bodyText: mail.text,
        attachments: mail.attachments ?? [],
        sourceDocType: mail.doc?.type ?? null,
        sourceDocId: mail.doc?.id ?? null,
      }),
    );
  }

  onApplicationBootstrap() {
    const env = loadEnv();
    if (!env.smtpUrl) {
      this.log.log('SMTP_URL not set: outbox sender disabled (mail stays queued)');
      return;
    }
    this.transporter = nodemailer.createTransport(env.smtpUrl);
    this.timer = setInterval(() => {
      // A failing tick (e.g. database not seeded yet) must never take the process down.
      this.processOutbox().catch((e) => this.log.warn(`outbox tick failed: ${(e as Error).message}`));
    }, env.mailPollSeconds * 1000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sends due mail; rows are claimed with SKIP LOCKED so several API instances can run it. */
  async processOutbox(limit = 10): Promise<number> {
    if (this.running || !this.transporter) return 0;
    this.running = true;
    let sent = 0;
    try {
      const from = await this.settings.get('mail.fromAddress');
      for (let i = 0; i < limit; i++) {
        const done = await this.ds.transaction(async (m) => {
          const [row] = await m.query(
            `SELECT id FROM email_outbox WHERE status = 'QUEUED' AND next_attempt_at <= now()
              ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
          );
          if (!row) return false;
          const mail = await m.findOneByOrFail(EmailOutbox, { id: row.id });
          try {
            const attachments = [];
            for (const a of mail.attachments) {
              const render = this.renderers.get(a.kind);
              if (!render) throw new Error(`No renderer for attachment ${a.kind}`);
              attachments.push({ filename: a.filename, content: await render(a.id) });
            }
            await this.transporter!.sendMail({ from, to: mail.toAddress, subject: mail.subject, text: mail.bodyText, attachments });
            mail.status = EmailStatus.SENT;
            mail.sentAt = new Date();
            sent++;
          } catch (e) {
            mail.attempts++;
            mail.lastError = (e as Error).message.slice(0, 1000);
            mail.status = mail.attempts >= MAX_ATTEMPTS ? EmailStatus.FAILED : EmailStatus.QUEUED;
            mail.nextAttemptAt = new Date(Date.now() + 2 ** mail.attempts * 30_000);
            this.log.warn(`mail ${mail.id} failed (attempt ${mail.attempts}): ${mail.lastError}`);
          }
          await m.save(mail);
          return true;
        });
        if (!done) break;
      }
    } finally {
      this.running = false;
    }
    return sent;
  }

  forDocument(type: string, id: string) {
    return this.ds.getRepository(EmailOutbox).find({ where: { sourceDocType: type, sourceDocId: id }, order: { createdAt: 'DESC' } });
  }
}
