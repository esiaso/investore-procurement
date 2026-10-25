import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadEnv } from '../../config/env';

/**
 * Object storage for attachments: MinIO / any S3-compatible store, or a local
 * directory (development without MinIO, unit tests). Objects are written once
 * and never overwritten (each version has its own key).
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);
  private readonly cfg = loadEnv().storage;
  private client: S3Client | null = null;
  private bucketReady: Promise<void> | null = null;

  get driver() {
    return this.cfg.driver;
  }

  private s3(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        endpoint: this.cfg.endpoint ?? undefined,
        region: this.cfg.region,
        forcePathStyle: true,
        credentials: this.cfg.accessKey && this.cfg.secretKey ? { accessKeyId: this.cfg.accessKey, secretAccessKey: this.cfg.secretKey } : undefined,
      });
    }
    return this.client;
  }

  /** Creates the bucket on first use. */
  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = (async () => {
        const c = this.s3();
        try {
          await c.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
        } catch {
          await c.send(new CreateBucketCommand({ Bucket: this.cfg.bucket }));
          this.log.log(`created bucket ${this.cfg.bucket}`);
        }
      })();
      this.bucketReady.catch(() => (this.bucketReady = null));
    }
    return this.bucketReady;
  }

  private localPath(key: string) {
    const root = resolve(this.cfg.localDir);
    const path = resolve(join(root, key));
    if (!path.startsWith(root)) throw new Error('Invalid storage key');
    return path;
  }

  async put(key: string, body: Buffer, mimeType: string): Promise<void> {
    try {
      if (this.cfg.driver === 'local') {
        const path = this.localPath(key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body, { flag: 'wx' });
        return;
      }
      await this.ensureBucket();
      await this.s3().send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: mimeType }));
    } catch (e) {
      throw new ServiceUnavailableException(`File storage is unavailable: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      if (this.cfg.driver === 'local') return await readFile(this.localPath(key));
      await this.ensureBucket();
      const out = await this.s3().send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return Buffer.from(await out.Body!.transformToByteArray());
    } catch (e) {
      throw new ServiceUnavailableException(`File storage is unavailable: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}
