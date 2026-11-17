import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';

/** 사용자 설정(User.settings.notifications)의 키. system 은 설정과 무관하게 항상 보낸다. */
export type NotifyKind = 'comment' | 'like' | 'follow' | 'sale' | 'generation' | 'system';

export const DEFAULT_NOTIFICATIONS = { comment: true, like: true, follow: true, sale: true, generation: true, marketing: false };

export interface NotifyInput {
  kind: NotifyKind;
  /** 알림 종류(COMMENT, REPLY, LIKE, FOLLOW, SALE, DONATION, GENERATION_DONE, GENERATION_FAILED, REPORT_RESULT, SETTLEMENT, SYSTEM) */
  type: string;
  title: string;
  body?: string;
  targetType?: string;
  targetId?: string;
}

@Injectable()
export class NotifyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async send(userId: string, n: NotifyInput) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { settings: true, status: true } });
    if (!u || u.status !== 'ACTIVE') return;
    if (n.kind !== 'system') {
      const s = { ...DEFAULT_NOTIFICATIONS, ...((u.settings as { notifications?: object } | null)?.notifications ?? {}) };
      if (!s[n.kind]) return;
    }
    await this.prisma.notification.create({
      data: { userId, type: n.type, title: n.title, body: n.body, targetType: n.targetType, targetId: n.targetId },
    });
  }
}
