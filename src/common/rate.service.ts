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

  hit(key: string) {
    return this.prisma.rateHit.create({ data: { key } });
  }

  /** window 안에 limit 회 이상이면 RATE_LIMITED. 통과하면 1회 기록한다. */
  async consume(key: string, limit: number, windowSec: number) {
    if ((await this.count(key, windowSec)) >= limit) throw new ApiError('RATE_LIMITED');
    await this.hit(key);
  }

  clear(key: string) {
    return this.prisma.rateHit.deleteMany({ where: { key } });
  }
}
