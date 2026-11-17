import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { clearSessionCookies } from '../common/cookies.js';
import { ApiError } from '../common/envelope.js';
import { DEFAULT_NOTIFICATIONS, NotifyService } from '../common/notify.service.js';
import { StorageService } from '../common/storage.service.js';
import { parse, z } from '../common/validate.js';
import { PrismaService } from '../prisma.service.js';
import { loadMe } from './me.js';

const notiSchema = z.object({
  comment: z.boolean(), like: z.boolean(), follow: z.boolean(), sale: z.boolean(), generation: z.boolean(), marketing: z.boolean(),
});

@Controller()
export class UsersController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  @Get('users/me') @Access('user')
  me(@CurrentUser() me: Me) {
    return loadMe(this.prisma, this.storage, me.id);
  }

  @Patch('users/me') @Access('user')
  async update(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(
      z.object({
        nickname: z.string().trim().min(2).max(16).optional(),
        bio: z.string().max(200).nullable().optional(),
        profileImageUploadId: z.string().nullable().optional(),
      }),
      body,
    );
    const data: Prisma.UserUpdateInput = {};
    if (b.nickname !== undefined) data.nickname = b.nickname;
    if (b.bio !== undefined) data.bio = b.bio;
    if (b.profileImageUploadId !== undefined) {
      if (b.profileImageUploadId === null) data.profileImage = { disconnect: true };
      else {
        const up = await this.prisma.upload.findUnique({ where: { id: b.profileImageUploadId } });
        if (!up || up.ownerId !== me.id || up.purpose !== 'PROFILE' || up.status !== 'CONFIRMED') {
          throw new ApiError('VALIDATION_ERROR', '사용할 수 없는 프로필 이미지입니다.');
        }
        data.profileImage = { connect: { id: up.id } };
        await this.prisma.upload.update({ where: { id: up.id }, data: { linked: true } });
      }
    }
    try {
      await this.prisma.user.update({ where: { id: me.id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError('DUPLICATED_NICKNAME');
      throw e;
    }
    return loadMe(this.prisma, this.storage, me.id);
  }

  /** 소프트 삭제: 개인정보는 즉시 비식별화하고 거래·결제 기록은 남긴다. */
  @Delete('users/me') @Access('user')
  async withdraw(@CurrentUser() me: Me, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    parse(z.object({ confirmText: z.literal('탈퇴') }), body);
    if (me.creatorId) {
      const last = await this.prisma.sellerLedger.findFirst({ where: { creatorId: me.creatorId }, orderBy: { createdAt: 'desc' } });
      const pending = await this.prisma.settlement.count({ where: { creatorId: me.creatorId, status: { in: ['REQUESTED', 'APPROVED'] } } });
      if ((last?.balanceAfter ?? 0) > 0 || pending > 0) throw new ApiError('HAS_PENDING_SETTLEMENT');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: me.id },
        data: {
          status: 'WITHDRAWN', deletedAt: new Date(), email: null, passwordHash: null, bio: null,
          nickname: `탈퇴한사용자-${me.id.slice(0, 8)}`, profileImage: { disconnect: true }, settings: {},
        },
      }),
      this.prisma.identity.deleteMany({ where: { userId: me.id } }),
      this.prisma.refreshToken.updateMany({ where: { userId: me.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.notification.deleteMany({ where: { userId: me.id } }),
      this.prisma.follow.deleteMany({ where: { OR: [{ followerId: me.id }, { followeeId: me.id }] } }),
    ]);
    clearSessionCookies(res);
    return null;
  }

  @Get('users/me/settings') @Access('user')
  async settings(@CurrentUser() me: Me) {
    return { notifications: await this.notificationSettings(me.id) };
  }

  @Patch('users/me/settings') @Access('user')
  async updateSettings(@CurrentUser() me: Me, @Body() body: unknown) {
    const b = parse(z.object({ notifications: notiSchema.partial().optional() }), body);
    const merged = { ...(await this.notificationSettings(me.id)), ...(b.notifications ?? {}) };
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    await this.prisma.user.update({ where: { id: me.id }, data: { settings: { ...(u.settings as object), notifications: merged } } });
    return { notifications: merged };
  }

  private async notificationSettings(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { settings: true } });
    return { ...DEFAULT_NOTIFICATIONS, ...((u.settings as { notifications?: object }).notifications ?? {}) };
  }

  @Get('users/:userId') @Access('optional')
  async profile(@CurrentUser() me: Me | undefined, @Param('userId') userId: string) {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE' },
      include: {
        profileImage: true, creator: { select: { status: true } },
        _count: { select: { followers: true, following: true, posts: { where: { deletedAt: null, hidden: false } } } },
      },
    });
    if (!u) throw new ApiError('NOT_FOUND');
    const isFollowing = me ? !!(await this.prisma.follow.findUnique({ where: { followerId_followeeId: { followerId: me.id, followeeId: u.id } } })) : false;
    return {
      id: u.id, nickname: u.nickname, profileImageUrl: await this.storage.getUrl(u.profileImage?.storageKey), bio: u.bio,
      isCreator: u.creator?.status === 'ACTIVE', followerCount: u._count.followers, followingCount: u._count.following,
      postCount: u._count.posts, isFollowing,
    };
  }

  @Post('users/:userId/follow') @HttpCode(201) @Access('user')
  async follow(@CurrentUser() me: Me, @Param('userId') userId: string) {
    if (userId === me.id) throw new ApiError('SELF_ACTION');
    if (!(await this.prisma.user.findFirst({ where: { id: userId, status: 'ACTIVE' } }))) throw new ApiError('NOT_FOUND');
    try {
      await this.prisma.follow.create({ data: { followerId: me.id, followeeId: userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError('DUPLICATED');
      throw e;
    }
    const who = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { nickname: true } });
    await this.notify.send(userId, 'follow', `${who.nickname}님이 회원님을 팔로우했습니다.`, undefined, `/users/${me.id}`);
    return null;
  }

  @Delete('users/:userId/follow') @Access('user')
  async unfollow(@CurrentUser() me: Me, @Param('userId') userId: string) {
    await this.prisma.follow.deleteMany({ where: { followerId: me.id, followeeId: userId } });
    return null;
  }
}
