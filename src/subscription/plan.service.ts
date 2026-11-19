import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { PolicyService } from '../common/policy.service.js';
import { SUB_GRACE_MS } from '../common/wallet.js';

export type PlanCode = 'FREE' | 'STANDARD' | 'PRO';

export interface PlanView {
  code: PlanCode;
  name: string;
  price: number;
  monthlyCredits: number;
  dailyGenerationLimit: number;
  priorityQueue: boolean;
  sellerFeeRate: number;
}

/** 요금제 값 조회. FREE 는 DB 행 없이 운영 정책 값(일일 한도, 수수료율)을 쓰고, 유료 요금제는 SubscriptionPlan 테이블을 쓴다. */
@Injectable()
export class PlanService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  async free(): Promise<PlanView> {
    return {
      code: 'FREE', name: '무료', price: 0, monthlyCredits: 0, priorityQueue: false,
      dailyGenerationLimit: await this.policy.get('dailyGenerationLimit'), sellerFeeRate: await this.policy.get('sellerFeeRate'),
    };
  }

  async list(): Promise<PlanView[]> {
    const rows = await this.prisma.subscriptionPlan.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
    return [await this.free(), ...rows.map((r) => ({ ...r, code: r.code as PlanCode }))].map((p) => ({
      code: p.code, name: p.name, price: p.price, monthlyCredits: p.monthlyCredits, dailyGenerationLimit: p.dailyGenerationLimit,
      priorityQueue: p.priorityQueue, sellerFeeRate: p.sellerFeeRate,
    }));
  }

  async get(code: string): Promise<PlanView | null> {
    return (await this.list()).find((p) => p.code === code) ?? null;
  }

  /** 지금 적용되는 요금제. 구독이 ACTIVE/PAST_DUE 이면 그 요금제(PAST_DUE 는 유예), 종료됐거나 해지 예약의 기간이 끝났으면 FREE. */
  async effective(userId: string): Promise<PlanView> {
    const sub = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!sub || sub.status === 'CANCELED') return this.free();
    if (sub.cancelAtPeriodEnd && sub.currentPeriodEnd.getTime() + SUB_GRACE_MS < Date.now()) return this.free();
    return (await this.get(sub.planCode)) ?? this.free();
  }
}
