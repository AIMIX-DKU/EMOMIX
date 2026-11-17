import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma.service.js';
import { ApiError } from './envelope.js';

/** 돈·크레딧이 걸린 POST 의 중복 요청 방지. 같은 (사용자, 키)로 같은 요청이면 최초 결과를 그대로 돌려준다. */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async run<T>(userId: string, key: string | undefined, request: unknown, fn: () => Promise<T>): Promise<T> {
    if (!key || key.length < 8 || key.length > 100) throw new ApiError('VALIDATION_ERROR', 'Idempotency-Key 헤더가 필요합니다.');
    const requestHash = createHash('sha256').update(JSON.stringify(request ?? null)).digest('hex');
    try {
      await this.prisma.idempotencyRecord.create({ data: { userId, key, requestHash } });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      const rec = await this.prisma.idempotencyRecord.findUniqueOrThrow({ where: { userId_key: { userId, key } } });
      if (rec.requestHash !== requestHash) throw new ApiError('IDEMPOTENCY_CONFLICT');
      if (rec.response === null) {
        // 함수가 중간에 끊겨(타임아웃·크래시) 영원히 '처리 중'으로 남은 기록은 60초 뒤 재시도를 허용한다
        if (Date.now() - rec.createdAt.getTime() > 60_000) {
          await this.prisma.idempotencyRecord.deleteMany({ where: { userId, key, response: { equals: Prisma.DbNull } } });
          return this.run(userId, key, request, fn);
        }
        throw new ApiError('IDEMPOTENCY_CONFLICT'); // 같은 요청이 아직 처리 중
      }
      return rec.response as T;
    }
    try {
      const out = await fn();
      await this.prisma.idempotencyRecord.update({ where: { userId_key: { userId, key } }, data: { response: (out ?? {}) as Prisma.InputJsonValue } });
      return out;
    } catch (e) {
      // 실패한 요청은 같은 키로 다시 시도할 수 있게 기록을 지운다
      await this.prisma.idempotencyRecord.delete({ where: { userId_key: { userId, key } } }).catch(() => undefined);
      throw e;
    }
  }
}
