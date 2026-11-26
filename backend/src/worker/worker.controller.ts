import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Prisma, type GenerationJob } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Access } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { NotifyService } from '../common/notify.service.js';
import { StorageService } from '../common/storage.service.js';
import { parse, z } from '../common/validate.js';
import { consumeCredits, releaseCredits } from '../common/wallet.js';
import { compositeInpaint, makeThumb } from '../emoticon/image-convert.js';
import type { JobWork } from '../generation/generation.service.js';
import { PrismaService } from '../prisma.service.js';
import { sniffImage } from '../upload/image.js';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
type Work = JobWork & { originalKey?: string };
type ResultImage = { id: string; key: string; thumb?: string | null };
const imageSchema = z.object({ uploadKey: z.string(), label: z.string().max(30).optional() });
/** 요청 장수보다 적게 돌아오면 돌아온 만큼만 과금한다. */
const billedFor = (job: GenerationJob, work: Work, delivered: number) => {
  const wanted = Math.max(work.count ?? work.items?.length ?? delivered, 1);
  return Math.min(job.creditCost, Math.round((job.creditCost * delivered) / wanted));
};

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
        ORDER BY priority DESC, "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1
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
  private async leased(jobId: string, workerId?: string) {
    const job = await this.prisma.generationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new ApiError('NOT_FOUND');
    if (job.status !== 'RUNNING' || !job.leaseExpiresAt || job.leaseExpiresAt < new Date()) throw new ApiError('LEASE_EXPIRED');
    if (workerId && job.workerId !== workerId) throw new ApiError('LEASE_EXPIRED'); // 임대가 만료돼 다른 워커에게 넘어간 작업
    return job;
  }

  @Post(':jobId/heartbeat') @HttpCode(200) @Access('worker')
  async heartbeat(@Param('jobId') jobId: string, @Body() body: unknown) {
    const b = parse(z.object({ progress: z.number().int().min(0).max(100), workerId: z.string().optional() }), body);
    const job = await this.leased(jobId, b.workerId);
    await this.seen();
    const lease = new Date(Date.now() + LEASE_MS);
    await this.prisma.generationJob.update({ where: { id: job.id }, data: { progress: b.progress, leaseExpiresAt: lease } });
    return { leaseExpiresAt: lease, cancelRequested: job.cancelRequested };
  }

  @Post(':jobId/upload-urls') @HttpCode(201) @Access('worker')
  async uploadUrls(@Param('jobId') jobId: string, @Body() body: unknown) {
    const b = parse(z.object({ count: z.number().int().min(1).max(32), workerId: z.string().optional() }), body);
    await this.leased(jobId, b.workerId);
    const uploads = await Promise.all(
      Array.from({ length: b.count }, async () => {
        const key = `generated/${jobId}/${randomUUID()}.png`;
        return { uploadKey: key, uploadUrl: await this.storage.putUrl(key, 'image/png', 900) };
      }),
    );
    return { uploads };
  }

  /** 업로드된 파일이 이 작업의 것이고 실제 이미지인지 확인한다. */
  private async verify(jobId: string, list: { uploadKey: string; label?: string }[]) {
    if (list.some((i) => !i.uploadKey.startsWith(`generated/${jobId}/`))) throw new ApiError('VALIDATION_ERROR', '이 작업의 업로드 키가 아닙니다.');
    return Promise.all(
      list.map(async (i) => {
        const bytes = await this.storage.readBytes(i.uploadKey).catch(() => null);
        if (!bytes) throw new ApiError('VALIDATION_ERROR', `업로드되지 않은 파일입니다: ${i.uploadKey}`);
        if (!sniffImage(bytes)) throw new ApiError('VALIDATION_ERROR', '이미지 파일이 아닙니다.');
        return { key: i.uploadKey, label: i.label, thumb: await this.thumbOf(i.uploadKey, jobId, bytes) };
      }),
    );
  }

  /** 목록용 작은 이미지를 만든다. 실패해도 원본만으로 동작하므로 null 을 돌려준다. */
  private async thumbOf(sourceKey: string, jobId: string, bytes?: Buffer | null): Promise<string | null> {
    try {
      const src = bytes ?? (await this.storage.readBytes(sourceKey));
      const key = `thumb/${jobId}/${randomUUID()}.webp`;
      await this.storage.put(key, await makeThumb(src), 'image/webp');
      return key;
    } catch {
      return null;
    }
  }

  /** 검증된 이미지를 결과 레코드(후보·이모티콘 버전)로 저장한다. prev 는 이미 전달된 결과. */
  private async record(tx: Prisma.TransactionClient, job: GenerationJob, work: Work, images: { key: string; label?: string; thumb?: string | null }[], prev: ResultImage[]) {
    const out: ResultImage[] = [];
    if (job.type === 'CHARACTER_CANDIDATES') {
      for (const i of images) {
        const c = await tx.characterCandidate.create({ data: { characterId: job.targetId, jobId: job.id, imageKey: i.key } });
        out.push({ id: c.id, key: i.key, thumb: i.thumb ?? null });
      }
    } else if (job.type === 'EMOTION_SET') {
      const items = work.items ?? [];
      const done = new Set(prev.map((p) => p.id));
      for (const [idx, i] of images.entries()) {
        const item = items.find((x) => x.label === i.label && !done.has(x.emoticonId)) ?? items[prev.length + idx];
        if (!item || done.has(item.emoticonId)) continue;
        done.add(item.emoticonId);
        const v = await tx.emoticonVersion.create({ data: { emoticonId: item.emoticonId, version: 1, imageKey: i.key, thumbKey: i.thumb ?? null, jobId: job.id, source: 'GENERATED' } });
        await tx.emoticon.update({ where: { id: item.emoticonId }, data: { currentVersionId: v.id, status: 'READY' } });
        out.push({ id: item.emoticonId, key: i.key, thumb: i.thumb ?? null });
      }
    } else {
      const last = await tx.emoticonVersion.findFirst({ where: { emoticonId: job.targetId }, orderBy: { version: 'desc' } });
      const v = await tx.emoticonVersion.create({
        data: {
          emoticonId: job.targetId, version: (last?.version ?? 0) + 1, imageKey: images[0].key, thumbKey: images[0].thumb ?? null, jobId: job.id,
          source: job.type === 'INPAINT' ? 'INPAINTED' : 'REGENERATED',
        },
      });
      out.push({ id: v.id, key: images[0].key, thumb: images[0].thumb ?? null });
    }
    return out;
  }

  /** 일부 결과를 먼저 보낸다(후보·세트 생성 전용). 작업은 계속 RUNNING 이고 임대가 연장된다. */
  @Post(':jobId/partial') @HttpCode(200) @Access('worker')
  async partial(@Param('jobId') jobId: string, @Body() body: unknown) {
    const b = parse(
      z.object({ images: z.array(imageSchema).min(1).max(32), progress: z.number().int().min(0).max(100).optional(), workerId: z.string().optional() }),
      body,
    );
    const job = await this.leased(jobId, b.workerId);
    if (job.type !== 'CHARACTER_CANDIDATES' && job.type !== 'EMOTION_SET') throw new ApiError('VALIDATION_ERROR', '일부 결과는 캐릭터 후보·세트 생성 작업에서만 보낼 수 있습니다.');
    const images = await this.verify(jobId, b.images);
    const delivered = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "GenerationJob" WHERE id = ${job.id} FOR UPDATE`;
      const cur = await tx.generationJob.findUnique({ where: { id: job.id } });
      if (!cur || cur.status !== 'RUNNING') throw new ApiError('LEASE_EXPIRED');
      const prev = (cur.result as { images?: ResultImage[] } | null)?.images ?? [];
      const all = [...prev, ...(await this.record(tx, job, job.params as unknown as Work, images, prev))];
      await tx.generationJob.update({
        where: { id: job.id },
        data: { result: { images: all } as unknown as Prisma.InputJsonValue, leaseExpiresAt: new Date(Date.now() + LEASE_MS), ...(b.progress !== undefined ? { progress: b.progress } : {}) },
      });
      return all.length;
    });
    await this.seen();
    return { jobId: job.id, delivered };
  }

  @Post(':jobId/complete') @HttpCode(200) @Access('worker')
  async complete(@Param('jobId') jobId: string, @Body() body: unknown) {
    const b = parse(z.object({ images: z.array(imageSchema).max(32).default([]), workerId: z.string().optional() }), body);
    const job = await this.leased(jobId, b.workerId);
    const work = job.params as unknown as Work;
    const images = await this.verify(jobId, b.images);

    // 인페인트: 마스크 밖은 원본 픽셀로 되돌려 합성한다
    if (job.type === 'INPAINT' && work.maskKey && work.originalKey && images[0]) {
      const merged = await compositeInpaint(
        await this.storage.readBytes(work.originalKey), await this.storage.readBytes(images[0].key), await this.storage.readBytes(work.maskKey),
      );
      const key = `generated/${jobId}/${randomUUID()}.png`;
      await this.storage.put(key, merged, 'image/png');
      images[0] = { key, label: undefined, thumb: await this.thumbOf(key, jobId, merged) };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "GenerationJob" WHERE id = ${job.id} FOR UPDATE`;
      const cur = await tx.generationJob.findUnique({ where: { id: job.id } });
      const prev = (cur?.result as { images?: ResultImage[] } | null)?.images ?? [];
      if (!images.length && !prev.length) throw new ApiError('VALIDATION_ERROR', '결과 이미지가 없습니다.');
      const claimed = await tx.generationJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'SUCCEEDED', progress: 100, finishedAt: new Date() } });
      if (claimed.count !== 1) throw new ApiError('LEASE_EXPIRED');
      const all = [...prev, ...(images.length ? await this.record(tx, job, work, images, prev) : [])];
      if (job.type === 'EMOTION_SET') {
        // 결과가 오지 않은 항목은 실패로 표시한다
        await tx.emoticon.updateMany({ where: { id: { in: (work.items ?? []).map((x) => x.emoticonId) }, status: 'GENERATING' }, data: { status: 'FAILED' } });
      }
      await tx.generationJob.update({ where: { id: job.id }, data: { result: { images: all } as unknown as Prisma.InputJsonValue } });
      // 요청한 장수보다 적게 돌아오면 돌아온 만큼만 과금하고 나머지 예약분은 돌려준다
      const used = billedFor(job, work, all.length);
      await consumeCredits(tx, job.userId, used, job.id);
      if (job.creditCost - used > 0) await releaseCredits(tx, job.userId, job.creditCost - used, job.id);
    });
    await this.notify.send(job.userId, { kind: 'generation', type: 'GENERATION_DONE', title: '이모티콘 생성이 완료되었습니다.', targetType: 'JOB', targetId: job.id });
    return { jobId: job.id, status: 'SUCCEEDED' };
  }

  @Post(':jobId/fail') @HttpCode(200) @Access('worker')
  async fail(@Param('jobId') jobId: string, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.enum(['GPU_ERROR', 'OUT_OF_MEMORY', 'CANCELED', 'CONTENT_BLOCKED']), message: z.string().max(500).optional(), workerId: z.string().optional() }), body);
    const job = await this.leased(jobId, b.workerId);
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
      const delivered = ((job.result as { images?: ResultImage[] } | null)?.images ?? []).length;
      const used = delivered ? billedFor(job, job.params as unknown as Work, delivered) : 0;
      if (used > 0) await consumeCredits(tx, job.userId, used, job.id);
      if (job.creditCost - used > 0) await releaseCredits(tx, job.userId, job.creditCost - used, job.id);
      const ids = ((job.params as unknown as Work).items ?? []).map((i) => i.emoticonId);
      if (job.type === 'EMOTION_SET') await tx.emoticon.updateMany({ where: { id: { in: ids }, status: 'GENERATING' }, data: { status: 'FAILED' } });
    });
  }
}
