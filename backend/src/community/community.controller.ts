import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { env } from '../config.js';
import { ApiError } from '../common/envelope.js';
import { NotifyService } from '../common/notify.service.js';
import { RewardService } from '../common/reward.service.js';
import { StorageService } from '../common/storage.service.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { isBlocked } from '../generation/generation.service.js';
import { PrismaService } from '../prisma.service.js';
import { CommunityService, POST_INCLUDE, VISIBLE, type SnapshotItem } from './community.service.js';

const tagsSchema = z.array(z.string().trim().min(1).max(20)).max(5);
const uniq = (a: string[]) => [...new Set(a)];

@Controller()
export class CommunityController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(CommunityService) private readonly community: CommunityService,
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Inject(RewardService) private readonly reward: RewardService,
  ) {}

  // ───────── 게시물 ─────────
  @Post('posts') @HttpCode(201) @Access('user')
  async create(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(
      z.object({ setId: z.string(), title: z.string().trim().min(1).max(50), description: z.string().max(1000).optional(), tags: tagsSchema.optional(), sharePrompt: z.boolean().optional() }),
      body,
    );
    const set = await this.prisma.emoticonSet.findFirst({
      where: { id: b.setId, deletedAt: null }, include: { emoticons: { where: { status: 'READY' }, include: { current: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!set) throw new ApiError('NOT_FOUND');
    if (set.ownerId !== me.id) throw new ApiError('FORBIDDEN', '본인 세트가 아닙니다.');
    const ready = set.emoticons.filter((e) => e.current);
    if (!ready.length) throw new ApiError('VALIDATION_ERROR', '생성된 이모티콘이 없는 세트입니다.');
    if (await this.prisma.post.findFirst({ where: { setId: set.id, deletedAt: null } })) throw new ApiError('ALREADY_PUBLISHED');
    if (isBlocked([b.title, b.description ?? '', ...(b.tags ?? [])].join(' '))) throw new ApiError('CONTENT_BLOCKED');

    // 게시 시점의 이미지를 스냅샷으로 고정한다(이후 원본을 고쳐도 게시물은 그대로)
    const snapshot: SnapshotItem[] = ready.map((e) => ({ id: randomUUID(), label: e.label, imageKey: e.current!.imageKey, thumbKey: e.current!.thumbKey }));
    const promptInfo = b.sharePrompt ? await this.promptInfoOf(set.characterId) : undefined;
    const tags = uniq(b.tags ?? []);
    const post = await this.prisma.$transaction(async (tx) => {
      const tagRows = await Promise.all(tags.map((name) => tx.tag.upsert({ where: { name }, create: { name }, update: {} })));
      return tx.post.create({
        data: {
          authorId: me.id, setId: set.id, title: b.title, body: b.description, sharePrompt: !!b.sharePrompt,
          promptInfo: promptInfo as Prisma.InputJsonValue | undefined, snapshot: snapshot as unknown as Prisma.InputJsonValue,
          tags: { create: tagRows.map((t) => ({ tagId: t.id })) },
        },
      });
    });
    await this.reward.grant(me.id, 'POST_PUBLISHED', { type: 'SET', id: set.id });
    return { id: post.id, createdAt: post.createdAt };
  }

  private async promptInfoOf(characterId: string | null) {
    const ch = characterId ? await this.prisma.character.findUnique({ where: { id: characterId } }) : null;
    const style = ch?.stylePresetKey ? await this.prisma.stylePreset.findUnique({ where: { key: ch.stylePresetKey } }) : null;
    return {
      prompt: [style?.promptHint, ch?.appearanceDescription ?? ch?.description].filter(Boolean).join('. '),
      model: env('GEN_MODEL_NAME', 'FLUX.1 Kontext'), modelVersion: env('GEN_MODEL_VERSION', 'dev'), settings: {},
    };
  }

  @Get('posts') @Access('optional')
  async list(@CurrentUser() me: Me | undefined, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.PostWhereInput = { ...VISIBLE };
    if (q.authorId) where.authorId = q.authorId;
    if (q.tag) where.tags = { some: { tag: { name: q.tag } } };
    if (q.keyword) {
      const k = q.keyword.trim();
      where.OR = [
        { title: { contains: k, mode: 'insensitive' } },
        { tags: { some: { tag: { name: { contains: k, mode: 'insensitive' } } } } },
        { author: { nickname: { contains: k, mode: 'insensitive' } } },
      ];
    }
    const sort = q.sort ? parse(z.enum(['LATEST', 'POPULAR']), q.sort) : 'LATEST';
    const orderBy: Prisma.PostOrderByWithRelationInput[] = sort === 'POPULAR' ? [{ likeCount: 'desc' }, { createdAt: 'desc' }] : [{ createdAt: 'desc' }];
    const [rows, total] = await Promise.all([
      this.prisma.post.findMany({ where, orderBy, skip: p.skip, take: p.take, include: POST_INCLUDE }),
      this.prisma.post.count({ where }),
    ]);
    return pageResult(await this.community.items(rows, me?.id), total, p);
  }

  @Get('posts/:id') @Access('optional')
  async detail(@CurrentUser() me: Me | undefined, @Param('id') id: string) {
    const post = await this.visible(id, me);
    const [item] = await this.community.items([post], me?.id);
    const snap = (post.snapshot as SnapshotItem[]) ?? [];
    const bookmarked = me ? !!(await this.prisma.bookmark.findUnique({ where: { userId_postId: { userId: me.id, postId: id } } })) : false;
    const product = await this.prisma.product.findFirst({ where: { setId: post.setId, status: 'ON_SALE' }, select: { id: true } });
    return {
      ...item, description: post.body,
      emoticons: await Promise.all(snap.map(async (s) => ({ id: s.id, label: s.label, imageUrl: await this.storage.getUrl(s.imageKey) }))),
      promptInfo: post.sharePrompt ? post.promptInfo : null, isBookmarked: bookmarked, productId: product?.id ?? null,
    };
  }

  /** 삭제·숨김 게시물은 작성자 본인에게만 보인다. */
  private async visible(id: string, me?: Me) {
    const post = await this.prisma.post.findUnique({ where: { id }, include: POST_INCLUDE });
    if (!post || post.deletedAt || (post.hidden && post.authorId !== me?.id)) throw new ApiError('NOT_FOUND');
    return post;
  }

  private async mine(id: string, me: Me) {
    const post = await this.prisma.post.findUnique({ where: { id } });
    if (!post || post.deletedAt) throw new ApiError('NOT_FOUND');
    if (post.authorId !== me.id) throw new ApiError('FORBIDDEN', '작성자가 아닙니다.');
    return post;
  }

  @Patch('posts/:id') @Access('user')
  async update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    const post = await this.mine(id, me);
    const b = parse(
      z.object({ title: z.string().trim().min(1).max(50).optional(), description: z.string().max(1000).nullable().optional(), tags: tagsSchema.optional(), sharePrompt: z.boolean().optional() }),
      body,
    );
    if (isBlocked([b.title ?? '', b.description ?? '', ...(b.tags ?? [])].join(' '))) throw new ApiError('CONTENT_BLOCKED');
    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.PostUpdateInput = {};
      if (b.title !== undefined) data.title = b.title;
      if (b.description !== undefined) data.body = b.description;
      if (b.sharePrompt !== undefined) {
        data.sharePrompt = b.sharePrompt;
        if (b.sharePrompt && !post.promptInfo) data.promptInfo = (await this.promptInfoOf((await tx.emoticonSet.findUnique({ where: { id: post.setId } }))?.characterId ?? null)) as Prisma.InputJsonValue;
      }
      if (b.tags) {
        const rows = await Promise.all(uniq(b.tags).map((name) => tx.tag.upsert({ where: { name }, create: { name }, update: {} })));
        await tx.postTag.deleteMany({ where: { postId: id } });
        data.tags = { create: rows.map((t) => ({ tagId: t.id })) };
      }
      await tx.post.update({ where: { id }, data });
    });
    return { id };
  }

  @Delete('posts/:id') @Access('user')
  async remove(@CurrentUser() me: Me, @Param('id') id: string) {
    await this.mine(id, me);
    await this.prisma.post.update({ where: { id }, data: { deletedAt: new Date() } });
    return null;
  }

  // ───────── 좋아요 / 북마크 ─────────
  @Post('posts/:id/likes') @HttpCode(201) @Access('user')
  async like(@CurrentUser() me: Me, @Param('id') id: string) {
    const post = await this.visible(id, me);
    if (post.authorId === me.id) throw new ApiError('SELF_ACTION');
    let likeCount: number;
    try {
      likeCount = await this.prisma.$transaction(async (tx) => {
        await tx.like.create({ data: { userId: me.id, postId: id } });
        return (await tx.post.update({ where: { id }, data: { likeCount: { increment: 1 } } })).likeCount;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError('DUPLICATED');
      throw e;
    }
    const who = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { nickname: true } });
    await this.notify.send(post.authorId, { kind: 'like', type: 'LIKE', title: `${who.nickname}님이 내 게시물을 좋아합니다.`, targetType: 'POST', targetId: id });
    await this.reward.grant(post.authorId, 'POST_LIKED', { type: 'LIKE', id: `${id}:${me.id}` });
    return { likeCount };
  }

  @Delete('posts/:id/likes') @Access('user')
  async unlike(@CurrentUser() me: Me, @Param('id') id: string) {
    await this.visible(id, me);
    const likeCount = await this.prisma.$transaction(async (tx) => {
      const r = await tx.like.deleteMany({ where: { userId: me.id, postId: id } });
      const p = await tx.post.update({ where: { id }, data: { likeCount: { decrement: r.count } } });
      return p.likeCount;
    });
    return { likeCount };
  }

  @Post('posts/:id/bookmarks') @HttpCode(201) @Access('user')
  async bookmark(@CurrentUser() me: Me, @Param('id') id: string) {
    await this.visible(id, me);
    try {
      await this.prisma.bookmark.create({ data: { userId: me.id, postId: id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError('DUPLICATED');
      throw e;
    }
    return null;
  }

  @Delete('posts/:id/bookmarks') @Access('user')
  async unbookmark(@CurrentUser() me: Me, @Param('id') id: string) {
    await this.prisma.bookmark.deleteMany({ where: { userId: me.id, postId: id } });
    return null;
  }

  @Get('users/me/bookmarks') @Access('user')
  async myBookmarks(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.BookmarkWhereInput = { userId: me.id, post: VISIBLE };
    const [rows, total] = await Promise.all([
      this.prisma.bookmark.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { post: { include: POST_INCLUDE } } }),
      this.prisma.bookmark.count({ where }),
    ]);
    return pageResult(await this.community.items(rows.map((r) => r.post), me.id), total, p);
  }

  // ───────── 댓글 ─────────
  private async commentView(c: Prisma.CommentGetPayload<{ include: { author: { include: { profileImage: true } } } }>, meId?: string) {
    return {
      id: c.id, content: c.deletedAt ? '삭제된 댓글입니다.' : c.body, parentId: c.parentId,
      author: await this.community.userBrief(c.author), isMine: c.authorId === meId, createdAt: c.createdAt,
    };
  }

  @Get('posts/:id/comments') @Access('optional')
  async comments(@CurrentUser() me: Me | undefined, @Param('id') id: string, @Query() q: Record<string, string>) {
    await this.visible(id, me);
    const p = pageOf(q);
    const where = { postId: id, hidden: false };
    const [rows, total] = await Promise.all([
      this.prisma.comment.findMany({ where, orderBy: { createdAt: 'asc' }, skip: p.skip, take: p.take, include: { author: { include: { profileImage: true } } } }),
      this.prisma.comment.count({ where }),
    ]);
    return pageResult(await Promise.all(rows.map((c) => this.commentView(c, me?.id))), total, p);
  }

  @Post('posts/:id/comments') @HttpCode(201) @Access('user')
  async addComment(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    const post = await this.visible(id, me);
    const b = parse(z.object({ content: z.string().trim().min(1).max(500), parentId: z.string().optional() }), body);
    if (isBlocked(b.content)) throw new ApiError('CONTENT_BLOCKED');
    let parent: { authorId: string } | null = null;
    if (b.parentId) {
      const p = await this.prisma.comment.findFirst({ where: { id: b.parentId, postId: id, deletedAt: null } });
      if (!p) throw new ApiError('NOT_FOUND');
      if (p.parentId) throw new ApiError('VALIDATION_ERROR', '답글에는 답글을 달 수 없습니다.');
      parent = p;
    }
    const c = await this.prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: { postId: id, authorId: me.id, body: b.content, parentId: b.parentId }, include: { author: { include: { profileImage: true } } },
      });
      await tx.post.update({ where: { id }, data: { commentCount: { increment: 1 } } });
      return created;
    });
    const who = c.author.nickname;
    if (parent && parent.authorId !== me.id) {
      await this.notify.send(parent.authorId, { kind: 'comment', type: 'REPLY', title: `${who}님이 답글을 남겼습니다.`, body: b.content.slice(0, 50), targetType: 'POST', targetId: id });
    }
    if (post.authorId !== me.id && post.authorId !== parent?.authorId) {
      await this.notify.send(post.authorId, { kind: 'comment', type: 'COMMENT', title: `${who}님이 댓글을 남겼습니다.`, body: b.content.slice(0, 50), targetType: 'POST', targetId: id });
    }
    return this.commentView(c, me.id);
  }

  private async myComment(id: string, me: Me) {
    const c = await this.prisma.comment.findUnique({ where: { id }, include: { author: { include: { profileImage: true } } } });
    if (!c || c.deletedAt) throw new ApiError('NOT_FOUND');
    if (c.authorId !== me.id) throw new ApiError('FORBIDDEN', '작성자가 아닙니다.');
    return c;
  }

  @Patch('comments/:id') @Access('user')
  async editComment(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    await this.myComment(id, me);
    const b = parse(z.object({ content: z.string().trim().min(1).max(500) }), body);
    if (isBlocked(b.content)) throw new ApiError('CONTENT_BLOCKED');
    return this.commentView(await this.prisma.comment.update({ where: { id }, data: { body: b.content }, include: { author: { include: { profileImage: true } } } }), me.id);
  }

  @Delete('comments/:id') @Access('user')
  async deleteComment(@CurrentUser() me: Me, @Param('id') id: string) {
    const c = await this.myComment(id, me);
    await this.prisma.$transaction([
      this.prisma.comment.update({ where: { id }, data: { deletedAt: new Date() } }),
      this.prisma.post.update({ where: { id: c.postId }, data: { commentCount: { decrement: 1 } } }),
    ]);
    return null;
  }

  // ───────── 태그 ─────────
  @Get('tags/popular') @Access('none')
  async popular(@Query('limit') limit?: string) {
    const n = Math.min(30, Math.max(1, parseInt(limit ?? '10', 10) || 10));
    const g = await this.prisma.postTag.groupBy({ by: ['tagId'], where: { post: VISIBLE }, _count: { tagId: true }, orderBy: { _count: { tagId: 'desc' } }, take: n });
    const tags = await this.prisma.tag.findMany({ where: { id: { in: g.map((x) => x.tagId) } } });
    return { items: g.map((x) => ({ name: tags.find((t) => t.id === x.tagId)!.name, count: x._count.tagId })) };
  }
}
