import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { NotifyService } from '../common/notify.service.js';
import { POLICY_DEFAULTS, PolicyService } from '../common/policy.service.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { creditChange } from '../common/wallet.js';
import { ledgerAdd } from '../payment/ledger.js';
import { PrismaService } from '../prisma.service.js';
import { restoreSuspendedProducts } from '../common/suspension.js';
import { REPORT_TARGETS, reportStatusOut, targetOwner, type ReportTarget } from '../report/report.controller.js';

const num = (min: number, max: number) => z.number().min(min).max(max);
/** 관리자가 바꿀 수 있는 정책과 허용 범위 */
const POLICY_SCHEMA = z.object({
  sellerFeeRate: num(0, 0.9), pointToCreditRate: num(0, 10), monthlyPointEarnCap: num(0, 1_000_000).int(), monthlyPointExchangeCap: num(0, 1_000_000).int(),
  dailyGenerationLimit: num(0, 10_000).int(), signupGrantCredits: num(0, 10_000).int(), maxQueueLength: num(1, 10_000).int(), minSettlementAmount: num(0, 100_000_000).int(),
});
const POLICY_KEYS = Object.keys(POLICY_SCHEMA.shape) as (keyof typeof POLICY_DEFAULTS)[];

@Controller('admin')
export class AdminController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
  ) {}

  private audit(adminId: string, action: string, target?: string, detail?: object) {
    return this.prisma.auditLog.create({ data: { adminId, action, target, detail: detail as Prisma.InputJsonValue | undefined } });
  }

  // ───────── 신고 ─────────
  @Get('reports') @Access('admin')
  async reports(@Query() q: Record<string, string>) {
    const p = pageOf(q);
    const st = q.status ? parse(z.enum(['RECEIVED', 'RESOLVED', 'DISMISSED']), q.status) : undefined;
    const where: Prisma.ReportWhereInput = {
      ...(st ? { status: st === 'RECEIVED' ? 'OPEN' : st === 'DISMISSED' ? 'REJECTED' : 'RESOLVED' } : {}), ...(q.targetType ? { targetType: q.targetType } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.report.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.report.count({ where }),
    ]);
    return pageResult(rows.map((r) => this.reportView(r)), total, p);
  }

  private reportView(r: Prisma.ReportGetPayload<object>) {
    return {
      reportId: r.id, targetType: r.targetType, targetId: r.targetId, reason: r.reason, detail: r.detail, status: reportStatusOut(r.status),
      reporterId: r.reporterId, createdAt: r.createdAt,
    };
  }

  private async snapshot(type: ReportTarget, id: string): Promise<Record<string, unknown>> {
    switch (type) {
      case 'POST': { const x = await this.prisma.post.findUnique({ where: { id } }); return x ? { title: x.title, authorId: x.authorId, hidden: x.hidden, deleted: !!x.deletedAt } : {}; }
      case 'COMMENT': { const x = await this.prisma.comment.findUnique({ where: { id } }); return x ? { content: x.body, authorId: x.authorId, hidden: x.hidden } : {}; }
      case 'REVIEW': { const x = await this.prisma.review.findUnique({ where: { id } }); return x ? { content: x.body, rating: x.rating, authorId: x.authorId, hidden: x.hidden } : {}; }
      case 'PRODUCT': { const x = await this.prisma.product.findUnique({ where: { id } }); return x ? { title: x.title, status: x.status, creatorId: x.creatorId } : {}; }
      case 'USER': { const x = await this.prisma.user.findUnique({ where: { id } }); return x ? { nickname: x.nickname, status: x.status } : {}; }
    }
  }

  @Get('reports/:id') @Access('admin')
  async report(@Param('id') id: string) {
    const r = await this.prisma.report.findUnique({ where: { id } });
    if (!r) throw new ApiError('NOT_FOUND');
    return { ...this.reportView(r), targetSnapshot: await this.snapshot(r.targetType as ReportTarget, r.targetId), handledBy: r.handledBy, handledAction: r.handledAction };
  }

  @Patch('reports/:id') @Access('admin')
  async handle(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ action: z.enum(['DISMISS', 'HIDE_CONTENT', 'WARN', 'SUSPEND_USER']), note: z.string().max(500).optional() }), body);
    const r = await this.prisma.report.findUnique({ where: { id } });
    if (!r) throw new ApiError('NOT_FOUND');
    if (r.status !== 'OPEN') throw new ApiError('VALIDATION_ERROR', '이미 처리된 신고입니다.');
    const type = r.targetType as ReportTarget;
    const owner = await targetOwner(this.prisma, type, r.targetId);

    if (b.action === 'HIDE_CONTENT') {
      if (type === 'USER') throw new ApiError('VALIDATION_ERROR', '사용자는 숨길 수 없습니다. 정지를 사용하세요.');
      await this.setHidden(type, r.targetId, true);
    } else if (b.action === 'WARN' && owner) {
      await this.notify.send(owner, { kind: 'system', type: 'SYSTEM', title: '운영 정책 경고', body: b.note ?? '신고가 접수되어 콘텐츠가 검토되었습니다.', targetType: type, targetId: r.targetId });
    } else if (b.action === 'SUSPEND_USER') {
      if (!owner) throw new ApiError('NOT_FOUND');
      if (owner === me.id) throw new ApiError('SELF_ACTION');
      await this.suspend(owner, b.note ?? '신고 처리에 따른 정지', undefined);
    }
    const status = b.action === 'DISMISS' ? 'REJECTED' : 'RESOLVED';
    await this.prisma.report.update({ where: { id }, data: { status, adminNote: b.note, handledBy: me.id, handledAction: b.action, processedAt: new Date() } });
    await this.audit(me.id, 'REPORT_' + b.action, id, { targetType: type, targetId: r.targetId });
    await this.notify.send(r.reporterId, {
      kind: 'system', type: 'REPORT_RESULT', title: '신고 처리 결과', body: b.action === 'DISMISS' ? '검토 결과 조치가 필요하지 않다고 판단했습니다.' : '신고하신 내용에 대해 조치했습니다.', targetType: 'REPORT', targetId: id,
    });
    return { reportId: id, status: reportStatusOut(status) };
  }

  // ───────── 사용자 ─────────
  @Get('users') @Access('admin')
  async users(@Query() q: Record<string, string>) {
    const p = pageOf(q);
    const st = q.status ? parse(z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']), q.status) : undefined;
    const where: Prisma.UserWhereInput = {
      ...(st ? { status: st === 'DELETED' ? 'WITHDRAWN' : st } : {}),
      ...(q.keyword ? { OR: [{ email: { contains: q.keyword, mode: 'insensitive' } }, { nickname: { contains: q.keyword, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { creator: { select: { id: true } } } }),
      this.prisma.user.count({ where }),
    ]);
    return pageResult(
      rows.map((u) => ({ id: u.id, email: u.email, nickname: u.nickname, role: u.role, status: u.status === 'WITHDRAWN' ? 'DELETED' : u.status, isCreator: !!u.creator, createdAt: u.createdAt })),
      total, p,
    );
  }

  /** 정지: 모든 토큰 폐기 + 판매 상품 숨김. */
  private async suspend(userId: string, reason: string, until: Date | undefined) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, include: { creator: true } });
    if (!u || u.status === 'WITHDRAWN') throw new ApiError('NOT_FOUND');
    // 이 정지로 숨기는 상품 ID 를 기록해 둔다(해제 때 이것만 복구)
    const onSale = u.creator ? await this.prisma.product.findMany({ where: { creatorId: u.creator.id, status: 'ON_SALE' }, select: { id: true } }) : [];
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED', suspendedReason: reason, suspendedUntil: until ?? null } }),
      this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      ...(u.creator ? [this.prisma.product.updateMany({ where: { creatorId: u.creator.id, status: 'ON_SALE' }, data: { status: 'HIDDEN' } })] : []),
      this.prisma.auditLog.create({ data: { adminId: 'system', action: 'USER_SUSPEND_PRODUCTS', target: userId, detail: { productIds: onSale.map((p) => p.id) } } }),
    ]);
  }

  @Post('users/:userId/suspension') @HttpCode(201) @Access('admin')
  async suspendUser(@CurrentUser() me: Me, @Param('userId') userId: string, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.string().trim().min(1).max(300), until: z.string().datetime().optional() }), body);
    if (userId === me.id) throw new ApiError('SELF_ACTION');
    await this.suspend(userId, b.reason, b.until ? new Date(b.until) : undefined);
    await this.audit(me.id, 'USER_SUSPEND', userId, b);
    return null;
  }

  @Delete('users/:userId/suspension') @Access('admin')
  async unsuspend(@CurrentUser() me: Me, @Param('userId') userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, include: { creator: true } });
    if (!u || u.status === 'WITHDRAWN') throw new ApiError('NOT_FOUND');
    await this.prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE', suspendedReason: null, suspendedUntil: null } });
    if (u.creator) await restoreSuspendedProducts(this.prisma, userId);
    await this.audit(me.id, 'USER_UNSUSPEND', userId);
    return null;
  }

  // ───────── 콘텐츠 숨김 ─────────
  private async setHidden(type: ReportTarget, id: string, hidden: boolean) {
    const miss = () => { throw new ApiError('NOT_FOUND'); };
    if (type === 'POST') (await this.prisma.post.updateMany({ where: { id }, data: { hidden } })).count || miss();
    else if (type === 'COMMENT') (await this.prisma.comment.updateMany({ where: { id }, data: { hidden } })).count || miss();
    else if (type === 'REVIEW') (await this.prisma.review.updateMany({ where: { id }, data: { hidden } })).count || miss();
    else if (type === 'PRODUCT') {
      // 숨김 상품은 신규 구매만 막고 기존 구매자의 접근은 유지한다
      const r = await this.prisma.product.updateMany({ where: { id, status: hidden ? 'ON_SALE' : 'HIDDEN' }, data: { status: hidden ? 'HIDDEN' : 'ON_SALE' } });
      if (!r.count && !(await this.prisma.product.findUnique({ where: { id } }))) miss();
    } else throw new ApiError('VALIDATION_ERROR', '숨길 수 없는 대상입니다.');
  }

  @Patch('contents/:targetType/:targetId/visibility') @Access('admin')
  async visibility(@CurrentUser() me: Me, @Param('targetType') t: string, @Param('targetId') id: string, @Body() body: unknown) {
    const type = parse(z.enum(['POST', 'COMMENT', 'PRODUCT', 'REVIEW']), t);
    const b = parse(z.object({ hidden: z.boolean(), reason: z.string().trim().min(1).max(300) }), body);
    await this.setHidden(type, id, b.hidden);
    await this.audit(me.id, b.hidden ? 'CONTENT_HIDE' : 'CONTENT_SHOW', `${type}:${id}`, { reason: b.reason });
    return null;
  }

  // ───────── 크레딧 지급 ─────────
  @Post('credits/grants') @HttpCode(201) @Access('admin')
  async grant(@CurrentUser() me: Me, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const b = parse(z.object({ userId: z.string(), amount: z.number().int().min(1).max(100_000), reason: z.string().trim().min(1).max(300) }), body);
    return this.idem.run(me.id, key, b, async () => {
      if (!(await this.prisma.user.findFirst({ where: { id: b.userId, status: { not: 'WITHDRAWN' } } }))) throw new ApiError('NOT_FOUND');
      const out = await this.prisma.$transaction(async (tx) => {
        const w = await creditChange(tx, b.userId, 'GRANT', b.amount, { type: 'ADMIN', id: me.id });
        const t = await tx.creditTransaction.findFirstOrThrow({ where: { userId: b.userId, type: 'GRANT' }, orderBy: { createdAt: 'desc' } });
        return { transactionId: t.id, creditBalance: w.creditBalance };
      });
      await this.audit(me.id, 'CREDIT_GRANT', b.userId, { amount: b.amount, reason: b.reason });
      return out;
    });
  }

  // ───────── 통계 ─────────
  @Get('generations/stats') @Access('admin')
  async stats(@Query() q: Record<string, string>) {
    const from = new Date(parse(z.string().datetime(), q.from));
    const to = new Date(parse(z.string().datetime(), q.to));
    const jobs = await this.prisma.generationJob.findMany({ where: { createdAt: { gte: from, lte: to } }, select: { status: true, createdAt: true, startedAt: true, finishedAt: true } });
    const done = jobs.filter((j) => j.status === 'SUCCEEDED' && j.startedAt && j.finishedAt);
    const daily = new Map<string, { jobs: number; failed: number }>();
    for (const j of jobs) {
      const d = j.createdAt.toISOString().slice(0, 10);
      const e = daily.get(d) ?? { jobs: 0, failed: 0 };
      e.jobs++;
      if (j.status === 'FAILED') e.failed++;
      daily.set(d, e);
    }
    return {
      totalJobs: jobs.length, succeeded: jobs.filter((j) => j.status === 'SUCCEEDED').length,
      failed: jobs.filter((j) => j.status === 'FAILED').length, canceled: jobs.filter((j) => j.status === 'CANCELED').length,
      avgDurationSeconds: done.length ? Math.round((done.reduce((a, j) => a + (j.finishedAt!.getTime() - j.startedAt!.getTime()), 0) / done.length / 1000) * 10) / 10 : 0,
      queueLength: await this.prisma.generationJob.count({ where: { status: 'QUEUED' } }),
      estimatedCostUsd: null, // 자체 GPU 라 외부 API 비용이 없다
      daily: [...daily.entries()].sort().map(([date, v]) => ({ date, ...v })),
    };
  }

  // ───────── 정책 ─────────
  private async policies() {
    const all = await this.policy.all();
    return Object.fromEntries(POLICY_KEYS.map((k) => [k, all[k]]));
  }

  @Get('policies') @Access('admin')
  getPolicies() {
    return this.policies();
  }

  @Put('policies') @Access('admin')
  async setPolicies(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(POLICY_SCHEMA, body);
    const before = await this.policies();
    await this.prisma.$transaction(POLICY_KEYS.map((k) => this.prisma.policy.upsert({ where: { key: k }, create: { key: k, value: b[k as keyof typeof b] }, update: { value: b[k as keyof typeof b] } })));
    await this.audit(me.id, 'POLICY_UPDATE', undefined, { before, after: b });
    return this.policies();
  }

  // ───────── 정산 ─────────
  @Get('settlements') @Access('admin')
  async settlements(@Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where = q.status ? { status: parse(z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'PAID']), q.status) } : {};
    const [rows, total] = await Promise.all([
      this.prisma.settlement.findMany({ where, orderBy: { requestedAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.settlement.count({ where }),
    ]);
    return pageResult(rows.map((s) => ({ id: s.id, creatorId: s.creatorId, amount: s.amount, status: s.status, requestedAt: s.requestedAt })), total, p);
  }

  /** 시제품은 PAID 를 실제 송금 없이 장부 기록(SETTLEMENT)으로만 처리한다. */
  @Patch('settlements/:id') @Access('admin')
  async handleSettlement(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ status: z.enum(['APPROVED', 'REJECTED', 'PAID']), note: z.string().max(300).optional() }), body);
    const s = await this.prisma.settlement.findUnique({ where: { id }, include: { creator: true } });
    if (!s) throw new ApiError('NOT_FOUND');
    const ok = (s.status === 'REQUESTED' && ['APPROVED', 'REJECTED', 'PAID'].includes(b.status)) || (s.status === 'APPROVED' && ['PAID', 'REJECTED'].includes(b.status));
    if (!ok) throw new ApiError('VALIDATION_ERROR', `${s.status} 상태에서는 ${b.status} 로 바꿀 수 없습니다.`);
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.settlement.updateMany({ where: { id, status: s.status }, data: { status: b.status, note: b.note, processedAt: new Date() } });
      if (r.count !== 1) throw new ApiError('VALIDATION_ERROR', '이미 처리되었습니다.');
      if (b.status === 'PAID') {
        const row = await ledgerAdd(tx, s.creatorId, 'SETTLEMENT', -s.amount, { type: 'SETTLEMENT', id });
        if (row.balanceAfter < 0) throw new ApiError('INSUFFICIENT_BALANCE');
      }
    });
    await this.audit(me.id, 'SETTLEMENT_' + b.status, id, { amount: s.amount });
    await this.notify.send(s.creator.userId, {
      kind: 'system', type: 'SETTLEMENT', title: b.status === 'PAID' ? '정산이 완료되었습니다.' : b.status === 'APPROVED' ? '정산이 승인되었습니다.' : '정산 요청이 거절되었습니다.',
      body: b.note, targetType: 'SETTLEMENT', targetId: id,
    });
    return { id, status: b.status };
  }
}
