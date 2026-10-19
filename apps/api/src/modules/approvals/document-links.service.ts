import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DocumentLink } from './approvals.entities';

export interface DocRef {
  type: string;
  id: string;
  no: string;
}

export interface DocStatusResolver {
  (ids: string[]): Promise<Map<string, { status: string; date?: string | null; amount?: number | null }>>;
}

/** Links documents into a chain that can be walked in both directions. */
@Injectable()
export class DocumentLinksService {
  private readonly resolvers = new Map<string, DocStatusResolver>();

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Modules register how to fetch status/amount of their document types for the chain view. */
  registerResolver(type: string, resolver: DocStatusResolver): void {
    this.resolvers.set(type, resolver);
  }

  async link(m: EntityManager, from: DocRef, to: DocRef): Promise<void> {
    await m.query(
      `INSERT INTO document_link (from_type, from_id, from_no, to_type, to_id, to_no) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (from_type, from_id, to_type, to_id) DO NOTHING`,
      [from.type, from.id, from.no, to.type, to.id, to.no],
    );
  }

  /** Every document reachable from the start document, following links both ways. */
  async chain(type: string, id: string) {
    const nodes = new Map<string, DocRef>();
    const edges = new Map<string, { from: string; to: string }>();
    let frontier = [{ type, id }];
    const key = (t: string, i: string) => `${t}:${i}`;
    for (let depth = 0; depth < 10 && frontier.length; depth++) {
      const rows: DocumentLink[] = await this.ds.query(
        `SELECT from_type AS "fromType", from_id AS "fromId", from_no AS "fromNo", to_type AS "toType", to_id AS "toId", to_no AS "toNo"
           FROM document_link
          WHERE (from_type, from_id) IN (SELECT * FROM unnest($1::varchar[], $2::uuid[]))
             OR (to_type, to_id) IN (SELECT * FROM unnest($1::varchar[], $2::uuid[]))`,
        [frontier.map((f) => f.type), frontier.map((f) => f.id)],
      );
      const next: { type: string; id: string }[] = [];
      for (const r of rows) {
        for (const ref of [
          { type: r.fromType, id: r.fromId, no: r.fromNo },
          { type: r.toType, id: r.toId, no: r.toNo },
        ]) {
          const k = key(ref.type, ref.id);
          if (!nodes.has(k)) {
            nodes.set(k, ref);
            next.push(ref);
          }
        }
        edges.set(`${key(r.fromType, r.fromId)}>${key(r.toType, r.toId)}`, { from: key(r.fromType, r.fromId), to: key(r.toType, r.toId) });
      }
      frontier = next;
    }
    // Enrich with status/amount per type.
    const byType = new Map<string, DocRef[]>();
    for (const n of nodes.values()) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
    const details = new Map<string, { status: string; date?: string | null; amount?: number | null }>();
    for (const [t, refs] of byType) {
      const resolver = this.resolvers.get(t);
      if (!resolver) continue;
      const found = await resolver(refs.map((r) => r.id));
      for (const [docId, d] of found) details.set(key(t, docId), d);
    }
    return {
      nodes: [...nodes.entries()].map(([k, n]) => ({ key: k, ...n, ...(details.get(k) ?? {}) })),
      edges: [...edges.values()],
    };
  }
}
