import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { Prisma, type ReportStatus } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { PrismaService } from '../prisma.service.js';

export const REPORT_TARGETS = ['POST', 'COMMENT', 'PRODUCT', 'REVIEW', 'USER'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];
/** DB 상태 → API 표기 */
export const reportStatusOut = (s: ReportStatus) => (s === 'OPEN' ? 'RECEIVED' : s === 'REJECTED' ? 'DISMISSED' : 'RESOLVED');

/** 신고 대상의 소유자(사용자 ID)와 존재 여부. 없으면 null. */
export async function targetOwner(prisma: PrismaService, type: ReportTarget, id: string): Promise<string | null> {
  switch (type) {
    case 'POST': return (await prisma.post.findFirst({ where: { id, deletedAt: null } }))?.authorId ?? null;
    case 'COMMENT': return (await prisma.comment.findFirst({ where: { id, deletedAt: null } }))?.authorId ?? null;
    case 'REVIEW': return (await prisma.review.findUnique({ where: { id } }))?.authorId ?? null;
    case 'PRODUCT': return (await prisma.product.findUnique({ where: { id }, include: { creator: true } }))?.creator.userId ?? null;
    case 'USER': return (await prisma.user.findFirst({ where: { id, status: { not: 'WITHDRAWN' } } }))?.id ?? null;
  }
}

@Controller('reports')
export class ReportController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Post() @HttpCode(201) @Access('user')
  async create(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(
      z.object({
        targetType: z.enum(REPORT_TARGETS), targetId: z.string(), reason: z.enum(['COPYRIGHT', 'INAPPROPRIATE', 'SPAM', 'FRAUD', 'HARASSMENT', 'OTHER']),
        detail: z.string().trim().max(500).optional(),
      }),
      body,
    );
    const owner = await targetOwner(this.prisma, b.targetType, b.targetId);
    if (!owner) throw new ApiError('NOT_FOUND');
    if (owner === me.id) throw new ApiError('SELF_ACTION');
    try {
      const r = await this.prisma.report.create({ data: { reporterId: me.id, targetType: b.targetType, targetId: b.targetId, reason: b.reason, detail: b.detail } });
      return { reportId: r.id, status: 'RECEIVED' as const };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError('DUPLICATED_REPORT');
      throw e;
    }
  }

  @Get('me') @Access('user')
  async mine(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where = { reporterId: me.id };
    const [rows, total] = await Promise.all([
      this.prisma.report.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.report.count({ where }),
    ]);
    return pageResult(
      rows.map((r) => ({ reportId: r.id, targetType: r.targetType, targetId: r.targetId, reason: r.reason, status: reportStatusOut(r.status), createdAt: r.createdAt })),
      total, p,
    );
  }
}
