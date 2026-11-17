import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { PolicyService } from './policy.service.js';
import { pointChange } from './wallet.js';

export const startOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);
export const startOfNextMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth() + 1, 1);

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
    const day = new Date();
    day.setHours(0, 0, 0, 0);
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
