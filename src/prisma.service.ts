import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    // 기본 5초는 DB 왕복이 느린 환경(로컬↔원격 Neon)에서 여러 쿼리가 든 트랜잭션에 모자란다.
    super({ transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
