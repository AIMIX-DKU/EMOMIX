import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { releaseCredits } from '../common/wallet.js';
import { PrismaService } from '../prisma.service.js';
import { GenerationService } from './generation.service.js';

const JOB_TYPES = ['CHARACTER_CANDIDATES', 'EMOTION_SET', 'EMOTION_REGENERATE', 'INPAINT'] as const;
const STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED'] as const;

@Controller('generations')
export class GenerationController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GenerationService) private readonly gen: GenerationService,
  ) {}

  @Post('estimates') @HttpCode(200) @Access('user')
  estimate(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(z.object({ type: z.enum(JOB_TYPES), count: z.number().int().min(1).max(32) }), body);
    return this.gen.estimate(me.id, b.type, b.count);
  }

  @Get() @Access('user')
  async list(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.GenerationJobWhereInput = { userId: me.id };
    if (q.status) where.status = parse(z.enum(STATUSES), q.status);
    if (q.type) where.type = parse(z.enum(JOB_TYPES), q.type);
    const [rows, total] = await Promise.all([
      this.prisma.generationJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.generationJob.count({ where }),
    ]);
    return pageResult(await Promise.all(rows.map((j) => this.gen.view(j))), total, p);
  }

  @Get(':jobId') @Access('user')
  async get(@CurrentUser() me: Me, @Param('jobId') jobId: string) {
    return this.gen.view(await this.own(me.id, jobId));
  }

  /** QUEUED 상태만 취소할 수 있다. 예약 크레딧은 즉시 반환한다. */
  @Post(':jobId/cancel') @HttpCode(200) @Access('user')
  async cancel(@CurrentUser() me: Me, @Param('jobId') jobId: string) {
    const job = await this.own(me.id, jobId);
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.generationJob.updateMany({ where: { id: job.id, status: 'QUEUED' }, data: { status: 'CANCELED', finishedAt: new Date() } });
      if (r.count !== 1) throw new ApiError('JOB_NOT_CANCELABLE');
      await releaseCredits(tx, job.userId, job.creditCost, job.id);
      // 새 세트 생성 작업이면 미리 만들어 둔 이모티콘 행을 실패 처리
      if (job.type === 'EMOTION_SET') {
        await tx.emoticon.updateMany({ where: { id: { in: this.emoticonIds(job.params) }, status: 'GENERATING' }, data: { status: 'FAILED' } });
      }
    });
    return null;
  }

  private emoticonIds(params: Prisma.JsonValue) {
    return ((params as { items?: { emoticonId: string }[] }).items ?? []).map((i) => i.emoticonId);
  }

  private async own(userId: string, jobId: string) {
    const job = await this.prisma.generationJob.findUnique({ where: { id: jobId } }).catch(() => null);
    if (!job || job.userId !== userId) throw new ApiError('NOT_FOUND');
    return job;
  }
}
