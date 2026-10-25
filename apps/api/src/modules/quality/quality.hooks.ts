import { Injectable, OnModuleInit } from '@nestjs/common';
import { AttachmentOwner, Permissions } from '@sil/shared';
import { AttachmentsService } from '../files/attachments.service';
import { GrnsService } from '../purchasing/grns.service';
import { ColdChainService } from './cold-chain.service';

const exists = (table: string) => async (m: { query: (sql: string, p: unknown[]) => Promise<unknown[]> }, id: string) => (await m.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).length > 0;

/** Receipts: cold-chain goods that arrived out of range are held for the Quality Officer. Files on complaints and recalls. */
@Injectable()
export class QualityHooks implements OnModuleInit {
  constructor(
    private readonly grns: GrnsService,
    private readonly cold: ColdChainService,
    private readonly attachments: AttachmentsService,
  ) {}

  onModuleInit() {
    this.grns.registerPostHook(async (m, grn, lines, actor) => {
      const batchIds = [...new Set(lines.filter((l) => l.batchId && l.acceptedBaseQty > 0).map((l) => l.batchId!))];
      await this.cold.checkReceipt(m, grn, batchIds, actor.id);
    });
    this.attachments.registerOwner(AttachmentOwner.COMPLAINT, { read: [Permissions.QUALITY_READ], write: [Permissions.QUALITY_MANAGE], visible: exists('quality_complaint') });
    this.attachments.registerOwner(AttachmentOwner.RECALL, { read: [Permissions.QUALITY_READ, Permissions.RECALLS_MANAGE], write: [Permissions.RECALLS_MANAGE], visible: exists('recall') });
  }
}
