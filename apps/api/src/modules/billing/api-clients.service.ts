import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { DataSource } from 'typeorm';
import type { SessionUser } from '@sil/shared';
import { ApiClient } from '../etims/etims.entities';
import { UsersService } from '../users/users.service';

export const API_KEY_HEADER = 'x-api-key';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Machine clients (the HMIS) calling the integration API with an API key.
 * A client acts as a (service) user: that user's permissions and stores apply
 * and the audit trail names it.
 */
@Injectable()
export class ApiClientsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly users: UsersService,
  ) {}

  list() {
    return this.ds.getRepository(ApiClient).find({ order: { name: 'ASC' } });
  }

  /** Returns the key once; only its hash is stored. */
  async create(dto: { name: string; userId: string; scopes?: string[] }) {
    const user = await this.users.findForSession(dto.userId);
    if (!user) throw new BadRequestException('User not found or inactive');
    const key = `silp_${randomBytes(32).toString('base64url')}`;
    const repo = this.ds.getRepository(ApiClient);
    const row = await repo.save(repo.create({ name: dto.name, keyPrefix: key.slice(5, 13), keyHash: sha256(key), scopes: dto.scopes ?? ['billing.invoice'], userId: dto.userId, isActive: true }));
    return { id: row.id, name: row.name, keyPrefix: row.keyPrefix, scopes: row.scopes, userId: row.userId, apiKey: key };
  }

  async setActive(id: string, isActive: boolean) {
    const repo = this.ds.getRepository(ApiClient);
    const row = await repo.findOneBy({ id });
    if (!row) throw new NotFoundException('API client not found');
    row.isActive = isActive;
    return repo.save(row);
  }

  /** The acting user for a key, or null. */
  async authenticate(key: string): Promise<{ client: ApiClient; user: SessionUser } | null> {
    if (!key.startsWith('silp_') || key.length < 20) return null;
    const client = await this.ds.getRepository(ApiClient).createQueryBuilder('c').addSelect('c.keyHash').where('c.keyPrefix = :p AND c.isActive', { p: key.slice(5, 13) }).getOne();
    if (!client) return null;
    const a = Buffer.from(client.keyHash);
    const b = Buffer.from(sha256(key));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const user = await this.users.findForSession(client.userId);
    return user ? { client, user } : null;
  }
}

/**
 * Express middleware (before CSRF): on integration routes an `x-api-key`
 * header authenticates the request as the client's user. No session is
 * created; CSRF does not apply to key-authenticated calls.
 */
export function apiKeyMiddleware(clients: ApiClientsService, pathPrefix: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.get(API_KEY_HEADER);
    if (!key || !req.path.startsWith(pathPrefix)) return next();
    clients
      .authenticate(key)
      .then((auth) => {
        if (!auth) return void res.status(401).json({ statusCode: 401, message: 'Invalid API key', code: 'API_KEY' });
        (req as Request & { user: SessionUser }).user = auth.user;
        (req as Request & { apiClient?: { id: string; name: string; scopes: string[] } }).apiClient = { id: auth.client.id, name: auth.client.name, scopes: auth.client.scopes };
        next();
      })
      .catch(next);
  };
}
