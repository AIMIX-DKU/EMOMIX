import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { PolicyService } from '../common/policy.service.js';
import { startOfMonth, startOfNextMonth } from '../common/reward.service.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { creditChange, pointChange } from '../common/wallet.js';
import { PrismaService } from '../prisma.service.js';

/** 내부 enum → API 표기. TRIAL(가입 체험)은 GRANT, 운영자 지급 GRANT 는 ADMIN_GRANT 로 보여준다. */
const CREDIT_OUT: Record<string, string> = { TRIAL: 'GRANT', GRANT: 'ADMIN_GRANT' };
const CREDIT_IN: Record<string, string> = { GRANT: 'TRIAL', ADMIN_GRANT: 'GRANT' };
const REF_OUT: Record<string, string> = { JOB: 'GENERATION' };
const UNIT = 100;

@Controller()
export class WalletController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
  ) {}

  private async monthly(userId: string) {
    const from = startOfMonth();
    const [earned, exchanged] = await Promise.all([
      this.prisma.pointTransaction.aggregate({ _sum: { amount: true }, where: { userId, type: 'EARN', createdAt: { gte: from } } }),
      this.prisma.pointTransaction.aggregate({ _sum: { amount: true }, where: { userId, type: 'EXCHANGE', createdAt: { gte: from } } }),
    ]);
    return { earned: earned._sum.amount ?? 0, exchanged: Math.abs(exchanged._sum.amount ?? 0) };
  }

  @Get('wallet') @Access('user')
  async wallet(@CurrentUser() me: Me) {
    const w = await this.prisma.wallet.findUnique({ where: { userId: me.id } });
    const m = await this.monthly(me.id);
    return {
      credit: { balance: w?.creditBalance ?? 0, reserved: w?.creditReserved ?? 0 },
      activityPoint: {
        balance: w?.pointBalance ?? 0, monthlyEarned: m.earned, monthlyEarnCap: await this.policy.get('monthlyPointEarnCap'),
        monthlyExchanged: m.exchanged, monthlyExchangeCap: await this.policy.get('monthlyPointExchangeCap'), resetAt: startOfNextMonth(),
      },
    };
  }

  @Get('wallet/credit-transactions') @Access('user')
  async creditTx(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.CreditTransactionWhereInput = { userId: me.id };
    if (q.type) {
      const t = parse(z.enum(['PURCHASE', 'GRANT', 'EXCHANGE', 'RESERVE', 'CONSUME', 'RELEASE', 'REFUND', 'ADMIN_GRANT']), q.type);
      // GRANT(가입 체험 등)와 ADMIN_GRANT 를 구분해 조회한다
      where.type = (CREDIT_IN[t] ?? t) as never;
    }
    const range: Prisma.DateTimeFilter = {};
    if (q.from) range.gte = new Date(parse(z.string().datetime(), q.from));
    if (q.to) range.lte = new Date(parse(z.string().datetime(), q.to));
    if (range.gte || range.lte) where.createdAt = range;
    const [rows, total] = await Promise.all([
      this.prisma.creditTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.creditTransaction.count({ where }),
    ]);
    return pageResult(
      rows.map((r) => ({
        id: r.id, type: CREDIT_OUT[r.type] ?? r.type, amount: r.amount, balanceAfter: r.balanceAfter,
        refType: r.refType ? (REF_OUT[r.refType] ?? r.refType) : null, refId: r.refId, createdAt: r.createdAt,
      })),
      total, p,
    );
  }

  @Get('wallet/point-transactions') @Access('user')
  async pointTx(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.PointTransactionWhereInput = { userId: me.id, ...(q.type ? { type: parse(z.enum(['EARN', 'EXCHANGE', 'REVOKE', 'EXPIRE']), q.type) } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.pointTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.pointTransaction.count({ where }),
    ]);
    return pageResult(
      rows.map((r) => ({ id: r.id, type: r.type, amount: r.amount, reason: r.rule ?? r.type, balanceAfter: r.balanceAfter, createdAt: r.createdAt })),
      total, p,
    );
  }

  @Post('wallet/point-exchanges') @HttpCode(201) @Access('user')
  async exchange(@CurrentUser() me: Me, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const b = parse(z.object({ points: z.number().int().positive() }), body);
    return this.idem.run(me.id, key, b, async () => {
      if (b.points < UNIT) throw new ApiError('BELOW_MINIMUM');
      if (b.points % UNIT !== 0) throw new ApiError('VALIDATION_ERROR', `${UNIT}포인트 단위로만 교환할 수 있습니다.`);
      const rate = await this.policy.get('pointToCreditRate');
      const credits = Math.floor(b.points * rate);
      return this.prisma.$transaction(async (tx) => {
        const month = await tx.pointTransaction.aggregate({
          _sum: { amount: true }, where: { userId: me.id, type: 'EXCHANGE', createdAt: { gte: startOfMonth() } },
        });
        if (Math.abs(month._sum.amount ?? 0) + b.points > (await this.policy.get('monthlyPointExchangeCap'))) throw new ApiError('MONTHLY_CAP_EXCEEDED');
        const pw = await pointChange(tx, me.id, 'EXCHANGE', -b.points, { rule: 'EXCHANGE' });
        const cw = await creditChange(tx, me.id, 'EXCHANGE', credits);
        return { exchangedPoints: b.points, grantedCredits: credits, rate, creditBalance: cw.creditBalance, pointBalance: pw.pointBalance };
      });
    });
  }

  @Get('credit-packages') @Access('none')
  async packages() {
    const rows = await this.prisma.creditPackage.findMany({ where: { active: true }, orderBy: { price: 'asc' } });
    return { items: rows.map((r) => ({ id: r.id, name: r.name, credits: r.credits, bonusCredits: r.bonusCredits, price: r.price })) };
  }

  @Get('rewards/rules') @Access('none')
  async rules() {
    const rows = await this.prisma.rewardRule.findMany({ where: { active: true }, orderBy: { points: 'asc' } });
    return {
      rules: rows.map((r) => ({ action: r.key, label: r.description, points: r.points, dailyLimit: r.dailyLimit })),
      exchange: { rate: await this.policy.get('pointToCreditRate'), unit: UNIT, monthlyCap: await this.policy.get('monthlyPointExchangeCap') },
    };
  }
}
