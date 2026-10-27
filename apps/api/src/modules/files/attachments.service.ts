import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { PermissionCode, SessionUser } from '@sil/shared';
import { SettingsService } from '../settings/settings.service';
import { Attachment } from './attachment.entity';
import { StorageService } from './storage.service';

export interface OwnerPolicy {
  /** Any of these may list and download (in addition to the owner check). */
  read: PermissionCode[];
  /** Any of these may upload. */
  write: PermissionCode[];
  /** The record exists and the user may see it (store scope, own supplier…). */
  visible(m: EntityManager, ownerId: string, actor: SessionUser | null): Promise<boolean>;
}

export interface UploadInput {
  ownerType: string;
  ownerId: string;
  category: string;
  fileName: string;
  mimeType: string;
  body: Buffer;
  notes?: string | null;
}

/** Leading bytes of the binary types we accept, so a renamed file is refused. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 4).toString('latin1') === '%PDF',
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
};

export const safeFileName = (name: string) =>
  (name.split(/[\\/]/).pop() ?? 'file').replace(/[^\w.\- ()]+/g, '_').slice(0, 200) || 'file';

/**
 * Versioned attachments on any record. Each owner type registers who may read
 * and upload and how to check that the record is visible to the user.
 */
@Injectable()
export class AttachmentsService {
  private readonly owners = new Map<string, OwnerPolicy>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
  ) {}

  registerOwner(type: string, policy: OwnerPolicy) {
    this.owners.set(type, policy);
  }

  /** Owner types and who may read them (the documents register). */
  readableOwnerTypes(user: SessionUser): string[] {
    return [...this.owners.entries()].filter(([, p]) => p.read.some((x) => user.permissions.includes(x))).map(([t]) => t);
  }

  private policy(type: string): OwnerPolicy {
    const p = this.owners.get(type);
    if (!p) throw new BadRequestException(`Files cannot be attached to ${type}`);
    return p;
  }

  private async assertAccess(m: EntityManager, type: string, ownerId: string, actor: SessionUser, mode: 'read' | 'write') {
    const p = this.policy(type);
    const perms = mode === 'read' ? [...p.read, ...p.write] : p.write;
    if (!perms.some((x) => actor.permissions.includes(x))) throw new ForbiddenException('You may not access files on this record');
    if (!(await p.visible(m, ownerId, actor))) throw new NotFoundException('Record not found');
  }

  /** Validates size and type against the settings. */
  async validate(input: Pick<UploadInput, 'mimeType' | 'body' | 'fileName'>, m: EntityManager = this.ds.manager) {
    const maxMb = await this.settings.get('files.maxSizeMb', m);
    if (!input.body.length) throw new BadRequestException('The file is empty');
    if (input.body.length > maxMb * 1024 * 1024) throw new BadRequestException({ code: 'FILE_TOO_LARGE', message: `Files may be at most ${maxMb} MB` });
    const allowed = await this.settings.get('files.allowedMimeTypes', m);
    if (!allowed.includes(input.mimeType)) throw new BadRequestException({ code: 'FILE_TYPE', message: `${input.mimeType || 'This file type'} is not allowed` });
    const check = MAGIC[input.mimeType];
    if (check && !check(input.body)) throw new BadRequestException({ code: 'FILE_TYPE', message: `The file content is not ${input.mimeType}` });
  }

  /** User upload (permission and visibility checked). */
  async upload(input: UploadInput, actor: SessionUser): Promise<Attachment> {
    await this.assertAccess(this.ds.manager, input.ownerType, input.ownerId, actor, 'write');
    await this.validate(input);
    return this.ds.transaction((m) => this.store(m, input, actor.id, false));
  }

  /**
   * Stores a file without the user checks (system-generated documents, or
   * callers that checked access themselves, such as the supplier portal).
   */
  async attach(m: EntityManager, input: UploadInput, userId: string | null, generated = true): Promise<Attachment> {
    if (!generated) await this.validate(input, m);
    return this.store(m, input, userId, generated);
  }

  private async store(m: EntityManager, input: UploadInput, userId: string | null, generated: boolean): Promise<Attachment> {
    const category = input.category.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40) || 'GENERAL';
    const fileName = safeFileName(input.fileName);
    // Serialise versions of the same file.
    await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${input.ownerType}:${input.ownerId}:${category}:${fileName}`]);
    const [{ v }] = await m.query(
      `SELECT COALESCE(MAX(version), 0)::int AS v FROM attachment WHERE owner_type = $1 AND owner_id = $2 AND category = $3 AND file_name = $4`,
      [input.ownerType, input.ownerId, category, fileName],
    );
    const sha256 = createHash('sha256').update(input.body).digest('hex');
    const key = `${input.ownerType.toLowerCase()}/${input.ownerId}/${randomUUID()}-${fileName}`;
    await this.storage.put(key, input.body, input.mimeType);
    await m.update(Attachment, { ownerType: input.ownerType, ownerId: input.ownerId, category, fileName }, { isCurrent: false });
    return m.save(
      m.create(Attachment, {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        category,
        fileName,
        mimeType: input.mimeType,
        sizeBytes: input.body.length,
        sha256,
        storageKey: key,
        version: v + 1,
        isCurrent: true,
        uploadedBy: userId,
        generated,
        notes: input.notes ?? null,
      }),
    );
  }

  async list(ownerType: string, ownerId: string, actor: SessionUser | null, includeVersions = false) {
    if (actor) await this.assertAccess(this.ds.manager, ownerType, ownerId, actor, 'read');
    return this.ds.query(
      `SELECT a.id, a.owner_type AS "ownerType", a.owner_id AS "ownerId", a.category, a.file_name AS "fileName", a.mime_type AS "mimeType",
              a.size_bytes::float AS "sizeBytes", a.sha256, a.version, a.is_current AS "isCurrent", a.generated, a.notes,
              a.created_at AS "uploadedAt", u.full_name AS "uploadedBy"
         FROM attachment a LEFT JOIN app_user u ON u.id = a.uploaded_by
        WHERE a.owner_type = $1 AND a.owner_id = $2 ${includeVersions ? '' : 'AND a.is_current'}
        ORDER BY a.category, a.file_name, a.version DESC`,
      [ownerType, ownerId],
    );
  }

  /** Downloads one version (checks access unless actor is null, i.e. already checked by the caller). */
  async download(id: string, actor: SessionUser | null): Promise<{ attachment: Attachment; body: Buffer }> {
    const a = await this.ds.getRepository(Attachment).findOneBy({ id });
    if (!a) throw new NotFoundException('File not found');
    if (actor) await this.assertAccess(this.ds.manager, a.ownerType, a.ownerId, actor, 'read');
    const body = await this.storage.get(a.storageKey);
    if (createHash('sha256').update(body).digest('hex') !== a.sha256) throw new BadRequestException({ code: 'FILE_CORRUPT', message: 'The stored file does not match its checksum' });
    return { attachment: a, body };
  }

  get(id: string) {
    return this.ds.getRepository(Attachment).findOneBy({ id });
  }
}
