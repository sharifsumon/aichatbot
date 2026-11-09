import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** Where uploaded files (knowledge base files, product images) live. */
export interface ObjectStore {
  get(key: string): Promise<Uint8Array>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface S3StoreOptions {
  /** e.g. https://<account>.r2.cloudflarestorage.com for R2, or http://minio:9000. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Any S3-compatible store: Cloudflare R2, MinIO on the VPS, or AWS S3 later. */
export class S3Store implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StoreOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // R2 and MinIO need path-style URLs.
      forcePathStyle: true,
    });
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty object ${key}`);
    return res.Body.transformToByteArray();
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Keys are namespaced by workspace so one shop's files can never be named by another's. */
export function workspaceKey(workspaceId: string, ...parts: string[]): string {
  return [workspaceId, ...parts.map((p) => p.replace(/[^A-Za-z0-9._-]/g, '_'))].join('/');
}

/** Keys are made by workspaceKey: segments of letters, digits, dot, dash and underscore. */
const SAFE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/**
 * Files on the server's own disk (a Docker volume shared by the api and worker),
 * for a single VPS without an S3 bucket.
 */
export class DiskStore implements ObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The file's path on disk, or undefined for a key that could leave the root. */
  pathOf(key: string): string | undefined {
    if (!SAFE_KEY.test(key) || key.split('/').some((p) => p === '.' || p === '..')) return undefined;
    const path = resolve(this.root, key);
    return path.startsWith(this.root + sep) ? path : undefined;
  }

  private must(key: string): string {
    const path = this.pathOf(key);
    if (!path) throw new Error(`Bad file key ${key}`);
    return path;
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.must(key)));
  }

  /** The type is not kept: the file route serves images by their extension. */
  async put(key: string, body: Uint8Array, _contentType?: string): Promise<void> {
    const path = this.must(key);
    await mkdir(dirname(path), { recursive: true });
    // Write then rename, so a reader never sees half a file.
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.must(key), { force: true });
  }
}

export interface StorageEnv {
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  FILES_DIR?: string;
}

/**
 * The configured store: an S3-compatible bucket when S3_ENDPOINT is set,
 * otherwise the server's disk when FILES_DIR is set, otherwise none.
 */
export function storageFromEnv(env: StorageEnv): S3Store | DiskStore | undefined {
  if (env.S3_ENDPOINT) {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error('S3_ENDPOINT is set, so S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are needed too');
    }
    return new S3Store({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION || 'auto',
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
  }
  if (env.FILES_DIR) return new DiskStore(env.FILES_DIR);
  return undefined;
}
