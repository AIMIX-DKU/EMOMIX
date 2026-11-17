import { Injectable } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config.js';

/** Neon Object storage(S3 호환). 버킷은 Private 이므로 모든 접근은 서명 URL 로 한다. */
@Injectable()
export class StorageService {
  private readonly bucket = env('S3_BUCKET');
  private readonly s3 = new S3Client({
    region: env('S3_REGION', 'us-east-2'),
    endpoint: env('S3_ENDPOINT'),
    forcePathStyle: true,
    credentials: { accessKeyId: env('S3_ACCESS_KEY_ID'), secretAccessKey: env('S3_SECRET_ACCESS_KEY') },
  });

  putUrl(key: string, contentType: string, expiresIn = 600) {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn });
  }

  getUrl(key: string | null | undefined, expiresIn = 3600): Promise<string | null> {
    if (!key) return Promise.resolve(null);
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  /** 파일 존재/용량 확인. 없으면 null. */
  async head(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? '' };
    } catch {
      return null;
    }
  }

  async readBytes(key: string, maxBytes = 12 * 1024 * 1024): Promise<Buffer> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await r.Body!.transformToByteArray();
    if (bytes.length > maxBytes) throw new Error('too large');
    return Buffer.from(bytes);
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async remove(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => undefined);
  }
}
