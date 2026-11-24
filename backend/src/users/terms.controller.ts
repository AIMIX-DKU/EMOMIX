import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { parse, z } from '../common/validate.js';
import { PrismaService } from '../prisma.service.js';

@Controller()
export class TermsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('terms') @Access('none')
  async list() {
    const rows = await this.prisma.term.findMany({ orderBy: { effectiveAt: 'asc' } });
    return {
      items: rows.map((t) => ({ id: t.id, type: t.type, title: t.title, version: t.version, required: t.required, effectiveAt: t.effectiveAt })),
    };
  }

  @Get('terms/:termId') @Access('none')
  async detail(@Param('termId') termId: string) {
    const t = await this.prisma.term.findUnique({ where: { id: termId } });
    if (!t) throw new ApiError('NOT_FOUND');
    return { id: t.id, type: t.type, title: t.title, version: t.version, required: t.required, content: t.content };
  }

  /** 현재 동의 상태를 주어진 목록으로 맞춘다. 필수 약관(창작자 약관은 창작자만)을 빼면 TERMS_REQUIRED. */
  @Put('users/me/agreements') @Access('user')
  async setAgreements(@CurrentUser() me: Me, @Body() body: unknown) {
    const { agreedTermIds } = parse(z.object({ agreedTermIds: z.array(z.string()).max(20) }), body);
    const terms = await this.prisma.term.findMany();
    const known = new Set(terms.map((t) => t.id));
    if (agreedTermIds.some((id) => !known.has(id))) throw new ApiError('VALIDATION_ERROR', '알 수 없는 약관입니다.');
    const need = terms.filter((t) => t.required && (t.type !== 'CREATOR' || me.creatorId));
    if (need.some((t) => !agreedTermIds.includes(t.id))) throw new ApiError('TERMS_REQUIRED');
    await this.prisma.$transaction([
      this.prisma.userAgreement.deleteMany({ where: { userId: me.id, termId: { notIn: agreedTermIds } } }),
      ...agreedTermIds.map((termId) =>
        this.prisma.userAgreement.upsert({ where: { userId_termId: { userId: me.id, termId } }, create: { userId: me.id, termId }, update: {} }),
      ),
    ]);
    return null;
  }
}
