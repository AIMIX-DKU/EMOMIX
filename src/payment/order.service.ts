import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type Order } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { ApiError } from '../common/envelope.js';
import { NotifyService } from '../common/notify.service.js';
import { PolicyService } from '../common/policy.service.js';
import { RewardService } from '../common/reward.service.js';
import { creditChange } from '../common/wallet.js';
import { PrismaService } from '../prisma.service.js';
import { ledgerAdd, revokePoints } from './ledger.js';
import { TossService, type TossPayment } from './toss.service.js';

export const ORDER_TTL_MS = 30 * 60 * 1000;
export const REFUND_WINDOW_MS = 7 * 24 * 3600 * 1000;

export const orderView = (o: Order) => ({
  orderNo: o.orderNo, type: o.type, orderName: o.orderName, amount: o.amount, status: o.status, expiresAt: o.expiresAt,
});

const newOrderNo = () => `EMX${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${randomBytes(4).toString('hex').toUpperCase()}`;

@Injectable()
export class OrderService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Inject(RewardService) private readonly reward: RewardService,
    @Inject(TossService) private readonly toss: TossService,
  ) {}

  /** 결제 기한이 지난 대기 주문을 EXPIRED 로 바꾼다(크론 없이 조회 시점에 처리). */
  async expireIfNeeded(o: Order): Promise<Order> {
    if (o.status === 'PENDING_PAYMENT' && o.expiresAt < new Date()) {
      await this.prisma.order.updateMany({ where: { id: o.id, status: 'PENDING_PAYMENT' }, data: { status: 'EXPIRED' } });
      return { ...o, status: 'EXPIRED' };
    }
    return o;
  }

  create(userId: string, data: { type: 'PRODUCT' | 'CREDIT_PACKAGE' | 'DONATION'; orderName: string; amount: number; productId?: string; creditPackageId?: string }, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).order.create({
      data: { orderNo: newOrderNo(), userId, expiresAt: new Date(Date.now() + ORDER_TTL_MS), ...data },
    });
  }

  // ───────── 결제 완료 처리 ─────────
  /** 결제 승인 후 주문 종류별 처리(접근 권한/크레딧/후원 기록, 판매자 장부, 보상). 이미 처리된 주문이면 ORDER_NOT_PENDING. */
  async fulfill(order: Order, pay: TossPayment) {
    if (order.type === 'PRODUCT') {
      const dup = await this.prisma.purchase.findFirst({ where: { userId: order.userId, productId: order.productId!, refundedAt: null } });
      if (dup) {
        // 대기 주문을 두 개 만들어 둘 다 결제한 경우: 이미 가진 상품이므로 이번 결제는 PG 에서 취소하고 주문을 닫는다
        await this.toss.cancel(pay.paymentKey, '중복 구매 자동 취소').catch(() => undefined);
        await this.prisma.order.updateMany({ where: { id: order.id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELED', refundReason: '중복 구매' } });
        throw new ApiError('ALREADY_PURCHASED');
      }
    }
    const fee = await this.policy.get('sellerFeeRate');
    const out = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({ where: { id: order.id, status: 'PENDING_PAYMENT' }, data: { status: 'PAID', paidAt: new Date() } });
      if (claimed.count !== 1) throw new ApiError('ORDER_NOT_PENDING');
      const payment = await tx.payment.create({
        data: {
          orderId: order.id, paymentKey: pay.paymentKey, amount: order.amount, status: 'DONE', raw: pay as unknown as Prisma.InputJsonValue,
          approvedAt: pay.approvedAt ? new Date(pay.approvedAt) : new Date(),
        },
      });
      let granted = 0;
      const after: (() => Promise<unknown>)[] = [];

      if (order.type === 'PRODUCT') {
        const p = await tx.product.findUniqueOrThrow({ where: { id: order.productId! }, include: { creator: true } });
        await tx.purchase.upsert({
          where: { userId_productId: { userId: order.userId, productId: p.id } },
          create: { userId: order.userId, productId: p.id, orderId: order.id },
          update: { orderId: order.id, refundedAt: null, accessedAt: null },
        });
        const feeAmount = Math.round(order.amount * fee);
        await ledgerAdd(tx, p.creatorId, 'SALE', order.amount, { type: 'ORDER', id: order.id });
        await ledgerAdd(tx, p.creatorId, 'FEE', -feeAmount, { type: 'ORDER', id: order.id });
        await tx.product.update({ where: { id: p.id }, data: { salesCount: { increment: 1 } } });
        after.push(
          () => this.notify.send(p.creator.userId, { kind: 'sale', type: 'SALE', title: `'${p.title}'이(가) 판매되었습니다.`, targetType: 'PRODUCT', targetId: p.id }),
          () => this.reward.grant(p.creator.userId, 'SALE', { type: 'ORDER', id: order.id }),
          () => this.reward.grant(order.userId, 'PURCHASE', { type: 'ORDER', id: order.id }),
        );
      } else if (order.type === 'CREDIT_PACKAGE') {
        const pkg = await tx.creditPackage.findUniqueOrThrow({ where: { id: order.creditPackageId! } });
        granted = pkg.credits + pkg.bonusCredits;
        await creditChange(tx, order.userId, 'PURCHASE', granted, { type: 'ORDER', id: order.id });
      } else {
        const d = await tx.donation.findUniqueOrThrow({ where: { orderId: order.id }, include: { creator: true } });
        await ledgerAdd(tx, d.creatorId, 'DONATION', order.amount, { type: 'DONATION', id: d.id });
        after.push(() => this.notify.send(d.creator.userId, { kind: 'sale', type: 'DONATION', title: `${order.amount.toLocaleString()}원 후원이 도착했습니다.`, body: d.message ?? undefined, targetType: 'DONATION', targetId: d.id }));
      }
      return { payment, granted, after };
    });
    for (const f of out.after) await f().catch(() => undefined); // 알림·보상 실패가 결제 결과를 바꾸지 않는다
    return {
      paymentId: out.payment.id, orderNo: order.orderNo, status: 'DONE' as const,
      method: (pay.method as string | undefined) ?? 'card', approvedAt: out.payment.approvedAt, orderType: order.type, grantedCredits: out.granted,
    };
  }

  /** 이미 승인된 주문의 결제 결과(웹훅이 먼저 처리한 뒤 confirm 이 뒤늦게 오는 경우에 재사용). */
  async paidResult(order: Order, paymentKey: string) {
    const payment = await this.prisma.payment.findUnique({ where: { orderId: order.id } });
    if (!payment || payment.paymentKey !== paymentKey) return null;
    const pkg = order.type === 'CREDIT_PACKAGE' ? await this.prisma.creditPackage.findUnique({ where: { id: order.creditPackageId! } }) : null;
    return {
      paymentId: payment.id, orderNo: order.orderNo, status: 'DONE' as const, method: (payment.raw as { method?: string } | null)?.method ?? 'card',
      approvedAt: payment.approvedAt, orderType: order.type, grantedCredits: pkg ? pkg.credits + pkg.bonusCredits : 0,
    };
  }

  // ───────── 환불 ─────────
  /** 지금 환불 가능한지. 사유가 있으면 이유 문자열을 돌려준다. */
  async refundBlocker(o: Order): Promise<string | null> {
    if (o.status !== 'PAID') return '결제 완료된 주문만 환불할 수 있습니다.';
    if (o.type === 'DONATION') return '후원은 환불하지 않습니다.';
    if (o.type === 'PRODUCT') {
      if (Date.now() - (o.paidAt?.getTime() ?? 0) > REFUND_WINDOW_MS) return '결제 후 7일이 지났습니다.';
      const pu = await this.prisma.purchase.findFirst({ where: { orderId: o.id } });
      if (pu?.accessedAt) return '다운로드 또는 조회 이력이 있습니다.';
    } else {
      const used = await this.prisma.creditTransaction.count({ where: { userId: o.userId, type: 'RESERVE', createdAt: { gte: o.paidAt ?? new Date() } } });
      if (used > 0) return '구매한 크레딧을 일부 사용했습니다.';
      const pkg = await this.prisma.creditPackage.findUniqueOrThrow({ where: { id: o.creditPackageId! } });
      const w = await this.prisma.wallet.findUnique({ where: { userId: o.userId } });
      if ((w?.creditBalance ?? 0) < pkg.credits + pkg.bonusCredits) return '회수할 크레딧이 부족합니다.';
    }
    return null;
  }

  /** 주문 취소·환불. force 는 PG 쪽에서 이미 취소된 것을 동기화할 때(규칙·PG 호출 생략). */
  async cancel(order: Order, reason: string, opts: { force?: boolean } = {}) {
    if (order.status === 'PENDING_PAYMENT') {
      const r = await this.prisma.order.updateMany({ where: { id: order.id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELED', refundReason: reason } });
      if (r.count !== 1) throw new ApiError('NOT_REFUNDABLE');
      return { orderNo: order.orderNo, status: 'CANCELED' as const, refundedAmount: 0 };
    }
    if (!opts.force && (await this.refundBlocker(order))) throw new ApiError('NOT_REFUNDABLE');
    if (order.status !== 'PAID') throw new ApiError('NOT_REFUNDABLE');
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    await this.prisma.$transaction(async (tx) => {
      // 지갑 행을 먼저 잠가 검사와 회수 사이에 크레딧이 쓰이는 경합을 막는다
      await tx.$queryRaw`SELECT "userId" FROM "Wallet" WHERE "userId" = ${order.userId} FOR UPDATE`;
      const r = await tx.order.updateMany({ where: { id: order.id, status: 'PAID' }, data: { status: 'REFUNDED', refundedAt: new Date(), refundReason: reason } });
      if (r.count !== 1) throw new ApiError('NOT_REFUNDABLE');
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'CANCELED' } });
      if (order.type === 'PRODUCT') {
        const p = await tx.product.findUniqueOrThrow({ where: { id: order.productId! }, include: { creator: true } });
        await tx.purchase.updateMany({ where: { orderId: order.id }, data: { refundedAt: new Date() } });
        const sale = await tx.sellerLedger.findFirst({ where: { creatorId: p.creatorId, type: 'FEE', refId: order.id, amount: { lt: 0 } } });
        await ledgerAdd(tx, p.creatorId, 'REFUND', -order.amount, { type: 'ORDER', id: order.id });
        if (sale) await ledgerAdd(tx, p.creatorId, 'FEE', -sale.amount, { type: 'ORDER', id: order.id }); // 수수료도 되돌림(FEE 는 음수라 부호 반대로 +)
        await tx.product.update({ where: { id: p.id }, data: { salesCount: { decrement: 1 } } });
        await revokePoints(tx, p.creator.userId, 'SALE', { type: 'ORDER', id: order.id });
        await revokePoints(tx, order.userId, 'PURCHASE', { type: 'ORDER', id: order.id });
      } else if (order.type === 'CREDIT_PACKAGE') {
        const pkg = await tx.creditPackage.findUniqueOrThrow({ where: { id: order.creditPackageId! } });
        const total = pkg.credits + pkg.bonusCredits;
        // 일반 환불은 사전 검사로 잔액이 충분함을 확인했다. PG 가 먼저 취소한 경우(force)는 남은 크레딧만큼만 회수한다
        const w = await tx.wallet.findUnique({ where: { userId: order.userId } });
        const take = opts.force ? Math.min(total, w?.creditBalance ?? 0) : total;
        if (take > 0) await creditChange(tx, order.userId, 'REFUND', -take, { type: 'ORDER', id: order.id });
      } else {
        const d = await tx.donation.findUniqueOrThrow({ where: { orderId: order.id } });
        await ledgerAdd(tx, d.creatorId, 'REFUND', -order.amount, { type: 'DONATION', id: d.id });
      }
      // PG 환불은 마지막에: 실패하면 위의 모든 DB 변경이 함께 롤백된다(돈도 내부 상태도 그대로)
      if (!opts.force) await this.toss.cancel(payment.paymentKey, reason);
    });
    return { orderNo: order.orderNo, status: 'REFUNDED' as const, refundedAmount: order.amount };
  }
}
