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
