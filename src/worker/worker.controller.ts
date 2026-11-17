import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Prisma, type GenerationJob } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Access } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { NotifyService } from '../common/notify.service.js';
import { StorageService } from '../common/storage.service.js';
import { parse, z } from '../common/validate.js';
import { consumeCredits, releaseCredits } from '../common/wallet.js';
import { compositeInpaint } from '../emoticon/image-convert.js';
import type { JobWork } from '../generation/generation.service.js';
import { PrismaService } from '../prisma.service.js';
import { sniffImage } from '../upload/image.js';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
type Work = JobWork & { originalKey?: string };

/** GPU 서버 전용 API(pull 방식). 인증은 쿠키가 아니라 X-Worker-Key. */
@Controller('worker/jobs')
export class WorkerController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  private seen() {
    return this.prisma.rateHit.create({ data: { key: 'worker:seen' } });
  }

  /** 임대가 끝난 RUNNING 작업을 되돌린다. 크론 대신 claim 때마다 처리. 시도 횟수를 넘으면 실패 처리. */
  private async reapExpired() {
    // 워커가 오래 없어서 대기열에 갇힌 작업은 30분 뒤 실패 처리하고 크레딧을 돌려준다
    const stale = await this.prisma.generationJob.findMany({ where: { status: 'QUEUED', createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) } }, take: 20 });
    for (const j of stale) await this.finish(j, 'FAILED', 'TIMEOUT');
    const expired = await this.prisma.generationJob.findMany({ where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } }, take: 20 });
    for (const j of expired) {
      if (j.attempts >= MAX_ATTEMPTS) await this.finish(j, 'FAILED', 'TIMEOUT');
      else await this.prisma.generationJob.updateMany({ where: { id: j.id, status: 'RUNNING' }, data: { status: 'QUEUED', workerId: null, leaseExpiresAt: null, startedAt: null } });
    }
  }

  @Post('claim') @HttpCode(200) @Access('worker')
  async claim(@Body() body: unknown) {
    const b = parse(z.object({ workerId: z.string().min(1).max(100), types: z.array(z.string()).optional() }), body);
    await this.seen();
    await this.reapExpired();
    const types = b.types?.length ? b.types : ['CHARACTER_CANDIDATES', 'EMOTION_SET', 'EMOTION_REGENERATE', 'INPAINT'];
    const lease = new Date(Date.now() + LEASE_MS);
    // 한 작업을 원자적으로 가져간다(여러 워커가 동시에 호출해도 같은 작업을 받지 않는다)
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "GenerationJob" SET status = 'RUNNING', "workerId" = ${b.workerId}, "leaseExpiresAt" = ${lease},
        "startedAt" = now(), attempts = attempts + 1, progress = 0
      WHERE id = (
        SELECT id FROM "GenerationJob" WHERE status = 'QUEUED' AND type::text = ANY(${types})
        ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1
      ) RETURNING id`;
    if (!rows.length) return { job: null };
    const job = await this.prisma.generationJob.findUniqueOrThrow({ where: { id: rows[0].id } });
    const w = job.params as unknown as Work;
    return {
      job: {
        jobId: job.id, type: job.type, prompt: w.prompt,
        inputImageUrls: await Promise.all(w.inputImageKeys.map((k) => this.storage.getUrl(k, 900))),
        maskImageUrl: await this.storage.getUrl(w.maskKey, 900),
        params: { count: w.count, items: w.items ?? [] },
        leaseExpiresAt: lease,
      },
    };
  }

  /** 이 워커가 아직 유효한 임대를 가진 RUNNING 작업이어야 한다. */
  private async leased(jobId: string) {
    const job = await this.prisma.generationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new ApiError('NOT_FOUND');
    if (job.status !== 'RUNNING' || !job.leaseExpiresAt || job.leaseExpiresAt < new Date()) throw new ApiError('LEASE_EXPIRED');
    return job;
  }

  @Post(':jobId/heartbeat') @HttpCode(200) @Access('worker')
  async heartbeat(@Param('jobId') jobId: string, @Body() body: unknown) {
    const b = parse(z.object({ progress: z.number().int().min(0).max(100) }), body);
    const job = await this.leased(jobId);
    await this.seen();
    const lease = new Date(Date.now() + LEASE_MS);
    await this.prisma.generationJob.update({ where: { id: job.id }, data: { progress: b.progress, leaseExpiresAt: lease } });
    return { leaseExpiresAt: lease, cancelRequested: job.cancelRequested };
  }

  @Post(':jobId/upload-urls') @HttpCode(201) @Access('worker')
  async uploadUrls(@Param('jobId') jobId: string, @Body() body: unknown) {
    const b = parse(z.object({ count: z.number().int().min(1).max(32) }), body);
    await this.leased(jobId);
    const uploads = await Promise.all(
      Array.from({ length: b.count }, async () => {
        const key = `generated/${jobId}/${randomUUID()}.png`;
        return { uploadKey: key, uploadUrl: await this.storage.putUrl(key, 'image/png', 900) };
      }),
    );
    return { uploads };
  }

  @Post(':jobId/complete') @HttpCode(200) @Access('worker')
  async complete(@Param('jobId') jobId: string, @Body() body: unknown) {
    const b = parse(
      z.object({ images: z.array(z.object({ uploadKey: z.string(), label: z.string().max(30).optional() })).min(1).max(32) }),
      body,
    );
    const job = await this.leased(jobId);
    const work = job.params as unknown as Work;
    if (b.images.some((i) => !i.uploadKey.startsWith(`generated/${jobId}/`))) throw new ApiError('VALIDATION_ERROR', '이 작업의 업로드 키가 아닙니다.');

    // 파일 검증(실제로 올라왔는지, 이미지인지)
    const images: { key: string; label?: string; thumb?: string }[] = [];
    for (const i of b.images) {
      const bytes = await this.storage.readBytes(i.uploadKey).catch(() => null);
      if (!bytes) throw new ApiError('VALIDATION_ERROR', `업로드되지 않은 파일입니다: ${i.uploadKey}`);
      if (!sniffImage(bytes)) throw new ApiError('VALIDATION_ERROR', '이미지 파일이 아닙니다.');
      images.push({ key: i.uploadKey, label: i.label });
    }

    // 인페인트: 마스크 밖은 원본 픽셀로 되돌려 합성한다
    if (job.type === 'INPAINT' && work.maskKey && work.originalKey) {
      const merged = await compositeInpaint(
        await this.storage.readBytes(work.originalKey), await this.storage.readBytes(images[0].key), await this.storage.readBytes(work.maskKey),
      );
      const key = `generated/${jobId}/${randomUUID()}.png`;
      await this.storage.put(key, merged, 'image/png');
      images[0] = { key };
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.generationJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'SUCCEEDED', progress: 100, finishedAt: new Date() } });
      if (claimed.count !== 1) throw new ApiError('LEASE_EXPIRED');
      const out: { id: string; key: string }[] = [];

      if (job.type === 'CHARACTER_CANDIDATES') {
        for (const i of images) {
          const c = await tx.characterCandidate.create({ data: { characterId: job.targetId, jobId: job.id, imageKey: i.key } });
          out.push({ id: c.id, key: i.key });
        }
      } else if (job.type === 'EMOTION_SET') {
        const items = work.items ?? [];
        for (const [idx, i] of images.entries()) {
          const item = items.find((x) => x.label === i.label) ?? items[idx];
          if (!item) continue;
          const v = await tx.emoticonVersion.create({ data: { emoticonId: item.emoticonId, version: 1, imageKey: i.key, jobId: job.id, source: 'GENERATED' } });
          await tx.emoticon.update({ where: { id: item.emoticonId }, data: { currentVersionId: v.id, status: 'READY' } });
          out.push({ id: item.emoticonId, key: i.key });
        }
        // 결과가 오지 않은 항목은 실패로 표시한다
        await tx.emoticon.updateMany({ where: { id: { in: items.map((x) => x.emoticonId) }, status: 'GENERATING' }, data: { status: 'FAILED' } });
      } else {
        const last = await tx.emoticonVersion.findFirst({ where: { emoticonId: job.targetId }, orderBy: { version: 'desc' } });
        const v = await tx.emoticonVersion.create({
          data: {
            emoticonId: job.targetId, version: (last?.version ?? 0) + 1, imageKey: images[0].key, jobId: job.id,
            source: job.type === 'INPAINT' ? 'INPAINTED' : 'REGENERATED',
          },
        });
        out.push({ id: v.id, key: images[0].key });
      }
      await tx.generationJob.update({ where: { id: job.id }, data: { result: { images: out } as Prisma.InputJsonValue } });
      await consumeCredits(tx, job.userId, job.creditCost, job.id);
      return out;
    });
    await this.notify.send(job.userId, { kind: 'generation', type: 'GENERATION_DONE', title: '이모티콘 생성이 완료되었습니다.', targetType: 'JOB', targetId: job.id });
    void result;
    return { jobId: job.id, status: 'SUCCEEDED' };
  }

  @Post(':jobId/fail') @HttpCode(200) @Access('worker')
  async fail(@Param('jobId') jobId: string, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.enum(['GPU_ERROR', 'OUT_OF_MEMORY', 'CANCELED', 'CONTENT_BLOCKED']), message: z.string().max(500).optional() }), body);
    const job = await this.leased(jobId);
    const status = b.reason === 'CANCELED' ? 'CANCELED' : 'FAILED';
    await this.finish(job, status, b.reason === 'CONTENT_BLOCKED' ? 'CONTENT_BLOCKED' : b.reason === 'CANCELED' ? null : 'PROVIDER_ERROR');
    if (status === 'FAILED') {
      await this.notify.send(job.userId, {
        kind: 'generation', type: 'GENERATION_FAILED', title: '이모티콘 생성에 실패했습니다.', body: '크레딧은 반환되었습니다.', targetType: 'JOB', targetId: job.id,
      });
    }
    return { jobId: job.id, status };
  }

  /** 작업 종료(실패/취소): 상태 변경 + 크레딧 반환 + 미완성 이모티콘 표시를 한 트랜잭션으로. */
  private async finish(job: GenerationJob, status: 'FAILED' | 'CANCELED', errorCode: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.generationJob.updateMany({
        where: { id: job.id, status: { in: ['RUNNING', 'QUEUED'] } }, data: { status, errorCode, finishedAt: new Date() },
      });
      if (r.count !== 1) return;
      await releaseCredits(tx, job.userId, job.creditCost, job.id);
      const ids = ((job.params as unknown as Work).items ?? []).map((i) => i.emoticonId);
      if (job.type === 'EMOTION_SET') await tx.emoticon.updateMany({ where: { id: { in: ids }, status: 'GENERATING' }, data: { status: 'FAILED' } });
    });
  }
}
