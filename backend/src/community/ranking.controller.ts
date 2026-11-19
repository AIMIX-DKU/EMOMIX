import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { StorageService } from '../common/storage.service.js';
import { parse, z } from '../common/validate.js';
import { PrismaService } from '../prisma.service.js';
import { CommunityService, POST_INCLUDE, VISIBLE, type SnapshotItem } from './community.service.js';

const DAYS = { DAILY: 1, WEEKLY: 7, MONTHLY: 30 } as const;

@Controller('rankings')
export class RankingController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(CommunityService) private readonly community: CommunityService,
  ) {}

  private args(q: Record<string, string>) {
    const period = q.period ? parse(z.enum(['DAILY', 'WEEKLY', 'MONTHLY']), q.period) : 'WEEKLY';
    const limit = Math.min(50, Math.max(1, parseInt(q.limit ?? '20', 10) || 20));
    return { since: new Date(Date.now() - DAYS[period] * 24 * 3600 * 1000), limit };
  }

  /** 기간 안에 받은 좋아요·북마크 수(게시물별). */
  private async activity(since: Date) {
    const [likes, marks] = await Promise.all([
      this.prisma.like.groupBy({ by: ['postId'], where: { createdAt: { gte: since } }, _count: { postId: true } }),
      this.prisma.bookmark.groupBy({ by: ['postId'], where: { createdAt: { gte: since } }, _count: { postId: true } }),
    ]);
    const m = new Map<string, { likes: number; marks: number }>();
    for (const l of likes) m.set(l.postId, { likes: l._count.postId, marks: 0 });
    for (const b of marks) m.set(b.postId, { likes: m.get(b.postId)?.likes ?? 0, marks: b._count.postId });
    return m;
  }

  /** 점수 = 좋아요*3 + 북마크*2 (기간 내). 점수가 같으면 최신 게시물이 위. */
  @Get('posts') @Access('optional')
  async posts(@CurrentUser() me: Me | undefined, @Query() q: Record<string, string>) {
    const { since, limit } = this.args(q);
    const act = await this.activity(since);
    const ids = [...act.entries()].sort((a, b) => b[1].likes * 3 + b[1].marks * 2 - (a[1].likes * 3 + a[1].marks * 2)).map(([id]) => id);
    const posts = await this.prisma.post.findMany({ where: { ...VISIBLE, id: { in: ids } }, include: POST_INCLUDE });
    const score = (id: string) => (act.get(id)!.likes * 3 + act.get(id)!.marks * 2);
    const top = posts.sort((a, b) => score(b.id) - score(a.id) || b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
    const items = await this.community.items(top, me?.id);
    return { items: items.map((it, i) => ({ rank: i + 1, ...it })) };
  }

  /** 공개 프롬프트 게시물(좋아요+북마크)과 판매 템플릿(구매 수)을 합쳐 사용 수 순으로. */
  @Get('prompts') @Access('optional')
  async prompts(@Query() q: Record<string, string>) {
    const { since, limit } = this.args(q);
    const act = await this.activity(since);
    const posts = await this.prisma.post.findMany({ where: { ...VISIBLE, sharePrompt: true } });
    const sold = await this.prisma.purchase.groupBy({ by: ['productId'], where: { createdAt: { gte: since }, refundedAt: null }, _count: { productId: true } });
    const products = await this.prisma.product.findMany({
      where: { type: { in: ['PROMPT_TEMPLATE', 'RECIPE_BUNDLE'] }, status: 'ON_SALE', hidden: false, id: { in: sold.map((s) => s.productId) } },
    });
    const rows = [
      ...posts.map((p) => ({ kind: 'POST' as const, id: p.id, title: p.title, snapshot: p.snapshot, usedCount: (act.get(p.id)?.likes ?? 0) + (act.get(p.id)?.marks ?? 0) })),
      ...products.map((p) => ({ kind: 'PRODUCT' as const, id: p.id, title: p.title, snapshot: p.snapshot, usedCount: sold.find((s) => s.productId === p.id)?._count.productId ?? 0 })),
    ].filter((r) => r.usedCount > 0).sort((a, b) => b.usedCount - a.usedCount).slice(0, limit);
    return {
      items: await Promise.all(rows.map(async (r, i) => {
        const s = (r.snapshot as SnapshotItem[])?.[0];
        return { rank: i + 1, kind: r.kind, id: r.id, title: r.title, thumbnailUrl: await this.storage.getUrl(s?.thumbKey ?? s?.imageKey), usedCount: r.usedCount };
      })),
    };
  }

  /** 점수 = 기간 내 받은 좋아요 + 팔로워*0.5 + 기간 내 판매 수*3. */
  @Get('creators') @Access('optional')
  async creators(@Query() q: Record<string, string>) {
    const { since, limit } = this.args(q);
    const likes = await this.prisma.like.findMany({ where: { createdAt: { gte: since }, post: VISIBLE }, select: { post: { select: { authorId: true } } } });
    const sales = await this.prisma.purchase.findMany({ where: { createdAt: { gte: since }, refundedAt: null }, select: { product: { select: { creator: { select: { userId: true } } } } } });
    const score = new Map<string, number>();
    for (const l of likes) score.set(l.post.authorId, (score.get(l.post.authorId) ?? 0) + 1);
    for (const s of sales) {
      const u = s.product.creator.userId;
      score.set(u, (score.get(u) ?? 0) + 3);
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...score.keys()] }, status: 'ACTIVE' }, include: { profileImage: true, _count: { select: { followers: true } } },
    });
    const rows = users
      .map((u) => ({ u, score: (score.get(u.id) ?? 0) + u._count.followers * 0.5 }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
    return {
      items: await Promise.all(rows.map(async (r, i) => ({
        rank: i + 1, user: await this.community.userBrief(r.u), followerCount: r.u._count.followers, score: r.score,
      }))),
    };
  }
}
