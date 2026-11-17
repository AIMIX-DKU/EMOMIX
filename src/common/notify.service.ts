import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';

export type NotifyKind = 'comment' | 'like' | 'follow' | 'sale' | 'generation' | 'system';

export const DEFAULT_NOTIFICATIONS = { comment: true, like: true, follow: true, sale: true, generation: true, marketing: false };

/** 사용자 설정(User.settings.notifications)을 반영해 알림을 만든다. system 은 항상 보낸다. */
@Injectable()
export class NotifyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async send(userId: string, kind: NotifyKind, title: string, body?: string, link?: string) {
    if (kind !== 'system') {
      const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { settings: true, status: true } });
      if (!u || u.status !== 'ACTIVE') return;
      const s = { ...DEFAULT_NOTIFICATIONS, ...((u.settings as { notifications?: object } | null)?.notifications ?? {}) };
      if (!s[kind]) return;
    }
    await this.prisma.notification.create({ data: { userId, type: kind, title, body, link } });
  }
}
