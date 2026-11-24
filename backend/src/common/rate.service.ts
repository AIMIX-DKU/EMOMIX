import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { ApiError } from './envelope.js';

/** DB 기반 간단한 요청 제한. 서버리스라 메모리를 공유할 수 없어 DB에 기록한다. */
@Injectable()
export class RateService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  count(key: string, windowSec: number) {
    return this.prisma.rateHit.count({ where: { key, createdAt: { gte: new Date(Date.now() - windowSec * 1000) } } });
  }

  async hit(key: string) {
    // 크론이 없으므로 가끔(약 1%) 오래된 기록을 지운다
    if (Math.random() < 0.01) void this.prisma.rateHit.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 2 * 24 * 3600 * 1000) } } }).catch(() => undefined);
    return this.prisma.rateHit.create({ data: { key } });
  }

  /** 먼저 1회 기록한 뒤 window 안의 횟수가 limit 을 넘으면 RATE_LIMITED(병렬 요청도 한 번씩 센다). */
  async consume(key: string, limit: number, windowSec: number) {
    await this.hit(key);
    if ((await this.count(key, windowSec)) > limit) throw new ApiError('RATE_LIMITED');
  }

  clear(key: string) {
    return this.prisma.rateHit.deleteMany({ where: { key } });
  }
}
