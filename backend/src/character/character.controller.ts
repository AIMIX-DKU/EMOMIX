import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Character } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { StorageService } from '../common/storage.service.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { GenerationService, newSeed, seedFields } from '../generation/generation.service.js';
import { PrismaService } from '../prisma.service.js';

export const isPublishedSet = (setId: string, prisma: PrismaService) =>
  Promise.all([
    prisma.post.count({ where: { setId, deletedAt: null } }),
    prisma.product.count({ where: { setId, status: 'ON_SALE' } }),
  ]).then(([a, b]) => a + b > 0);

@Controller()
export class CharacterController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(GenerationService) private readonly gen: GenerationService,
  ) {}

  // ───────── 프리셋 ─────────
  @Get('style-presets') @Access('none')
  async styles() {
    const rows = await this.prisma.stylePreset.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
    return { items: rows.map((r) => ({ key: r.key, label: r.name, previewUrl: r.sampleUrl })) };
  }

  @Get('emotion-presets') @Access('none')
  async emotions(@Query('category') category?: string) {
    const cat = category ? parse(z.enum(['EMOTION', 'SITUATION']), category) : undefined;
    const rows = await this.prisma.emotionPreset.findMany({ where: { active: true, ...(cat ? { category: cat } : {}) }, orderBy: { sortOrder: 'asc' } });
    return { items: rows.map((r) => ({ key: r.key, label: r.name, category: r.category, exampleUrl: r.exampleUrl })) };
  }

  // ───────── 캐릭터 ─────────
  private async view(c: Character) {
    return {
      id: c.id, name: c.name, description: c.description ?? '', stylePreset: c.stylePresetKey, status: c.status,
      baseImageUrl: await this.storage.getUrl(c.baseImageKey), appearanceDescription: c.appearanceDescription, createdAt: c.createdAt,
    };
  }

  private async own(me: Me, id: string) {
    const c = await this.prisma.character.findFirst({ where: { id, deletedAt: null } });
    if (!c || c.ownerId !== me.id) throw new ApiError('NOT_FOUND');
    return c;
  }

  @Post('characters') @HttpCode(201) @Access('user')
  async create(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(30), description: z.string().trim().min(1).max(500), stylePreset: z.string(),
        referenceUploadIds: z.array(z.string()).max(3).optional(),
      }),
      body,
    );
    if (!(await this.prisma.stylePreset.findFirst({ where: { key: b.stylePreset, active: true } }))) {
      throw new ApiError('VALIDATION_ERROR', '알 수 없는 그림체입니다.');
    }
    const ids = b.referenceUploadIds ?? [];
    const ups = await this.prisma.upload.findMany({ where: { id: { in: ids }, ownerId: me.id, purpose: 'REFERENCE', status: 'CONFIRMED' } });
    if (ups.length !== ids.length) throw new ApiError('VALIDATION_ERROR', '사용할 수 없는 참고 이미지입니다.');
    const c = await this.prisma.$transaction(async (tx) => {
      await tx.upload.updateMany({ where: { id: { in: ids } }, data: { linked: true } });
      return tx.character.create({
        data: { ownerId: me.id, name: b.name, description: b.description, prompt: b.description, stylePresetKey: b.stylePreset, referenceUploadIds: ids },
      });
    });
    return this.view(c);
  }

  @Get('characters') @Access('user')
  async list(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where = { ownerId: me.id, deletedAt: null, ...(q.status ? { status: parse(z.enum(['DRAFT', 'CONFIRMED']), q.status) } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.character.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.character.count({ where }),
    ]);
    return pageResult(await Promise.all(rows.map((c) => this.view(c))), total, p);
  }

  @Get('characters/:id') @Access('user')
  async detail(@CurrentUser() me: Me, @Param('id') id: string) {
    const c = await this.own(me, id);
    const ups = await this.prisma.upload.findMany({ where: { id: { in: c.referenceUploadIds } } });
    return {
      ...(await this.view(c)),
      referenceImages: await Promise.all(ups.map(async (u) => ({ uploadId: u.id, url: await this.storage.getUrl(u.storageKey) }))),
      setCount: await this.prisma.emoticonSet.count({ where: { characterId: c.id, deletedAt: null } }),
    };
  }

  @Patch('characters/:id') @Access('user')
  async update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    const c = await this.own(me, id);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(30).optional(), description: z.string().trim().min(1).max(500).optional(),
        appearanceDescription: z.string().trim().min(1).max(500).optional(),
      }),
      body,
    );
    if (b.appearanceDescription !== undefined && c.status !== 'CONFIRMED') {
      throw new ApiError('VALIDATION_ERROR', '확정된 캐릭터만 외형 설명을 직접 수정할 수 있습니다.');
    }
    return this.view(await this.prisma.character.update({ where: { id }, data: b }));
  }

  @Delete('characters/:id') @Access('user')
  async remove(@CurrentUser() me: Me, @Param('id') id: string) {
    const c = await this.own(me, id);
    const sets = await this.prisma.emoticonSet.findMany({ where: { characterId: c.id, deletedAt: null }, select: { id: true } });
    for (const s of sets) if (await isPublishedSet(s.id, this.prisma)) throw new ApiError('CHARACTER_IN_USE');
    await this.prisma.character.update({ where: { id }, data: { deletedAt: new Date() } });
    return null;
  }

  // ───────── 후보 생성·확정 ─────────
  @Post('characters/:id/candidates') @HttpCode(202) @Access('user')
  async candidates(@CurrentUser() me: Me, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const c = await this.own(me, id);
    const b = parse(z.object({ count: z.number().int().min(1).max(4).optional(), extraPrompt: z.string().max(300).optional(), ...seedFields }), body);
    const count = b.count ?? 4;
    const style = await this.prisma.stylePreset.findFirst({ where: { key: c.stylePresetKey ?? '' } });
    const refs = await this.prisma.upload.findMany({ where: { id: { in: c.referenceUploadIds } } });
    const prompt = [style?.promptHint, c.description, b.extraPrompt].filter(Boolean).join('. ');
    return this.gen.create({
      userId: me.id, idempotencyKey: key, type: 'CHARACTER_CANDIDATES', targetType: 'CHARACTER', targetId: c.id,
      cost: await this.gen.costOf('CHARACTER_CANDIDATES', count), count,
      work: { prompt, inputImageKeys: refs.map((r) => r.storageKey), count, characterId: c.id, seed: b.seed ?? newSeed(), negativePrompt: b.negativePrompt || undefined },
      fingerprint: [count, b.extraPrompt ?? '', b.seed ?? null, b.negativePrompt ?? ''],
    });
  }

  @Get('characters/:id/candidates') @Access('user')
  async candidateList(@CurrentUser() me: Me, @Param('id') id: string) {
    await this.own(me, id);
    const rows = await this.prisma.characterCandidate.findMany({ where: { characterId: id }, orderBy: { createdAt: 'desc' } });
    return { items: await Promise.all(rows.map(async (r) => ({ imageId: r.id, imageUrl: await this.storage.getUrl(r.imageKey), createdAt: r.createdAt }))) };
  }

  @Post('characters/:id/confirm') @HttpCode(200) @Access('user')
  async confirm(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    const c = await this.own(me, id);
    const b = parse(z.object({ candidateImageId: z.string(), appearanceDescription: z.string().trim().min(1).max(500).optional() }), body);
    const cand = await this.prisma.characterCandidate.findFirst({ where: { id: b.candidateImageId, characterId: c.id } });
    if (!cand) throw new ApiError('VALIDATION_ERROR', '선택한 후보 이미지를 찾을 수 없습니다.');
    const up = await this.prisma.character.update({
      where: { id },
      data: { status: 'CONFIRMED', baseImageKey: cand.imageKey, appearanceDescription: b.appearanceDescription ?? c.description },
    });
    return this.view(up);
  }
}
