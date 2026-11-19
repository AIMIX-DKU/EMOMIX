import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Patch, Post, Put, Query } from '@nestjs/common';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { PlanService } from './plan.service.js';
import { SubscriptionService } from './subscription.service.js';

const paid = z.enum(['STANDARD', 'PRO']);
const keys = { authKey: z.string().min(1).max(300), customerKey: z.string().min(1).max(100) };

@Controller()
export class SubscriptionController {
  constructor(
    @Inject(SubscriptionService) private readonly subs: SubscriptionService,
    @Inject(PlanService) private readonly plans: PlanService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
  ) {}

  @Get('subscription-plans') @Access('none')
  async list() {
    return { items: await this.plans.list() };
  }

  @Get('subscriptions/me') @Access('user')
  me(@CurrentUser() me: Me) {
    return this.subs.me(me.id);
  }

  @Post('subscriptions') @HttpCode(201) @Access('user')
  start(@CurrentUser() me: Me, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const b = parse(z.object({ planCode: paid, ...keys }), body);
    return this.idem.run(me.id, key, b, () => this.subs.start(me.id, b));
  }

  @Patch('subscriptions/me') @Access('user')
  schedule(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(z.object({ planCode: paid }), body);
    return this.subs.schedulePlan(me.id, b.planCode);
  }

  @Delete('subscriptions/me') @Access('user')
  cancel(@CurrentUser() me: Me) {
    return this.subs.cancel(me.id);
  }

  @Post('subscriptions/me/resume') @HttpCode(200) @Access('user')
  resume(@CurrentUser() me: Me) {
    return this.subs.resume(me.id);
  }

  @Put('subscriptions/me/payment-method') @Access('user')
  card(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.subs.changeCard(me.id, parse(z.object(keys), body));
  }

  @Get('subscriptions/me/invoices') @Access('user')
  async invoices(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const { rows, total } = await this.subs.invoices(me.id, p);
    return pageResult(
      rows.map((r) => ({
        id: r.id, orderNo: r.orderNo, planCode: r.planCode, periodStart: r.periodStart, periodEnd: r.periodEnd, amount: r.amount, status: r.status,
        failReason: r.failReason, creditsGranted: r.creditsGranted, createdAt: r.createdAt,
      })),
      total, p,
    );
  }

  /** Vercel Cron 이 하루 한 번 호출한다(Authorization: Bearer CRON_SECRET). */
  @Get('internal/billing/run') @Access('cron')
  run() {
    return this.subs.runBilling();
  }
}
