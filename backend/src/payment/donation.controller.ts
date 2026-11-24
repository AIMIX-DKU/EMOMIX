import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { PolicyService } from '../common/policy.service.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { CommunityService } from '../community/community.service.js';
import { isBlocked } from '../generation/generation.service.js';
import { PrismaService } from '../prisma.service.js';
import { OrderService, orderView } from './order.service.js';

@Controller('donations')
export class DonationController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrderService) private readonly orders: OrderService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
    @Inject(CommunityService) private readonly community: CommunityService,
  ) {}

  /** 후원은 혜택이 없는 응원금이라 상품 구매와 구분한다. 결제는 같은 /payments/confirm 으로 끝낸다. */
  @Post() @HttpCode(201) @Access('user')
  async create(@CurrentUser() me: Me, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const b = parse(
      z.object({ creatorId: z.string(), amount: z.number().int(), message: z.string().trim().max(100).optional(), isAnonymous: z.boolean().optional() }),
      body,
    );
    return this.idem.run(me.id, key, b, async () => {
      if (b.creatorId === me.id) throw new ApiError('SELF_ACTION');
      const creator = await this.prisma.creator.findUnique({ where: { userId: b.creatorId }, include: { user: true } });
      if (!creator || creator.status !== 'ACTIVE' || creator.user.status !== 'ACTIVE') throw new ApiError('NOT_CREATOR');
      if (b.amount < (await this.policy.get('donationMin')) || b.amount > (await this.policy.get('donationMax'))) throw new ApiError('PRICE_OUT_OF_RANGE');
      if (b.message && isBlocked(b.message)) throw new ApiError('CONTENT_BLOCKED');
      const order = await this.prisma.$transaction(async (tx) => {
        const o = await this.orders.create(me.id, { type: 'DONATION', orderName: `${creator.user.nickname}님 후원`, amount: b.amount }, tx);
        await tx.donation.create({ data: { orderId: o.id, senderId: me.id, creatorId: creator.id, amount: b.amount, message: b.message, isAnonymous: !!b.isAnonymous } });
        return o;
      });
      return orderView(order);
    });
  }

  @Get('sent') @Access('user')
  async sent(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where = { senderId: me.id, order: { status: 'PAID' as const } };
    const [rows, total] = await Promise.all([
      this.prisma.donation.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { creator: { include: { user: { include: { profileImage: true } } } } } }),
      this.prisma.donation.count({ where }),
    ]);
    return pageResult(
      await Promise.all(rows.map(async (d) => ({
        id: d.id, amount: d.amount, message: d.message, isAnonymous: d.isAnonymous, createdAt: d.createdAt, creator: await this.community.userBrief(d.creator.user),
      }))),
      total, p,
    );
  }

  @Get('received') @Access('creator')
  async received(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where = { creatorId: me.creatorId, order: { status: 'PAID' as const } };
    const [rows, total] = await Promise.all([
      this.prisma.donation.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { sender: { include: { profileImage: true } } } }),
      this.prisma.donation.count({ where }),
    ]);
    return pageResult(
      await Promise.all(rows.map(async (d) => ({
        id: d.id, amount: d.amount, message: d.message, isAnonymous: d.isAnonymous, createdAt: d.createdAt,
        from: d.isAnonymous ? null : await this.community.userBrief(d.sender),
      }))),
      total, p,
    );
  }
}
