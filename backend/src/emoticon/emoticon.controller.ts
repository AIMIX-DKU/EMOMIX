import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Emoticon, EmoticonSet, EmoticonVersion, Prisma } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { StorageService } from '../common/storage.service.js';
import { parse, pageOf, pageResult, z } from '../common/validate.js';
import { isPublishedSet } from '../character/character.controller.js';
import { sniffImage } from '../upload/image.js';
import { GenerationService } from '../generation/generation.service.js';
import { PrismaService } from '../prisma.service.js';

type EmoticonFull = Emoticon & { current: EmoticonVersion | null };
type SetFull = EmoticonSet & { emoticons: EmoticonFull[] };

/** 템플릿 문구의 {변수} 를 채운다. 변수 값에서 중괄호는 제거한다(재귀 치환 방지). */
export function renderTemplate(tpl: string, vars: Record<string, unknown> = {}) {
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? '').replace(/[{}]/g, '').slice(0, 200));
}

@Controller()
export class EmoticonController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(GenerationService) private readonly gen: GenerationService,
  ) {}

  // ───────── 뷰 ─────────
  async emoticonView(e: EmoticonFull) {
    const key = e.current?.imageKey;
    return {
      id: e.id, setId: e.setId, label: e.label, imageUrl: await this.storage.getUrl(key), thumbnailUrl: await this.storage.getUrl(e.current?.thumbKey ?? key),
      status: e.status, version: e.current?.version ?? 0, createdAt: e.createdAt,
    };
  }

  private async setView(s: SetFull) {
    const ready = s.emoticons.filter((e) => e.status === 'READY');
    const published = await isPublishedSet(s.id, this.prisma);
    const status = published ? 'PUBLISHED' : ready.length > 0 && !s.emoticons.some((e) => e.status === 'GENERATING') ? 'READY' : 'DRAFT';
    const cover = ready[0]?.current;
    return {
      id: s.id, characterId: s.characterId, title: s.title, description: s.description, status, emoticonCount: s.emoticons.length,
      coverUrl: await this.storage.getUrl(cover?.thumbKey ?? cover?.imageKey), createdAt: s.createdAt, updatedAt: s.updatedAt,
    };
  }

  private async ownSet(me: Me, id: string) {
    const s = await this.prisma.emoticonSet.findFirst({
      where: { id, deletedAt: null },
      include: { emoticons: { include: { current: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!s || s.ownerId !== me.id) throw new ApiError('NOT_FOUND');
    return s;
  }

  private async ownEmoticon(me: Me, id: string) {
    const e = await this.prisma.emoticon.findUnique({ where: { id }, include: { current: true, set: true } });
    if (!e || e.set.deletedAt || e.set.ownerId !== me.id) throw new ApiError('NOT_FOUND');
    return e;
  }

  // ───────── 세트 ─────────
  @Post('sets') @HttpCode(201) @Access('user')
  async createSet(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(z.object({ characterId: z.string(), title: z.string().trim().min(1).max(50), description: z.string().max(500).optional() }), body);
    const c = await this.prisma.character.findFirst({ where: { id: b.characterId, deletedAt: null } });
    if (!c || c.ownerId !== me.id) throw new ApiError('NOT_FOUND');
    if (c.status !== 'CONFIRMED') throw new ApiError('CHARACTER_NOT_CONFIRMED');
    const s = await this.prisma.emoticonSet.create({
      data: { ownerId: me.id, characterId: c.id, title: b.title, description: b.description },
      include: { emoticons: { include: { current: true } } },
    });
    return this.setView(s);
  }

  @Get('sets') @Access('user')
  async listSets(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where: Prisma.EmoticonSetWhereInput = { ownerId: me.id, deletedAt: null, ...(q.characterId ? { characterId: q.characterId } : {}) };
    const rows = await this.prisma.emoticonSet.findMany({
      where, orderBy: { createdAt: 'desc' }, include: { emoticons: { include: { current: true }, orderBy: { createdAt: 'asc' } } },
    });
    // 상태(DRAFT/READY/PUBLISHED)는 계산 값이라 조회 후 필터링한다
    let views = await Promise.all(rows.map((s) => this.setView(s)));
    if (q.status) {
      const st = parse(z.enum(['DRAFT', 'READY', 'PUBLISHED']), q.status);
      views = views.filter((v) => v.status === st);
    }
    return pageResult(views.slice(p.skip, p.skip + p.take), views.length, p);
  }

  @Get('sets/:id') @Access('user')
  async getSet(@CurrentUser() me: Me, @Param('id') id: string) {
    const s = await this.ownSet(me, id);
    return { ...(await this.setView(s)), emoticons: await Promise.all(s.emoticons.map((e) => this.emoticonView(e))) };
  }

  @Patch('sets/:id') @Access('user')
  async updateSet(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    await this.ownSet(me, id);
    const b = parse(z.object({ title: z.string().trim().min(1).max(50).optional(), description: z.string().max(500).nullable().optional() }), body);
    const s = await this.prisma.emoticonSet.update({ where: { id }, data: b, include: { emoticons: { include: { current: true } } } });
    return this.setView(s);
  }

  @Delete('sets/:id') @Access('user')
  async deleteSet(@CurrentUser() me: Me, @Param('id') id: string) {
    await this.ownSet(me, id);
    if (await isPublishedSet(id, this.prisma)) throw new ApiError('SET_PUBLISHED');
    await this.prisma.emoticonSet.update({ where: { id }, data: { deletedAt: new Date() } });
    return null;
  }

  // ───────── 감정 생성 ─────────
  @Post('sets/:id/generations') @HttpCode(202) @Access('user')
  async generate(@CurrentUser() me: Me, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const set = await this.ownSet(me, id);
    const b = parse(
      z.object({
        emotions: z.array(z.object({ key: z.string().trim().min(1).max(30), customPrompt: z.string().max(300).optional() })).min(1).max(16),
        templateProductId: z.string().optional(),
        variables: z.record(z.string(), z.unknown()).optional(),
      }),
      body,
    );
    const ch = set.characterId ? await this.prisma.character.findFirst({ where: { id: set.characterId, deletedAt: null } }) : null;
    if (!ch || ch.status !== 'CONFIRMED' || !ch.baseImageKey) throw new ApiError('CHARACTER_NOT_CONFIRMED');

    let template = '';
    if (b.templateProductId) {
      const p = await this.prisma.product.findUnique({ where: { id: b.templateProductId } });
      const owned = p && (await this.prisma.purchase.findFirst({ where: { userId: me.id, productId: p.id, refundedAt: null } }));
      if (!p || !owned || p.type === 'EMOTICON_SET') throw new ApiError('NOT_PURCHASED');
      if (!owned.accessedAt) await this.prisma.purchase.update({ where: { id: owned.id }, data: { accessedAt: new Date() } }); // 사용 이력은 환불 가능 여부에 쓰인다
      const t = p.template as { promptText?: string; variables?: { key: string; defaultValue: string }[] } | null;
      const defaults = Object.fromEntries((t?.variables ?? []).map((v) => [v.key, v.defaultValue]));
      template = renderTemplate(String(t?.promptText ?? ''), { ...defaults, ...(b.variables ?? {}) });
    }
    const presets = await this.prisma.emotionPreset.findMany({ where: { key: { in: b.emotions.map((e) => e.key) } } });
    const style = await this.prisma.stylePreset.findFirst({ where: { key: ch.stylePresetKey ?? '' } });
    const base = [style?.promptHint, ch.appearanceDescription ?? ch.description].filter(Boolean).join('. ');
    const items = b.emotions.map((e) => ({
      emoticonId: randomUUID(), label: e.key,
      prompt: [presets.find((p) => p.key === e.key)?.promptHint ?? e.key, e.customPrompt, template].filter(Boolean).join('. '),
    }));
    return this.gen.create({
      userId: me.id, idempotencyKey: key, type: 'EMOTION_SET', targetType: 'SET', targetId: set.id,
      cost: await this.gen.costOf('EMOTION_SET', items.length), count: items.length,
      work: { prompt: base, inputImageKeys: [ch.baseImageKey], items, count: items.length, setId: set.id, characterId: ch.id },
      fingerprint: [b.emotions, b.templateProductId ?? '', b.variables ?? {}],
      prepare: async (tx) => {
        await tx.emoticon.createMany({ data: items.map((i) => ({ id: i.emoticonId, setId: set.id, label: i.label, status: 'GENERATING' as const })) });
      },
    });
  }

  // ───────── 이모티콘 ─────────
  @Get('emoticons/:id') @Access('user')
  async getEmoticon(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.emoticonView(await this.ownEmoticon(me, id));
  }

  @Patch('emoticons/:id') @Access('user')
  async rename(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    await this.ownEmoticon(me, id);
    const b = parse(z.object({ label: z.string().trim().min(1).max(30) }), body);
    return this.emoticonView(await this.prisma.emoticon.update({ where: { id }, data: b, include: { current: true } }));
  }

  @Delete('emoticons/:id') @Access('user')
  async remove(@CurrentUser() me: Me, @Param('id') id: string) {
    const e = await this.ownEmoticon(me, id);
    if (await isPublishedSet(e.setId, this.prisma)) throw new ApiError('SET_PUBLISHED');
    await this.prisma.$transaction([
      this.prisma.emoticon.update({ where: { id }, data: { currentVersionId: null } }),
      this.prisma.emoticon.delete({ where: { id } }),
    ]);
    return null;
  }

  private async singleWork(me: Me, e: EmoticonFull & { set: EmoticonSet }, prompt: string) {
    const ch = e.set.characterId ? await this.prisma.character.findUnique({ where: { id: e.set.characterId } }) : null;
    const style = await this.prisma.stylePreset.findFirst({ where: { key: ch?.stylePresetKey ?? '' } });
    const base = [style?.promptHint, ch?.appearanceDescription ?? ch?.description].filter(Boolean).join('. ');
    return { base, ch, items: [{ emoticonId: e.id, label: e.label, prompt }] };
  }

  @Post('emoticons/:id/regenerations') @HttpCode(202) @Access('user')
  async regenerate(@CurrentUser() me: Me, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const e = await this.ownEmoticon(me, id);
    if (!e.current) throw new ApiError('VALIDATION_ERROR', '아직 생성이 끝나지 않은 이모티콘입니다.');
    const b = parse(z.object({ prompt: z.string().max(300).optional() }), body);
    const w = await this.singleWork(me, e, [e.label, b.prompt].filter(Boolean).join('. '));
    return this.gen.create({
      userId: me.id, idempotencyKey: key, type: 'EMOTION_REGENERATE', targetType: 'EMOTICON', targetId: e.id,
      cost: await this.gen.costOf('EMOTION_REGENERATE', 1), count: 1,
      work: { prompt: w.base, inputImageKeys: [w.ch?.baseImageKey, e.current.imageKey].filter(Boolean) as string[], items: w.items, count: 1 },
      fingerprint: [b.prompt ?? ''],
    });
  }

  @Post('emoticons/:id/inpaints') @HttpCode(202) @Access('user')
  async inpaint(@CurrentUser() me: Me, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const e = await this.ownEmoticon(me, id);
    if (!e.current) throw new ApiError('VALIDATION_ERROR', '아직 생성이 끝나지 않은 이모티콘입니다.');
    const b = parse(z.object({ maskUploadId: z.string(), prompt: z.string().trim().min(1).max(300) }), body);
    const mask = await this.prisma.upload.findUnique({ where: { id: b.maskUploadId } });
    if (!mask || mask.ownerId !== me.id || mask.purpose !== 'MASK' || mask.status !== 'CONFIRMED') {
      throw new ApiError('VALIDATION_ERROR', '사용할 수 없는 마스크 이미지입니다.');
    }
    const dims = sniffImage(await this.storage.readBytes(e.current.imageKey));
    if (!dims || dims.width !== mask.width || dims.height !== mask.height) throw new ApiError('VALIDATION_ERROR', '마스크 크기가 원본과 다릅니다.');
    await this.prisma.upload.update({ where: { id: mask.id }, data: { linked: true } });
    const w = await this.singleWork(me, e, b.prompt);
    return this.gen.create({
      userId: me.id, idempotencyKey: key, type: 'INPAINT', targetType: 'EMOTICON', targetId: e.id,
      cost: await this.gen.costOf('INPAINT', 1), count: 1,
      work: { prompt: `${w.base}. ${b.prompt}`, inputImageKeys: [e.current.imageKey], maskKey: mask.storageKey, originalKey: e.current.imageKey, items: w.items, count: 1 },
      fingerprint: [b.maskUploadId, b.prompt],
    });
  }

  // ───────── 버전 ─────────
  @Get('emoticons/:id/versions') @Access('user')
  async versions(@CurrentUser() me: Me, @Param('id') id: string) {
    const e = await this.ownEmoticon(me, id);
    const rows = await this.prisma.emoticonVersion.findMany({ where: { emoticonId: id }, orderBy: { version: 'desc' } });
    return {
      items: await Promise.all(rows.map(async (v) => ({
        versionId: v.id, version: v.version, imageUrl: await this.storage.getUrl(v.imageKey), source: v.source,
        isCurrent: v.id === e.currentVersionId, createdAt: v.createdAt,
      }))),
    };
  }

  @Put('emoticons/:id/versions/:versionId/current') @Access('user')
  async selectVersion(@CurrentUser() me: Me, @Param('id') id: string, @Param('versionId') versionId: string) {
    await this.ownEmoticon(me, id);
    const v = await this.prisma.emoticonVersion.findFirst({ where: { id: versionId, emoticonId: id } });
    if (!v) throw new ApiError('NOT_FOUND');
    return this.emoticonView(await this.prisma.emoticon.update({ where: { id }, data: { currentVersionId: v.id }, include: { current: true } }));
  }
}
