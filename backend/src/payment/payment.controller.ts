import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { PolicyService } from '../common/policy.service.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { PrismaService } from '../prisma.service.js';
import { OrderService, orderView } from './order.service.js';
import { TossService } from './toss.service.js';

const TYPES = ['PRODUCT', 'CREDIT_PACKAGE', 'DONATION', 'SUBSCRIPTION'] as const;
const STATUSES = ['PENDING_PAYMENT', 'PAID', 'CANCELED', 'REFUNDED', 'EXPIRED'] as const;

@Controller()
export class PaymentController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrderService) private readonly orders: OrderService,
    @Inject(TossService) private readonly toss: TossService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  // ───────── 주문 ─────────
  @Post('orders') @HttpCode(201) @Access('user')
  async createOrder(@CurrentUser() me: Me, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const b = parse(z.object({ type: z.enum(['PRODUCT', 'CREDIT_PACKAGE']), productId: z.string().optional(), packageId: z.string().optional() }), body);
    return this.idem.run(me.id, key, b, async () => {
      if (b.type === 'PRODUCT') {
        if (!b.productId) throw new ApiError('VALIDATION_ERROR', 'productId 가 필요합니다.');
        const p = await this.prisma.product.findUnique({ where: { id: b.productId }, include: { creator: true } });
        if (!p) throw new ApiError('NOT_FOUND');
        if (p.status !== 'ON_SALE' || p.hidden || p.creator.status !== 'ACTIVE') throw new ApiError('PRODUCT_UNAVAILABLE');
        if (p.creator.userId === me.id) throw new ApiError('SELF_ACTION');
        if (await this.prisma.purchase.findFirst({ where: { userId: me.id, productId: p.id, refundedAt: null } })) throw new ApiError('ALREADY_PURCHASED');
        return orderView(await this.orders.create(me.id, { type: 'PRODUCT', productId: p.id, orderName: p.title, amount: p.price }));
      }
      if (!b.packageId) throw new ApiError('VALIDATION_ERROR', 'packageId 가 필요합니다.');
      const pkg = await this.prisma.creditPackage.findFirst({ where: { id: b.packageId, active: true } });
      if (!pkg) throw new ApiError('NOT_FOUND');
      return orderView(await this.orders.create(me.id, { type: 'CREDIT_PACKAGE', creditPackageId: pkg.id, orderName: pkg.name, amount: pkg.price }));
    });
  }

  @Get('orders') @Access('user')
  async list(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.OrderWhereInput = {
      userId: me.id,
      ...(q.type ? { type: parse(z.enum(TYPES), q.type) } : {}), ...(q.status ? { status: parse(z.enum(STATUSES), q.status) } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.order.count({ where }),
    ]);
    const items = await Promise.all(rows.map(async (o) => ({ ...orderView(await this.orders.expireIfNeeded(o)), createdAt: o.createdAt })));
    return pageResult(items, total, p);
  }

  private async own(me: Me, orderNo: string) {
    const o = await this.prisma.order.findUnique({ where: { orderNo } });
    if (!o || o.userId !== me.id) throw new ApiError('NOT_FOUND');
    return this.orders.expireIfNeeded(o);
  }

  @Get('orders/:orderNo') @Access('user')
  async detail(@CurrentUser() me: Me, @Param('orderNo') orderNo: string) {
    const o = await this.own(me, orderNo);
    const pay = await this.prisma.payment.findUnique({ where: { orderId: o.id } });
    return {
      ...orderView(o),
      payment: pay ? { paymentId: pay.id, method: (pay.raw as { method?: string } | null)?.method ?? 'card', approvedAt: pay.approvedAt } : null,
      refundable: (await this.orders.refundBlocker(o)) === null, createdAt: o.createdAt,
    };
  }

  @Post('orders/:orderNo/cancel') @HttpCode(200) @Access('user')
  async cancel(@CurrentUser() me: Me, @Param('orderNo') orderNo: string, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.string().trim().min(1).max(200) }), body);
    return this.orders.cancel(await this.own(me, orderNo), b.reason);
  }

  // ───────── 결제 ─────────
  @Post('payments/confirm') @HttpCode(200) @Access('user')
  async confirm(@CurrentUser() me: Me, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const b = parse(z.object({ paymentKey: z.string().min(1).max(200), orderNo: z.string(), amount: z.number().int().positive() }), body);
    return this.idem.run(me.id, key, b, async () => {
      const order = await this.own(me, b.orderNo);
      if (order.status === 'PAID') {
        const done = await this.orders.paidResult(order, b.paymentKey); // 웹훅이 먼저 처리한 경우 같은 결과를 돌려준다
        if (done) return done;
      }
      if (order.status !== 'PENDING_PAYMENT') throw new ApiError('ORDER_NOT_PENDING');
      if (b.amount !== order.amount) throw new ApiError('AMOUNT_MISMATCH'); // 금액은 서버가 가진 주문 금액으로만 승인한다
      const pay = await this.toss.confirm(b.paymentKey, order.orderNo, order.amount);
      if (pay.totalAmount !== order.amount) throw new ApiError('AMOUNT_MISMATCH');
      return this.orders.fulfill(order, pay);
    });
  }

  /** PG → 서버 호출(쿠키·CSRF 없음). 서명을 검증하고, 본문을 믿지 않고 PG 에 상태를 다시 물어 처리한다. 중복 도착해도 결과는 같다. */
  @Post('payments/webhook') @HttpCode(200) @Access('webhook')
  async webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-webhook-signature') sig: string | undefined, @Body() body: unknown) {
    // 서명 헤더가 오면 반드시 맞아야 한다. 없으면 본문을 믿지 않고 아래에서 PG 에 상태를 다시 조회한 결과만 사용한다.
    if (sig !== undefined && !this.toss.verifySignature(req.rawBody, sig)) throw new ApiError('INVALID_SIGNATURE');
    const b = parse(
      z.object({ eventType: z.string(), createdAt: z.string().optional(), data: z.object({ paymentKey: z.string(), orderId: z.string(), status: z.string() }) }),
      body,
    );
    const order = await this.prisma.order.findUnique({ where: { orderNo: b.data.orderId } });
    if (!order) return null; // 모르는 주문은 재시도를 막기 위해 정상 응답
    const pg = await this.toss.get(b.data.paymentKey, { orderId: order.orderNo, status: b.data.status, amount: order.amount });
    if (!pg || pg.orderId !== order.orderNo) return null;

    if (pg.status === 'DONE' && order.status === 'PENDING_PAYMENT' && pg.totalAmount === order.amount) {
      await this.orders.fulfill(order, pg).catch((e) => { if (!(e instanceof ApiError)) throw e; });
    } else if (pg.status === 'DONE' && (order.status === 'EXPIRED' || order.status === 'CANCELED')) {
      // 만료·취소된 주문에 결제가 들어온 경우: 이행할 수 없으므로 자동 환불한다
      await this.toss.cancel(b.data.paymentKey, '만료/취소된 주문 자동 환불').catch(() => undefined);
    } else if (pg.status === 'CANCELED' && order.status === 'PAID') {
      await this.orders.cancel(order, 'PG 취소 동기화', { force: true }).catch((e) => { if (!(e instanceof ApiError)) throw e; });
    }
    return null;
  }
}
