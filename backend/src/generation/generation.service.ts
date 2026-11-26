import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { Prisma, type GenerationJob, type JobType, type TargetType } from '@prisma/client';
import { env } from '../config.js';
import { PrismaService } from '../prisma.service.js';
import { ApiError } from '../common/envelope.js';
import { PolicyService } from '../common/policy.service.js';
import { StorageService } from '../common/storage.service.js';
import { startOfDay } from '../common/reward.service.js';
import { reserveCredits, totalCredits } from '../common/wallet.js';
import { PlanService } from '../subscription/plan.service.js';

/** 시제품용 금칙어(소문자 비교). 운영에서는 Policy 로 옮기거나 검수 모델로 교체한다. */
const BLOCKED = ['porn', 'nude', 'sex', 'gore', '포르노', '야동', '나체', '성기', '자살', '학살'];
export const isBlocked = (text: string) => BLOCKED.some((w) => text.toLowerCase().includes(w));

export type JobWork = {
  prompt: string;
  inputImageKeys: string[];
  maskKey?: string;
  items?: { emoticonId: string; label: string; prompt: string }[];
  count: number;
  [k: string]: unknown;
};

export interface JobSpec {
  userId: string;
  idempotencyKey: string | undefined;
  type: JobType;
  targetType: TargetType;
  targetId: string;
  cost: number;
  count: number;
  work: JobWork;
  /** 같은 키로 다른 요청이 오면 IDEMPOTENCY_CONFLICT 를 내기 위한 요청 식별 값 */
  fingerprint: unknown;
  /** 작업과 같은 트랜잭션에서 실행할 준비 작업(예: 이모티콘 행 생성) */
  prepare?: (tx: Prisma.TransactionClient, jobId: string) => Promise<void>;
}

@Injectable()
export class GenerationService {
  private readonly log = new Logger('Generation');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(PlanService) private readonly plans: PlanService,
  ) {}

  costOf(type: JobType, count: number) {
    return this.policy.get(type === 'CHARACTER_CANDIDATES' ? 'candidateCreditCost' : 'emoticonCreditCost').then((c) => c * count);
  }

  /** 작업 생성: 멱등성 → 금칙어 → 한도 → (트랜잭션) 크레딧 예약 + 작업 등록 → 워커 깨우기. */
  async create(s: JobSpec) {
    if (!s.idempotencyKey || s.idempotencyKey.length < 8 || s.idempotencyKey.length > 100) {
      throw new ApiError('VALIDATION_ERROR', 'Idempotency-Key 헤더가 필요합니다.');
    }
    const hash = createHash('sha256').update(JSON.stringify([s.type, s.targetId, s.fingerprint])).digest('hex');
    const existing = await this.prisma.generationJob.findUnique({
      where: { userId_idempotencyKey: { userId: s.userId, idempotencyKey: s.idempotencyKey } },
    });
    if (existing) {
      if ((existing.params as { _hash?: string })._hash !== hash) throw new ApiError('IDEMPOTENCY_CONFLICT');
      return this.view(existing);
    }

    const texts = [s.work.prompt, ...(s.work.items ?? []).map((i) => i.prompt)];
    if (texts.some((t) => t && isBlocked(t))) throw new ApiError('CONTENT_BLOCKED');

    if ((await this.prisma.generationJob.count({ where: { status: 'QUEUED' } })) >= (await this.policy.get('maxQueueLength'))) {
      throw new ApiError('GENERATION_QUEUE_FULL');
    }

    const plan = await this.plans.effective(s.userId); // 구독 요금제에 따른 일일 한도와 우선순위
    let job: GenerationJob;
    try {
      job = await this.prisma.$transaction(async (tx) => {
        // 같은 사용자의 동시 요청을 줄 세운 뒤 오늘 사용량을 확인한다
        await tx.$queryRaw`SELECT "userId" FROM "Wallet" WHERE "userId" = ${s.userId} FOR UPDATE`;
        const today = await tx.generationJob.findMany({
          where: { userId: s.userId, createdAt: { gte: startOfDay() }, status: { notIn: ['CANCELED', 'FAILED'] } },
          select: { params: true },
        });
        const used = today.reduce((n, j) => n + ((j.params as { count?: number }).count ?? 1), 0);
        if (used + s.count > plan.dailyGenerationLimit) throw new ApiError('GENERATION_LIMIT_EXCEEDED');
        const created = await tx.generationJob.create({
          data: {
            userId: s.userId, type: s.type, targetType: s.targetType, targetId: s.targetId, creditCost: s.cost,
            priority: plan.priorityQueue ? 1 : 0, idempotencyKey: s.idempotencyKey, params: { ...s.work, _hash: hash } as unknown as Prisma.InputJsonValue,
          },
        });
        if (s.prepare) await s.prepare(tx, created.id);
        await reserveCredits(tx, s.userId, s.cost, created.id);
        return created;
      });
    } catch (e) {
      // 같은 사용자의 요청이 한꺼번에 몰려 잠금 대기가 트랜잭션 제한을 넘기면 서버 오류 대신 '요청 과다'로 안내한다
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2028') throw new ApiError('RATE_LIMITED');
      // 같은 키 동시 요청: 먼저 들어간 작업을 돌려준다
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.generationJob.findUnique({
          where: { userId_idempotencyKey: { userId: s.userId, idempotencyKey: s.idempotencyKey } },
        });
        if (again) return this.view(again);
      }
      throw e;
    }
    await this.wakeWorker();
    return this.view(job);
  }

  /** GPU 서버에 "작업이 생겼다"는 짧은 알림을 보낸다. 실패해도 요청은 성공(워커가 주기적으로 claim 하므로). */
  private async wakeWorker() {
    const url = env('WORKER_NOTIFY_URL');
    if (!url) return;
    const ts = String(Date.now());
    const sig = createHmac('sha256', env('WORKER_API_KEY')).update(ts).digest('hex');
    try {
      await fetch(url, { method: 'POST', headers: { 'X-Notify-Timestamp': ts, 'X-Notify-Signature': sig }, signal: AbortSignal.timeout(1500) });
    } catch (e) {
      this.log.warn(`워커 알림 실패(무시): ${(e as Error).message}`);
    }
  }

  async estimate(userId: string, type: JobType, count: number) {
    const cost = await this.costOf(type, count);
    const w = await this.prisma.wallet.findUnique({ where: { userId } });
    const ahead = await this.prisma.generationJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
    return {
      creditCost: cost, creditBalance: w ? totalCredits(w) : 0, sufficient: (w ? totalCredits(w) : 0) >= cost,
      estimatedWaitSeconds: (ahead + 1) * 5 + count * 4,
    };
  }

  async queuePosition(job: GenerationJob) {
    if (job.status !== 'QUEUED') return 0;
    return 1 + (await this.prisma.generationJob.count({
      where: { status: 'QUEUED', OR: [{ priority: { gt: job.priority } }, { priority: job.priority, createdAt: { lt: job.createdAt } }] },
    }));
  }

  async view(job: GenerationJob) {
    const result = job.result as { images?: { id: string; key: string; thumb?: string | null }[] } | null;
    return {
      jobId: job.id, type: job.type, status: job.status, queuePosition: await this.queuePosition(job), progress: job.progress,
      creditCost: job.creditCost, targetType: job.targetType, targetId: job.targetId,
      result: result?.images?.length
        ? { images: await Promise.all(result.images.map(async (i) => ({ id: i.id, imageUrl: await this.storage.getUrl(i.key), thumbnailUrl: await this.storage.getUrl(i.thumb ?? i.key) }))) }
        : null,
      errorCode: job.errorCode, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    };
  }
}
