import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type Product, type Upload, type User, type Creator } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { PolicyService } from '../common/policy.service.js';
import { RewardService } from '../common/reward.service.js';
import { StorageService } from '../common/storage.service.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { CommunityService, type SnapshotItem } from '../community/community.service.js';
import { exportFormat } from '../emoticon/download.controller.js';
import { ExportService } from '../emoticon/export.service.js';
import { watermarkPreview } from '../emoticon/image-convert.js';
import { isBlocked } from '../generation/generation.service.js';
import { PrismaService } from '../prisma.service.js';
import { sniffImage } from '../upload/image.js';

type ProductFull = Product & { creator: Creator & { user: User & { profileImage: Upload | null } } };
const INCLUDE = { creator: { include: { user: { include: { profileImage: true } } } } } satisfies Prisma.ProductInclude;
type PreviewItem = SnapshotItem & { previewKey?: string };

const templateSchema = z.object({
  model: z.string().min(1).max(60), modelVersion: z.string().min(1).max(60), promptText: z.string().min(1).max(2000),
  variables: z.array(z.object({ key: z.string().regex(/^\w+$/), label: z.string().max(30), defaultValue: z.string().max(200) })).max(20),
  requiresReferenceImage: z.boolean(), settings: z.record(z.string(), z.unknown()), postProcess: z.string().max(500).optional(), sampleSetId: z.string().optional(),
});
const productTypes = ['EMOTICON_SET', 'PROMPT_TEMPLATE', 'RECIPE_BUNDLE'] as const;

