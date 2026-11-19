import { Body, Controller, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { parse, z } from '../common/validate.js';
import { PrismaService } from '../prisma.service.js';

const account = z.object({
  bankName: z.string().trim().min(1).max(30),
  accountHolder: z.string().trim().min(1).max(30),
  accountNumber: z.string().trim().min(4).max(30),
});
const mask = (n: string) => `***-**-${n.replace(/\D/g, '').slice(-4)}`;

@Controller('creators/me')
export class CreatorsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Post() @HttpCode(201) @Access('user')
  async register(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(z.object({ agreedTermIds: z.array(z.string()), payoutAccount: account }), body);
    if (!b.agreedTermIds.includes('term-creator')) throw new ApiError('TERMS_REQUIRED');
    if (await this.prisma.creator.findUnique({ where: { userId: me.id } })) throw new ApiError('DUPLICATED');
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { nickname: true } });
    const c = await this.prisma.$transaction(async (tx) => {
      await tx.userAgreement.upsert({
        where: { userId_termId: { userId: me.id, termId: 'term-creator' } },
        create: { userId: me.id, termId: 'term-creator' },
        update: {},
      });
      return tx.creator.create({ data: { userId: me.id, displayName: u.nickname, ...b.payoutAccount } });
    });
    return { status: c.status, registeredAt: c.createdAt };
  }

  @Get() @Access('creator')
  async get(@CurrentUser() me: Me) {
    const c = await this.prisma.creator.findUniqueOrThrow({ where: { id: me.creatorId } });
    return {
      status: c.status, registeredAt: c.createdAt,
      payoutAccount: { bankName: c.bankName, accountHolder: c.accountHolder, accountNumberMasked: mask(c.accountNumber) },
    };
  }

  @Patch() @Access('creator')
  async update(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(z.object({ payoutAccount: account }), body);
    await this.prisma.creator.update({ where: { id: me.creatorId }, data: b.payoutAccount });
    return null;
  }
}
