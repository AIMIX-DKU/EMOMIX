import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { PolicyService } from '../common/policy.service.js';
import { StorageService } from '../common/storage.service.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { PrismaService } from '../prisma.service.js';
import { REFUND_WINDOW_MS } from './order.service.js';

@Controller('seller')
export class SellerController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
  ) {}

  @Get('products') @Access('creator')
  async products(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.ProductWhereInput = { creatorId: me.creatorId, ...(q.status ? { status: parse(z.enum(['ON_SALE', 'HIDDEN', 'STOPPED']), q.status) } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { creator: { include: { user: { include: { profileImage: true } } } }, reviews: { select: { rating: true } } } }),
      this.prisma.product.count({ where }),
    ]);
    return pageResult(
      await Promise.all(rows.map(async (r) => ({
        id: r.id, type: r.type, title: r.title, price: r.price, status: r.status, salesCount: r.salesCount, createdAt: r.createdAt,
        thumbnailUrl: await this.storage.getUrl((r.snapshot as { previewKey?: string }[])[0]?.previewKey),
        seller: { id: r.creator.userId, nickname: r.creator.user.nickname, profileImageUrl: await this.storage.getUrl(r.creator.user.profileImage?.storageKey) },
        reviewCount: r.reviews.length, ratingAvg: r.reviews.length ? Math.round((r.reviews.reduce((a, x) => a + x.rating, 0) / r.reviews.length) * 10) / 10 : null,
      }))),
      total, p,
    );
  }

  @Get('sales') @Access('creator')
  async sales(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.PurchaseWhereInput = { product: { creatorId: me.creatorId } };
    const [rows, total] = await Promise.all([
      this.prisma.purchase.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { product: true, order: true, user: true } }),
      this.prisma.purchase.count({ where }),
    ]);
    const fees = await this.prisma.sellerLedger.findMany({ where: { creatorId: me.creatorId, type: 'FEE', amount: { lt: 0 }, refId: { in: rows.map((r) => r.orderId) } } });
    return pageResult(
      rows.map((r) => {
        const fee = Math.abs(fees.find((f) => f.refId === r.orderId)?.amount ?? 0);
        return {
          orderNo: r.order.orderNo, productId: r.productId, productTitle: r.product.title, buyerNickname: r.user.status === 'WITHDRAWN' ? '탈퇴한 사용자' : r.user.nickname,
          amount: r.order.amount, fee, net: r.order.amount - fee, status: r.refundedAt ? 'REFUNDED' : 'PAID', createdAt: r.createdAt,
        };
      }),
      total, p,
    );
  }

  @Get('ledger') @Access('creator')
  async ledger(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.SellerLedgerWhereInput = { creatorId: me.creatorId, ...(q.type ? { type: parse(z.enum(['SALE', 'FEE', 'REFUND', 'DONATION', 'SETTLEMENT']), q.type) } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.sellerLedger.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: p.skip, take: p.take }),
      this.prisma.sellerLedger.count({ where }),
    ]);
    return pageResult(rows.map((r) => ({ id: r.id, type: r.type, amount: r.amount, balanceAfter: r.balanceAfter, refType: r.refType, refId: r.refId, createdAt: r.createdAt })), total, p);
  }

  /** 정산 가능 금액 = 장부 잔액 - 환불 가능 기간(7일) 안의 판매분 - 진행 중인 정산 요청. */
  private async balances(creatorId: string) {
    const last = await this.prisma.sellerLedger.findFirst({ where: { creatorId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const balance = last?.balanceAfter ?? 0;
    const recent = await this.prisma.purchase.findMany({
      where: { product: { creatorId }, refundedAt: null, order: { paidAt: { gte: new Date(Date.now() - REFUND_WINDOW_MS) } } }, select: { orderId: true },
    });
    const ids = recent.map((r) => r.orderId);
    const rows = ids.length ? await this.prisma.sellerLedger.findMany({ where: { creatorId, type: { in: ['SALE', 'FEE'] }, refId: { in: ids } } }) : [];
    const pending = rows.reduce((a, r) => a + r.amount, 0);
    const open = await this.prisma.settlement.aggregate({ _sum: { amount: true }, where: { creatorId, status: { in: ['REQUESTED', 'APPROVED'] } } });
    const earned = await this.prisma.sellerLedger.aggregate({ _sum: { amount: true }, where: { creatorId, type: { not: 'SETTLEMENT' } } });
    return { balance, pending, open: open._sum.amount ?? 0, earned: earned._sum.amount ?? 0, available: Math.max(0, balance - pending - (open._sum.amount ?? 0)) };
  }

  @Get('balance') @Access('creator')
  async balance(@CurrentUser() me: Me) {
    const b = await this.balances(me.creatorId!);
    return {
      availableAmount: b.available, pendingAmount: b.pending, totalEarned: b.earned,
      feeRate: await this.policy.get('sellerFeeRate'), minSettlementAmount: await this.policy.get('minSettlementAmount'),
    };
  }

  @Post('settlements') @HttpCode(201) @Access('creator')
  async request(@CurrentUser() me: Me, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const b = parse(z.object({ amount: z.number().int().positive() }), body);
    return this.idem.run(me.id, key, b, async () => {
      if (b.amount < (await this.policy.get('minSettlementAmount'))) throw new ApiError('BELOW_MINIMUM');
      // 같은 판매자의 동시 요청이 잔액을 넘기지 않도록 행 잠금 안에서 확인한다
      return this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Creator" WHERE id = ${me.creatorId} FOR UPDATE`;
        if (b.amount > (await this.balances(me.creatorId!)).available) throw new ApiError('INSUFFICIENT_BALANCE');
        const s = await tx.settlement.create({ data: { creatorId: me.creatorId!, amount: b.amount } });
        return { id: s.id, amount: s.amount, status: s.status, requestedAt: s.requestedAt };
      });
    });
  }

  @Get('settlements') @Access('creator')
  async settlements(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where = { creatorId: me.creatorId };
    const [rows, total] = await Promise.all([
      this.prisma.settlement.findMany({ where, orderBy: { requestedAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.settlement.count({ where }),
    ]);
    return pageResult(rows.map((s) => ({ id: s.id, amount: s.amount, status: s.status, requestedAt: s.requestedAt, processedAt: s.processedAt })), total, p);
  }
}
