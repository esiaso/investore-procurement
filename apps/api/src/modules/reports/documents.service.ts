import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AttachmentOwner, Paginated, SessionUser } from '@sil/shared';
import { StoreScope } from '../../common/store-scope';
import { AttachmentsService } from '../files/attachments.service';
import { SettingsService } from '../settings/settings.service';

/** How each owner type reads in the register: its number / name, a link, and its store (for scoping). */
const OWNERS: Record<string, { sql: string; type: string }> = {
  [AttachmentOwner.SUPPLIER_DOCUMENT]: {
    type: 'Supplier document',
    sql: `SELECT s.name || ' · ' || d.document_type || COALESCE(' ' || d.reference, '') AS label, '/suppliers' AS link, NULL::uuid AS store_id FROM supplier_document d JOIN supplier s ON s.id = d.supplier_id WHERE d.id = a.owner_id`,
  },
  [AttachmentOwner.PORTAL_SUBMISSION]: {
    type: 'Supplier submission',
    sql: `SELECT s.name || ' · ' || x.reference AS label, '/portal-documents' AS link, NULL::uuid AS store_id FROM supplier_submission x JOIN supplier s ON s.id = x.supplier_id WHERE x.id = a.owner_id`,
  },
  [AttachmentOwner.TENDER]: { type: 'Tender', sql: `SELECT t.number || ' ' || t.title AS label, '/tenders/' || t.id AS link, NULL::uuid AS store_id FROM tender t WHERE t.id = a.owner_id` },
  [AttachmentOwner.GRN]: { type: 'Goods received note', sql: `SELECT g.number AS label, '/grns/' || g.id AS link, g.store_id FROM goods_received_note g WHERE g.id = a.owner_id` },
  [AttachmentOwner.DISPOSAL]: { type: 'Disposal', sql: `SELECT d.number AS label, '/disposals/' || d.id AS link, d.store_id FROM disposal d WHERE d.id = a.owner_id` },
  [AttachmentOwner.COMPLAINT]: { type: 'Quality complaint', sql: `SELECT c.number AS label, '/quality/complaints' AS link, c.store_id FROM quality_complaint c WHERE c.id = a.owner_id` },
  [AttachmentOwner.RECALL]: { type: 'Recall', sql: `SELECT r.number AS label, '/recalls/' || r.id AS link, NULL::uuid AS store_id FROM recall r WHERE r.id = a.owner_id` },
  [AttachmentOwner.ASSET]: { type: 'Asset', sql: `SELECT x.tag_no AS label, '/assets/' || x.id AS link, x.store_id FROM asset x WHERE x.id = a.owner_id` },
  [AttachmentOwner.SERVICE_CERTIFICATE]: { type: 'Service certificate', sql: `SELECT c.number AS label, '/service-certificates/' || c.id AS link, NULL::uuid AS store_id FROM service_certificate c WHERE c.id = a.owner_id` },
  [AttachmentOwner.STOCK_ADJUSTMENT]: { type: 'Stock adjustment', sql: `SELECT x.number AS label, '/adjustments' AS link, x.store_id FROM stock_adjustment x WHERE x.id = a.owner_id` },
  [AttachmentOwner.STAFF_REQUISITION]: { type: 'Requisition', sql: `SELECT x.number AS label, '/staff-requisitions/' || x.id AS link, NULL::uuid AS store_id FROM staff_requisition x WHERE x.id = a.owner_id` },
};

export interface DocumentRow {
  id: string;
  ownerType: string;
  ownerTypeName: string;
  ownerId: string;
  owner: string | null;
  link: string | null;
  category: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  isCurrent: boolean;
  generated: boolean;
  uploadedBy: string | null;
  createdAt: string;
  notes: string | null;
}

/**
 * The documents register: every attachment (delivery notes, certificates,
 * bid documents, licences, disposal certificates…) the user may read, across
 * the records they belong to, with versions; and supplier documents expiring.
 */