@Controller()
export class MarketController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(RewardService) private readonly reward: RewardService,
    @Inject(CommunityService) private readonly community: CommunityService,
    @Inject(ExportService) private readonly exporter: ExportService,
  ) {}

  private async checkPrice(price: number) {
    if (price < (await this.policy.get('priceMin')) || price > (await this.policy.get('priceMax'))) throw new ApiError('PRICE_OUT_OF_RANGE');
  }

  // ───────── 등록 ─────────
  @Post('products') @HttpCode(201) @Access('creator')
  async create(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(
      z.object({
        type: z.enum(productTypes), sourceSetId: z.string(), title: z.string().trim().min(1).max(50), description: z.string().trim().min(1).max(2000),
        price: z.number().int(), licenseType: z.enum(['PERSONAL', 'COMMUNITY']), licenseNote: z.string().max(500).optional(), template: templateSchema.optional(),
      }),
      body,
    );
    await this.checkPrice(b.price);
    if (b.type !== 'EMOTICON_SET' && !b.template) throw new ApiError('VALIDATION_ERROR', '템플릿 상품은 template 이 필요합니다.');
    const set = await this.prisma.emoticonSet.findFirst({
      where: { id: b.sourceSetId, deletedAt: null }, include: { emoticons: { where: { status: 'READY' }, include: { current: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!set) throw new ApiError('NOT_FOUND');
    if (set.ownerId !== (await this.prisma.creator.findUniqueOrThrow({ where: { id: me.creatorId } })).userId) throw new ApiError('FORBIDDEN', '본인 세트가 아닙니다.');
    const ready = set.emoticons.filter((e) => e.current);
    if (!ready.length) throw new ApiError('VALIDATION_ERROR', '생성된 이모티콘이 없는 세트입니다.');
    if (b.type === 'EMOTICON_SET' && (await this.prisma.product.findFirst({ where: { setId: set.id, type: 'EMOTICON_SET', status: 'ON_SALE' } }))) {
      throw new ApiError('ALREADY_PUBLISHED');
    }
    if (isBlocked([b.title, b.description, b.licenseNote ?? '', b.template?.promptText ?? ''].join(' '))) throw new ApiError('CONTENT_BLOCKED');

    // 판매 시점의 이미지·워터마크 미리보기·규격을 고정한다
    const id = randomUUID();
    const snapshot: PreviewItem[] = [];
    let totalBytes = 0;
    let width = 0;
    let height = 0;
    for (const [i, e] of ready.entries()) {
      const bytes = await this.storage.readBytes(e.current!.imageKey);
      totalBytes += bytes.length;
      if (i === 0) {
        const d = sniffImage(bytes);
        width = d?.width ?? 0;
        height = d?.height ?? 0;
      }
      const previewKey = `previews/${id}/${i}.png`;
      await this.storage.put(previewKey, await watermarkPreview(bytes), 'image/png');
      snapshot.push({ id: randomUUID(), label: e.label, imageKey: e.current!.imageKey, previewKey });
    }
    const p = await this.prisma.product.create({
      data: {
        id, creatorId: me.creatorId!, type: b.type, setId: set.id, title: b.title, description: b.description, price: b.price,
        licenseType: b.licenseType, licenseNote: b.licenseNote, template: b.template as Prisma.InputJsonValue | undefined,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        setSpec: { emoticonCount: ready.length, width, height, formats: ['PNG', 'DISCORD'], transparent: true, totalBytes },
      },
    });
    return { id: p.id, status: p.status, createdAt: p.createdAt };
  }

  // ───────── 조회 ─────────
  private async item(p: ProductFull, agg?: { avg: number | null; count: number }) {
    const first = (p.snapshot as PreviewItem[])[0];
    return {
      id: p.id, type: p.type, title: p.title, thumbnailUrl: await this.storage.getUrl(first?.previewKey), price: p.price,
      seller: await this.community.userBrief(p.creator.user), salesCount: p.salesCount,
      ratingAvg: agg?.avg ?? null, reviewCount: agg?.count ?? 0, createdAt: p.createdAt,
    };
  }

  private async aggregates(ids: string[]) {
    const g = await this.prisma.review.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _avg: { rating: true }, _count: { productId: true } });
    return new Map(g.map((x) => [x.productId, { avg: x._avg.rating ? Math.round(x._avg.rating * 10) / 10 : null, count: x._count.productId }]));
  }

  @Get('products') @Access('optional')
  async list(@Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.ProductWhereInput = { status: 'ON_SALE' };
    if (q.type) where.type = parse(z.enum(productTypes), q.type);
    if (q.sellerId) where.creator = { userId: q.sellerId };
    if (q.keyword) {
      const k = q.keyword.trim();
      where.OR = [{ title: { contains: k, mode: 'insensitive' } }, { creator: { user: { nickname: { contains: k, mode: 'insensitive' } } } }];
    }
    if (q.tag) where.set = { posts: { some: { deletedAt: null, tags: { some: { tag: { name: q.tag } } } } } };
    const price: Prisma.IntFilter = {};
    if (q.minPrice) price.gte = parseInt(q.minPrice, 10) || 0;
    if (q.maxPrice) price.lte = parseInt(q.maxPrice, 10) || 0;
    if (price.gte !== undefined || price.lte !== undefined) where.price = price;
    const sort = q.sort ? parse(z.enum(['LATEST', 'POPULAR', 'PRICE_ASC', 'PRICE_DESC']), q.sort) : 'LATEST';
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      sort === 'POPULAR' ? [{ salesCount: 'desc' }, { createdAt: 'desc' }] : sort === 'PRICE_ASC' ? [{ price: 'asc' }] : sort === 'PRICE_DESC' ? [{ price: 'desc' }] : [{ createdAt: 'desc' }];
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, orderBy, skip: p.skip, take: p.take, include: INCLUDE }),
      this.prisma.product.count({ where }),
    ]);
    const agg = await this.aggregates(rows.map((r) => r.id));
    return pageResult(await Promise.all(rows.map((r) => this.item(r, agg.get(r.id)))), total, p);
  }

  @Get('products/:id') @Access('optional')
  async detail(@CurrentUser() me: Me | undefined, @Param('id') id: string) {
    const p = await this.prisma.product.findUnique({ where: { id }, include: INCLUDE });
    if (!p) throw new ApiError('NOT_FOUND');
    const isMine = !!me && p.creator.userId === me.id;
    const purchased = me ? !!(await this.prisma.purchase.findFirst({ where: { userId: me.id, productId: id, refundedAt: null } })) : false;
    if (p.status === 'HIDDEN' && !isMine && !purchased) throw new ApiError('NOT_FOUND');
    const agg = await this.aggregates([id]);
    const t = p.template as { model: string; modelVersion: string; variables: { key: string }[]; requiresReferenceImage: boolean } | null;
    return {
      ...(await this.item(p, agg.get(id))), description: p.description, licenseType: p.licenseType, licenseNote: p.licenseNote, status: p.status,
      previewImageUrls: await Promise.all((p.snapshot as PreviewItem[]).map((s) => this.storage.getUrl(s.previewKey))), setSpec: p.setSpec,
      templateInfo: t ? { model: t.model, modelVersion: t.modelVersion, variableKeys: t.variables.map((v) => v.key), requiresReferenceImage: t.requiresReferenceImage } : null,
      isPurchased: purchased, isMine,
    };
  }

  private async mine(me: Me, id: string) {
    const p = await this.prisma.product.findUnique({ where: { id } });
    if (!p) throw new ApiError('NOT_FOUND');
    if (p.creatorId !== me.creatorId) throw new ApiError('FORBIDDEN', '본인 상품이 아닙니다.');
    return p;
  }

  @Patch('products/:id') @Access('creator')
  async update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    await this.mine(me, id);
    const b = parse(
      z.object({ title: z.string().trim().min(1).max(50).optional(), description: z.string().trim().min(1).max(2000).optional(), price: z.number().int().optional(), licenseNote: z.string().max(500).nullable().optional() }),
      body,
    );
    if (b.price !== undefined) await this.checkPrice(b.price);
    if (isBlocked([b.title ?? '', b.description ?? '', b.licenseNote ?? ''].join(' '))) throw new ApiError('CONTENT_BLOCKED');
    await this.prisma.product.update({ where: { id }, data: b });
    return { id };
  }

  @Delete('products/:id') @Access('creator')
  async stop(@CurrentUser() me: Me, @Param('id') id: string) {
    await this.mine(me, id);
    await this.prisma.product.update({ where: { id }, data: { status: 'STOPPED' } });
    return null;
  }

  // ───────── 후기 ─────────
  @Get('products/:id/reviews') @Access('none')
  async reviews(@Param('id') id: string, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where = { productId: id, hidden: false };
    const [rows, total] = await Promise.all([
      this.prisma.review.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { author: { include: { profileImage: true } } } }),
      this.prisma.review.count({ where }),
    ]);
    return pageResult(
      await Promise.all(rows.map(async (r) => ({ id: r.id, rating: r.rating, content: r.body ?? '', author: await this.community.userBrief(r.author), createdAt: r.createdAt }))),
      total, p,
    );
  }

  @Post('products/:id/reviews') @HttpCode(201) @Access('user')
  async review(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ rating: z.number().int().min(1).max(5), content: z.string().trim().min(1).max(500) }), body);
    if (!(await this.prisma.purchase.findFirst({ where: { userId: me.id, productId: id, refundedAt: null } }))) throw new ApiError('NOT_PURCHASED');
    if (await this.prisma.review.findUnique({ where: { productId_authorId: { productId: id, authorId: me.id } } })) throw new ApiError('DUPLICATED');
    if (isBlocked(b.content)) throw new ApiError('CONTENT_BLOCKED');
    const r = await this.prisma.review.create({ data: { productId: id, authorId: me.id, rating: b.rating, body: b.content } });
    await this.reward.grant(me.id, 'REVIEW_WRITTEN', { type: 'REVIEW', id: r.id });
    return { id: r.id };
  }

  // ───────── 구매자 전용 ─────────
  private async purchased(me: Me, id: string) {
    const pu = await this.prisma.purchase.findFirst({ where: { userId: me.id, productId: id, refundedAt: null }, include: { product: true } });
    if (!pu) throw new ApiError('NOT_PURCHASED');
    if (!pu.accessedAt) await this.prisma.purchase.update({ where: { id: pu.id }, data: { accessedAt: new Date() } }); // 접근 이력은 환불 가능 여부에 쓰인다
    return pu.product;
  }

  @Get('products/:id/download') @Access('user')
  async download(@CurrentUser() me: Me, @Param('id') id: string, @Query('format') format: string) {
    const f = parse(exportFormat, format);
    const p = await this.purchased(me, id);
    if (p.type !== 'EMOTICON_SET') throw new ApiError('VALIDATION_ERROR', '이미지 상품만 내려받을 수 있습니다. 템플릿은 /template 을 사용하세요.');
    return this.exporter.zip(p.title, (p.snapshot as PreviewItem[]).map((s) => ({ label: s.label, imageKey: s.imageKey })), f);
  }

  @Get('products/:id/template') @Access('user')
  async template(@CurrentUser() me: Me, @Param('id') id: string) {
    const p = await this.purchased(me, id);
    const t = p.template as { postProcess?: string } | null;
    if (!t) throw new ApiError('VALIDATION_ERROR', '템플릿 상품이 아닙니다.');
    return { ...t, postProcess: t.postProcess ?? null };
  }

  @Get('users/me/purchases') @Access('user')
  async purchases(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where = { userId: me.id, refundedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.purchase.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { product: true, order: true } }),
      this.prisma.purchase.count({ where }),
    ]);
    return pageResult(
      await Promise.all(rows.map(async (r) => ({
        productId: r.productId, type: r.product.type, title: r.product.title,
        thumbnailUrl: await this.storage.getUrl((r.product.snapshot as PreviewItem[])[0]?.previewKey), orderNo: r.order.orderNo,
        purchasedAt: r.createdAt, licenseType: r.product.licenseType,
      }))),
      total, p,
    );
  }
}
