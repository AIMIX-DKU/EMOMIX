import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { PolicyService } from './policy.service.js';
import { pointChange } from './wallet.js';

// 서비스 기준 시간대는 한국(KST, UTC+9). 서버(Vercel)는 UTC 라서 '오늘'·'이번 달' 경계를 직접 계산한다.
const KST = 9 * 3600 * 1000;
export const startOfDay = (d = new Date()) => new Date(Math.floor((d.getTime() + KST) / 86_400_000) * 86_400_000 - KST);
export const startOfMonth = (d = new Date()) => {
  const k = new Date(d.getTime() + KST);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1) - KST);
};
export const startOfNextMonth = (d = new Date()) => {
  const k = new Date(d.getTime() + KST);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() + 1, 1) - KST);
};

/** 활동 포인트 보상. 규칙의 일일 한도, 월간 획득 한도, 같은 대상 중복 지급 금지를 지킨다. */
@Injectable()
export class RewardService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  /** 지급되면 true. 규칙이 없거나 한도에 걸리거나 이미 지급한 대상이면 조용히 false. */
  async grant(userId: string, ruleKey: string, ref: { type: string; id: string }): Promise<boolean> {
    const rule = await this.prisma.rewardRule.findUnique({ where: { key: ruleKey } });
    if (!rule || !rule.active || rule.points <= 0) return false;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (user?.status !== 'ACTIVE') return false;

    if (await this.prisma.pointTransaction.findFirst({ where: { userId, rule: ruleKey, refType: ref.type, refId: ref.id } })) return false;
    const day = startOfDay();
    if (rule.dailyLimit !== null) {
      const today = await this.prisma.pointTransaction.count({ where: { userId, rule: ruleKey, type: 'EARN', createdAt: { gte: day } } });
      if (today >= rule.dailyLimit) return false;
    }
    const earned = await this.prisma.pointTransaction.aggregate({
      _sum: { amount: true }, where: { userId, type: 'EARN', createdAt: { gte: startOfMonth() } },
    });
    if ((earned._sum.amount ?? 0) + rule.points > (await this.policy.get('monthlyPointEarnCap'))) return false;

    await this.prisma.$transaction((tx) => pointChange(tx, userId, 'EARN', rule.points, { rule: ruleKey, refType: ref.type, refId: ref.id }));
    return true;
  }
}
