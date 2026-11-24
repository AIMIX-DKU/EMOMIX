import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { PolicyService } from '../common/policy.service.js';
import { StorageService } from '../common/storage.service.js';
import { parse, z } from '../common/validate.js';
import { PrismaService } from '../prisma.service.js';
import { sniffImage } from './image.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const DAY = 24 * 3600 * 1000;

@Controller('uploads/images')
export class UploadController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  @Post('presign') @HttpCode(201) @Access('user')
  async presign(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(
      z.object({
        contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        sizeBytes: z.number().int().positive(),
        purpose: z.enum(['REFERENCE', 'MASK', 'PROFILE', 'SAMPLE']),
      }),
      body,
    );
    if (b.sizeBytes > (await this.policy.get('maxFileBytes'))) throw new ApiError('FILE_TOO_LARGE');
    // 연결되지 않은 만료 업로드는 이 시점에 함께 정리한다(크론 없이 처리)
    const stale = await this.prisma.upload.findMany({ where: { ownerId: me.id, linked: false, expiresAt: { lt: new Date() } }, take: 20 });
    for (const s of stale) await this.storage.remove(s.storageKey);
    if (stale.length) await this.prisma.upload.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });

    const id = randomUUID();
    const key = `uploads/${me.id}/${id}.${EXT[b.contentType]}`;
    await this.prisma.upload.create({
      data: {
        id, ownerId: me.id, purpose: b.purpose, storageKey: key, contentType: b.contentType, sizeBytes: b.sizeBytes,
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    return {
      uploadId: id,
      uploadUrl: await this.storage.putUrl(key, b.contentType, 600),
      uploadHeaders: { 'Content-Type': b.contentType },
      expiresAt: new Date(Date.now() + 600 * 1000),
    };
  }

  @Post(':uploadId/complete') @HttpCode(200) @Access('user')
  async complete(@CurrentUser() me: Me, @Param('uploadId') uploadId: string) {
    const up = await this.prisma.upload.findUnique({ where: { id: uploadId } });
    if (!up || up.ownerId !== me.id) throw new ApiError('NOT_FOUND');
    if (up.status === 'CONFIRMED') return this.view(up);

    const head = await this.storage.head(up.storageKey);
    if (!head) throw new ApiError('VALIDATION_ERROR', '파일이 아직 업로드되지 않았습니다.');
    const fail = async (code: 'FILE_TOO_LARGE' | 'UNSUPPORTED_FILE_TYPE') => {
      await this.storage.remove(up.storageKey);
      await this.prisma.upload.delete({ where: { id: up.id } });
      throw new ApiError(code);
    };
    if (head.size > (await this.policy.get('maxFileBytes'))) return fail('FILE_TOO_LARGE');
    if (head.size !== up.sizeBytes) throw new ApiError('VALIDATION_ERROR', '신고한 용량과 실제 파일 용량이 다릅니다.');

    const info = sniffImage(await this.storage.readBytes(up.storageKey));
    if (!info || info.type !== up.contentType) return fail('UNSUPPORTED_FILE_TYPE');
    if (info.width < 1 || info.height < 1 || info.width > 8192 || info.height > 8192) return fail('UNSUPPORTED_FILE_TYPE');

    // 검사를 통과한 내용을 새 키로 복사해 확정한다: 클라이언트가 가진 업로드 URL(만료 전)로 나중에 파일을 바꿔치기할 수 없다
    const safeKey = up.storageKey.replace(/(\.\w+)$/, '-ok$1');
    await this.storage.copy(up.storageKey, safeKey);
    await this.storage.remove(up.storageKey);
    const done = await this.prisma.upload.update({
      where: { id: up.id },
      data: { status: 'CONFIRMED', width: info.width, height: info.height, storageKey: safeKey },
    });
    return this.view(done);
  }

  private async view(u: { id: string; storageKey: string; width: number | null; height: number | null; sizeBytes: number; createdAt: Date }) {
    return {
      uploadId: u.id,
      url: await this.storage.getUrl(u.storageKey),
      width: u.width,
      height: u.height,
      sizeBytes: u.sizeBytes,
      expiresAt: new Date(u.createdAt.getTime() + DAY),
    };
  }
}
