import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, type Subscription } from '@prisma/client';
import { ApiError } from '../common/envelope.js';
import { NotifyService } from '../common/notify.service.js';
import { expireSubscriptionCredits, grantSubscriptionCredits, SUB_GRACE_MS } from '../common/wallet.js';
import { OrderService } from '../payment/order.service.js';
import { TossService } from '../payment/toss.service.js';
import { PrismaService } from '../prisma.service.js';
import { PlanService, type PlanView } from './plan.service.js';

const KST = 9 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
/** 첫 결제 실패 + 재시도 3회 = 4번 실패하면 구독을 종료한다. */
const MAX_FAILURES = 4;

/** 한국 시간 기준으로 n 개월 뒤(같은 시각, 말일 보정). */
export function addMonthsKst(d: Date, n: number) {
  const k = new Date(d.getTime() + KST);
  const y = k.getUTCFullYear();
  const m = k.getUTCMonth() + n;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(k.getUTCDate(), dim), k.getUTCHours(), k.getUTCMinutes(), k.getUTCSeconds()) - KST);
}
/** 한국 시간 자정으로 올림(결제일을 하루 단위로 맞춰 매일 새벽 크론이 처리하게). */
export const ceilToKstMidnight = (d: Date) => new Date(Math.ceil((d.getTime() + KST) / DAY) * DAY - KST);

export const customerKeyOf = (userId: string) => 'cus-' + createHash('sha256').update('emomix:' + userId).digest('hex').slice(0, 24);

const ymd = (d: Date) => new Date(d.getTime() + KST).toISOString().slice(0, 10);

export type RenewResult = 'skip' | 'charged' | 'failed' | 'ended';

