import { Controller, Get, Inject } from '@nestjs/common';
import { Access } from './common/access.js';
import { PrismaService } from './prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 워커가 최근 30초 안에 claim/heartbeat 를 호출했으면 UP(RateHit 'worker:seen' 기록으로 판단). */
  @Get() @Access('none')
  async get() {
    const since = new Date(Date.now() - 30_000);
    const [queueLength, worker] = await Promise.all([
      this.prisma.generationJob.count({ where: { status: 'QUEUED' } }),
      this.prisma.rateHit.count({ where: { key: 'worker:seen', createdAt: { gte: since } } }),
    ]);
    return { status: 'UP', generationWorker: worker > 0 ? 'UP' : 'DOWN', queueLength };
  }
}