@Injectable()
export class DocumentsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly attachments: AttachmentsService,
    private readonly settings: SettingsService,
  ) {}

  async list(
    q: { page: number; pageSize: number; search?: string; ownerType?: string; category?: string; from?: string; to?: string; currentOnly?: boolean; generated?: boolean },
    user: SessionUser,
  ): Promise<Paginated<DocumentRow>> {
    const types = this.attachments.readableOwnerTypes(user).filter((t) => OWNERS[t] && (!q.ownerType || q.ownerType === t));
    if (!types.length) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const where = [`a.owner_type = ANY(${p(types)}::text[])`];
    const scope = StoreScope.current();
    if (scope !== null) where.push(`(o.store_id IS NULL OR o.store_id = ANY(${p(scope)}::uuid[]))`);
    where.push('o.label IS NOT NULL');
    if (q.currentOnly !== false) where.push('a.is_current');
    if (q.generated !== undefined) where.push(`a.generated = ${p(q.generated)}`);
    if (q.category) where.push(`a.category = ${p(q.category)}`);
    const zone = await this.settings.get('locale.timezone');
    const tz = () => p(zone);
    if (q.from) where.push(`(a.created_at AT TIME ZONE ${tz()})::date >= ${p(q.from)}::date`);
    if (q.to) where.push(`(a.created_at AT TIME ZONE ${tz()})::date <= ${p(q.to)}::date`);
    if (q.search) where.push(`(a.file_name ILIKE ${p(`%${q.search}%`)} OR o.label ILIKE $${params.length} OR a.notes ILIKE $${params.length} OR a.sha256 = ${p(q.search.toLowerCase())})`);
    const lateral = types.map((t) => `(${OWNERS[t].sql} AND a.owner_type = '${t}')`).join(' UNION ALL ');
    const from = `FROM attachment a LEFT JOIN LATERAL (${lateral} LIMIT 1) o ON true LEFT JOIN app_user u ON u.id = a.uploaded_by WHERE ${where.join(' AND ')}`;
    const [{ total }] = await this.ds.query(`SELECT COUNT(*)::int AS total ${from}`, params);
    const rows = await this.ds.query(
      `SELECT a.id, a.owner_type AS "ownerType", a.owner_id AS "ownerId", o.label AS owner, o.link, a.category, a.file_name AS "fileName", a.mime_type AS "mimeType",
              a.size_bytes::float AS "sizeBytes", a.version, a.is_current AS "isCurrent", a.generated, u.full_name AS "uploadedBy", a.created_at AS "createdAt", a.notes
         ${from} ORDER BY a.created_at DESC LIMIT ${p(q.pageSize)} OFFSET ${p((q.page - 1) * q.pageSize)}`,
      params,
    );
    return { items: rows.map((r: DocumentRow) => ({ ...r, ownerTypeName: OWNERS[r.ownerType]?.type ?? r.ownerType })), total, page: q.page, pageSize: q.pageSize };
  }

  /** Owner types and categories in use, for the filters. */
  async facets(user: SessionUser) {
    const types = this.attachments.readableOwnerTypes(user).filter((t) => OWNERS[t]);
    const cats: { category: string }[] = types.length ? await this.ds.query(`SELECT DISTINCT category FROM attachment WHERE owner_type = ANY($1::text[]) ORDER BY 1`, [types]) : [];
    return { ownerTypes: types.map((t) => ({ value: t, label: OWNERS[t].type })), categories: cats.map((c) => c.category) };
  }

  /** Supplier licences, certificates and registrations expired or expiring within `days`. */
  async expiring(days: number) {
    const today = await this.settings.today();
    return this.ds.query(
      `SELECT d.id, s.id AS "supplierId", s.name AS supplier, d.document_type AS "documentType", d.reference, d.issued_on::text AS "issuedOn", d.expires_on::text AS "expiresOn",
              (d.expires_on - $1::date) AS "daysLeft", (SELECT COUNT(*)::int FROM attachment a WHERE a.owner_type = 'SUPPLIER_DOCUMENT' AND a.owner_id = d.id AND a.is_current) AS files
         FROM supplier_document d JOIN supplier s ON s.id = d.supplier_id
        WHERE d.expires_on IS NOT NULL AND d.expires_on <= $1::date + $2::int AND s.status::text <> 'BLACKLISTED'
        ORDER BY d.expires_on`,
      [today, days],
    );
  }
}