@Injectable()
export class SubscriptionService {
  private readonly log = new Logger('Subscription');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PlanService) private readonly plans: PlanService,
    @Inject(OrderService) private readonly orders: OrderService,
    @Inject(TossService) private readonly toss: TossService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  // ───────── 조회 ─────────
  /** 사용자가 지금 구독 중인지(ACTIVE/PAST_DUE 이고, 해지 예약의 기간이 끝나지 않음). */
  private live(s: Subscription | null): boolean {
    if (!s || s.status === 'CANCELED') return false;
    return !(s.cancelAtPeriodEnd && s.currentPeriodEnd.getTime() + SUB_GRACE_MS < Date.now());
  }

  view(s: Subscription) {
    return {
      planCode: s.planCode, status: s.status, currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd,
      nextBillingAt: s.nextBillingAt, cancelAtPeriodEnd: s.cancelAtPeriodEnd, scheduledPlanCode: s.scheduledPlanCode, failedAttempts: s.failedAttempts,
      card: { company: s.cardCompany, numberMasked: s.cardNumberMasked },
    };
  }

  async me(userId: string) {
    const s = await this.prisma.subscription.findUnique({ where: { userId } });
    return { customerKey: customerKeyOf(userId), plan: await this.plans.effective(userId), subscription: s && this.live(s) ? this.view(s) : null };
  }

  async invoices(userId: string, page: { skip: number; take: number }) {
    const where = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.subscriptionInvoice.findMany({ where, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.take }),
      this.prisma.subscriptionInvoice.count({ where }),
    ]);
    return { rows, total };
  }

  // ───────── 시작 ─────────
  async start(userId: string, b: { planCode: string; authKey: string; customerKey: string }) {
    const plan = await this.plans.get(b.planCode);
    if (!plan || plan.code === 'FREE') throw new ApiError('VALIDATION_ERROR', '구독할 수 없는 요금제입니다.');
    if (b.customerKey !== customerKeyOf(userId)) throw new ApiError('VALIDATION_ERROR', 'customerKey 가 올바르지 않습니다.');
    const existing = await this.prisma.subscription.findUnique({ where: { userId } });
    if (this.live(existing)) throw new ApiError('ALREADY_SUBSCRIBED');

    const card = await this.toss.issueBillingKey(b.authKey, b.customerKey);
    const order = await this.orders.create(userId, { type: 'SUBSCRIPTION', orderName: `EmoMix ${plan.name} 구독 시작`, amount: plan.price });
    let pay;
    try {
      pay = await this.toss.chargeBilling({ billingKey: card.billingKey, customerKey: b.customerKey, amount: plan.price, orderId: order.orderNo, orderName: order.orderName });
    } catch (e) {
      await this.prisma.order.updateMany({ where: { id: order.id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELED', refundReason: '결제 실패' } });
      throw e;
    }

    const now = new Date();
    const periodEnd = ceilToKstMidnight(addMonthsKst(now, 1));
    try {
      const sub = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'sub:' + userId}))`; // 같은 사용자의 동시 시작을 줄 세운다
        const cur = await tx.subscription.findUnique({ where: { userId } });
        if (this.live(cur)) throw new ApiError('ALREADY_SUBSCRIBED');
        await tx.order.update({ where: { id: order.id }, data: { status: 'PAID', paidAt: now } });
        await tx.payment.create({
          data: { orderId: order.id, paymentKey: pay.paymentKey, amount: plan.price, status: 'DONE', raw: pay as unknown as Prisma.InputJsonValue, approvedAt: now },
        });
        const data = {
          planCode: plan.code, scheduledPlanCode: null, status: 'ACTIVE' as const, billingKey: card.billingKey, cardCompany: card.cardCompany,
          cardNumberMasked: card.cardNumberMasked, currentPeriodStart: now, currentPeriodEnd: periodEnd, nextBillingAt: periodEnd,
          cancelAtPeriodEnd: false, failedAttempts: 0,
        };
        const s = cur
          ? await tx.subscription.update({ where: { id: cur.id }, data })
          : await tx.subscription.create({ data: { userId, ...data } });
        await tx.subscriptionInvoice.create({
          data: { subscriptionId: s.id, userId, orderNo: order.orderNo, planCode: plan.code, periodStart: now, periodEnd, amount: plan.price, status: 'PAID', creditsGranted: plan.monthlyCredits },
        });
        await grantSubscriptionCredits(tx, userId, plan.monthlyCredits, periodEnd, s.id);
        return s;
      });
      return { ...this.view(sub), grantedCredits: plan.monthlyCredits };
    } catch (e) {
      // 결제는 됐는데 구독을 만들지 못한 경우(동시 시작 등)는 결제를 취소한다
      await this.toss.cancel(pay.paymentKey, '구독 시작 실패 자동 취소').catch(() => undefined);
      await this.prisma.order.updateMany({ where: { id: order.id, status: { not: 'PAID' } }, data: { status: 'CANCELED', refundReason: '구독 시작 실패' } });
      throw e;
    }
  }

  // ───────── 변경·해지 ─────────
  private async mine(userId: string) {
    const s = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!s || s.status === 'CANCELED') throw new ApiError('NOT_SUBSCRIBED');
    return s;
  }

  async schedulePlan(userId: string, planCode: string) {
    const s = await this.mine(userId);
    if (!this.live(s)) throw new ApiError('NOT_SUBSCRIBED');
    if (s.cancelAtPeriodEnd) throw new ApiError('VALIDATION_ERROR', '해지 예약 중입니다. 먼저 해지를 취소해주세요.');
    if (!(await this.plans.get(planCode))) throw new ApiError('VALIDATION_ERROR', '없는 요금제입니다.');
    if (planCode === s.planCode) {
      if (!s.scheduledPlanCode) throw new ApiError('VALIDATION_ERROR', '현재 요금제와 같습니다.');
      return this.view(await this.prisma.subscription.update({ where: { id: s.id }, data: { scheduledPlanCode: null } })); // 변경 예약 취소
    }
    return this.view(await this.prisma.subscription.update({ where: { id: s.id }, data: { scheduledPlanCode: planCode } }));
  }

  async cancel(userId: string) {
    const s = await this.mine(userId);
    if (!this.live(s)) throw new ApiError('NOT_SUBSCRIBED');
    if (s.status === 'PAST_DUE') {
      // 결제가 밀린 구독은 기간이 이미 끝났으므로 해지하면 바로 종료한다
      return this.view(await this.prisma.$transaction(async (tx) => {
        await expireSubscriptionCredits(tx, userId, s.id);
        return tx.subscription.update({ where: { id: s.id }, data: { status: 'CANCELED', nextBillingAt: null, cancelAtPeriodEnd: false, scheduledPlanCode: null } });
      }));
    }
    return this.view(await this.prisma.subscription.update({ where: { id: s.id }, data: { cancelAtPeriodEnd: true, nextBillingAt: null, scheduledPlanCode: null } }));
  }

  async resume(userId: string) {
    const s = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!s) throw new ApiError('NOT_SUBSCRIBED');
    if (s.status === 'CANCELED' || !this.live(s)) throw new ApiError('VALIDATION_ERROR', '이미 종료된 구독입니다. 구독을 다시 시작해주세요.');
    if (!s.cancelAtPeriodEnd) return this.view(s);
    return this.view(await this.prisma.subscription.update({ where: { id: s.id }, data: { cancelAtPeriodEnd: false, nextBillingAt: s.currentPeriodEnd } }));
  }

  async changeCard(userId: string, b: { authKey: string; customerKey: string }) {
    const s = await this.mine(userId);
    if (b.customerKey !== customerKeyOf(userId)) throw new ApiError('VALIDATION_ERROR', 'customerKey 가 올바르지 않습니다.');
    const card = await this.toss.issueBillingKey(b.authKey, b.customerKey);
    let cur = await this.prisma.subscription.update({
      where: { id: s.id }, data: { billingKey: card.billingKey, cardCompany: card.cardCompany, cardNumberMasked: card.cardNumberMasked },
    });
    if (cur.status === 'PAST_DUE') {
      // 미납이면 새 카드로 바로 다시 청구한다
      await this.prisma.subscription.update({ where: { id: cur.id }, data: { nextBillingAt: new Date() } });
      const r = await this.renewOne(cur.id);
      cur = await this.prisma.subscription.findUniqueOrThrow({ where: { id: cur.id } });
      if (r === 'failed' || r === 'ended') throw new ApiError('PAYMENT_FAILED');
    }
    return this.view(cur);
  }

  // ───────── 자동 갱신 ─────────
  /** 결제일이 지난 구독을 청구하고, 해지 예약이 끝난 구독을 종료한다. 크론이 하루 한 번 호출하며 여러 번 불러도 결과가 같다. */
  async runBilling() {
    const now = new Date();
    const due = await this.prisma.subscription.findMany({
      where: {
        OR: [
          { status: { in: ['ACTIVE', 'PAST_DUE'] }, nextBillingAt: { lte: now } },
          { status: 'ACTIVE', cancelAtPeriodEnd: true, currentPeriodEnd: { lte: now } },
        ],
      },
      orderBy: { nextBillingAt: 'asc' },
      take: 50,
    });
    const out = { processed: due.length, charged: 0, failed: 0, ended: 0 };
    for (const s of due) {
      try {
        const r = await this.renewOne(s.id);
        if (r === 'charged') out.charged++;
        else if (r === 'failed') out.failed++;
        else if (r === 'ended') out.ended++;
      } catch (e) {
        this.log.error(`갱신 처리 실패 ${s.id}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** 구독 하나를 갱신한다. 행을 잠근 채로 청구하므로 같은 구독을 동시에 두 번 청구하지 못한다. */
  async renewOne(subId: string): Promise<RenewResult> {
    const notices: (() => Promise<unknown>)[] = [];
    const result = await this.prisma.$transaction(async (tx): Promise<RenewResult> => {
      await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${subId} FOR UPDATE`;
      const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subId } });
      const now = new Date();
      if (sub.status === 'CANCELED') return 'skip';

      const end = async (title: string, body?: string): Promise<RenewResult> => {
        await expireSubscriptionCredits(tx, sub.userId, sub.id);
        await tx.subscription.update({ where: { id: sub.id }, data: { status: 'CANCELED', nextBillingAt: null, cancelAtPeriodEnd: false, scheduledPlanCode: null } });
        notices.push(() => this.notify.send(sub.userId, { kind: 'system', type: 'SYSTEM', title, body }));
        return 'ended';
      };

      if (sub.cancelAtPeriodEnd) {
        if (sub.currentPeriodEnd.getTime() <= now.getTime()) return end('구독이 종료되었습니다.', '무료 요금제로 돌아갑니다.');
        return 'skip';
      }
      if (!sub.nextBillingAt || sub.nextBillingAt.getTime() > now.getTime()) return 'skip';

      const plan: PlanView = (await this.plans.get(sub.scheduledPlanCode ?? sub.planCode)) ?? (await this.plans.get(sub.planCode))!;
      const attempt = sub.failedAttempts + 1;
      const orderNo = `EMXS${sub.id.slice(0, 8).toUpperCase()}${ymd(sub.currentPeriodEnd).replace(/-/g, '')}A${attempt}`;
      const order = await this.orders.create(sub.userId, { type: 'SUBSCRIPTION', orderName: `EmoMix ${plan.name} 구독 갱신 (${ymd(sub.currentPeriodEnd)})`, amount: plan.price, orderNo }, tx);

      let pay;
      try {
        pay = await this.toss.chargeBilling({ billingKey: sub.billingKey, customerKey: customerKeyOf(sub.userId), amount: plan.price, orderId: orderNo, orderName: order.orderName });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELED', refundReason: '결제 실패' } });
        await tx.subscriptionInvoice.create({
          data: {
            subscriptionId: sub.id, userId: sub.userId, planCode: plan.code, periodStart: sub.currentPeriodEnd, periodEnd: addMonthsKst(sub.currentPeriodEnd, 1),
            amount: plan.price, status: 'FAILED', failReason: e.message.slice(0, 200),
          },
        });
        if (attempt >= MAX_FAILURES) {
          await tx.subscription.update({ where: { id: sub.id }, data: { failedAttempts: attempt } });
          return end('결제 실패로 구독이 종료되었습니다.', '다시 이용하려면 구독을 새로 시작해주세요.');
        }
        await tx.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', failedAttempts: attempt, nextBillingAt: new Date(now.getTime() + DAY) } });
        notices.push(() => this.notify.send(sub.userId, { kind: 'system', type: 'SYSTEM', title: '구독 결제에 실패했습니다.', body: '카드를 확인해주세요. 내일 다시 시도합니다.' }));
        return 'failed';
      }

      // 성공: 새 기간은 이전 기간 끝에서 시작한다(오랫동안 밀렸으면 지금부터)
      let periodStart = sub.currentPeriodEnd;
      let periodEnd = addMonthsKst(periodStart, 1);
      if (periodEnd.getTime() <= now.getTime()) {
        periodStart = now;
        periodEnd = ceilToKstMidnight(addMonthsKst(now, 1));
      }
      await tx.order.update({ where: { id: order.id }, data: { status: 'PAID', paidAt: now } });
      await tx.payment.create({
        data: { orderId: order.id, paymentKey: pay.paymentKey, amount: plan.price, status: 'DONE', raw: pay as unknown as Prisma.InputJsonValue, approvedAt: now },
      });
      await tx.subscriptionInvoice.create({
        data: { subscriptionId: sub.id, userId: sub.userId, orderNo, planCode: plan.code, periodStart, periodEnd, amount: plan.price, status: 'PAID', creditsGranted: plan.monthlyCredits },
      });
      await grantSubscriptionCredits(tx, sub.userId, plan.monthlyCredits, periodEnd, sub.id);
      await tx.subscription.update({
        where: { id: sub.id },
        data: { planCode: plan.code, scheduledPlanCode: null, status: 'ACTIVE', currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextBillingAt: periodEnd, failedAttempts: 0 },
      });
      notices.push(() => this.notify.send(sub.userId, { kind: 'system', type: 'SYSTEM', title: '구독이 갱신되었습니다.', body: `${plan.name} 월 크레딧 ${plan.monthlyCredits}개가 지급되었습니다.` }));
      return 'charged';
    });
    for (const n of notices) await n().catch(() => undefined); // 알림 실패가 결제 결과를 바꾸지 않는다
    return result;
  }
}
