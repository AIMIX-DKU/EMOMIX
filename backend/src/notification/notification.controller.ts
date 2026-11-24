import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { ApiError } from '../common/envelope.js';
import { pageOf, pageResult } from '../common/validate.js';
import { PrismaService } from '../prisma.service.js';

@Controller('notifications')
export class NotificationController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get() @Access('user')
  async list(@CurrentUser() me: Me, @Query() q: Record<string, string>) {
    const p = pageOf(q);
    const where = { userId: me.id, ...(q.unreadOnly === 'true' ? { read: false } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.notification.count({ where }),
    ]);
    return pageResult(
      rows.map((n) => ({
        id: n.id, type: n.type, title: n.title, body: n.body, targetType: n.targetType, targetId: n.targetId, isRead: n.read, createdAt: n.createdAt,
      })),
      total, p,
    );
  }

  @Get('unread-count') @Access('user')
  async unread(@CurrentUser() me: Me) {
    return { count: await this.prisma.notification.count({ where: { userId: me.id, read: false } }) };
  }

  @Post('read-all') @HttpCode(200) @Access('user')
  async readAll(@CurrentUser() me: Me) {
    await this.prisma.notification.updateMany({ where: { userId: me.id, read: false }, data: { read: true } });
    return null;
  }

  @Patch(':id/read') @Access('user')
  async read(@CurrentUser() me: Me, @Param('id') id: string) {
    const r = await this.prisma.notification.updateMany({ where: { id, userId: me.id }, data: { read: true } });
    if (r.count !== 1) throw new ApiError('NOT_FOUND');
    return null;
  }

  @Delete(':id') @Access('user')
  async remove(@CurrentUser() me: Me, @Param('id') id: string) {
    const r = await this.prisma.notification.deleteMany({ where: { id, userId: me.id } });
    if (r.count !== 1) throw new ApiError('NOT_FOUND');
    return null;
  }
}
