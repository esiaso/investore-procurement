import { Injectable, OnModuleInit } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AttachmentOwner, Permissions, SessionUser } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { AttachmentsService } from './attachments.service';

const exists = (table: string) => async (m: EntityManager, id: string) => (await m.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).length > 0;

/** Store-scoped records: visible when the user can see the store. */
const inStore = (table: string) => async (m: EntityManager, id: string, actor: SessionUser | null) => {
  const [row] = await m.query(`SELECT store_id FROM ${table} WHERE id = $1`, [id]);
  if (!row) return false;
  const scope = actor ? StoreScope.current() : null;
  return scope === null || scope.includes(row.store_id);
};

/**
 * Who may read and attach files on the record types that existed before file
 * storage (they kept document metadata only until now). Slice-8 modules
 * register their own owner types.
 */
@Injectable()
export class AttachmentOwnersRegistrar implements OnModuleInit {
  constructor(private readonly attachments: AttachmentsService) {}

  onModuleInit() {
    const P = Permissions;
    this.attachments.registerOwner(AttachmentOwner.SUPPLIER_DOCUMENT, { read: [P.SUPPLIERS_READ], write: [P.SUPPLIERS_MANAGE], visible: exists('supplier_document') });
    // Uploaded by suppliers in the portal (the portal checks ownership itself); staff read them.
    this.attachments.registerOwner(AttachmentOwner.PORTAL_SUBMISSION, { read: [P.PURCHASING_READ], write: [], visible: exists('supplier_submission') });
    // Bid documents and addenda issued by the hospital; suppliers download them in the portal.
    this.attachments.registerOwner(AttachmentOwner.TENDER, { read: [P.TENDERS_READ, P.TENDERS_EVALUATE], write: [P.TENDERS_MANAGE], visible: exists('tender') });
    // Delivery notes, packing lists, certificates of analysis received with the goods.
    this.attachments.registerOwner(AttachmentOwner.GRN, { read: [P.PURCHASING_READ], write: [P.PURCHASING_RECEIVE, P.PURCHASING_INSPECT], visible: inStore('goods_received_note') });
    // Disposal certificates of write-offs (generated and signed copies).
    this.attachments.registerOwner(AttachmentOwner.STOCK_ADJUSTMENT, { read: [P.INVENTORY_READ], write: [P.INVENTORY_ADJUST, P.INVENTORY_ADJUST_APPROVE], visible: inStore('stock_adjustment') });
  }
}
