import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';

/** 운영 정책 기본값. DB(Policy)에 같은 key 가 있으면 그 값이 우선한다. */
export const POLICY_DEFAULTS = {
  signupGrantCredits: 20, // 가입 체험 크레딧
  emoticonCreditCost: 1, // 이모티콘 1장 생성 비용
  candidateCreditCost: 1, // 캐릭터 후보 생성 비용
  dailyGenerationLimit: 50, // 사용자 일일 생성 한도(이미지 수)
  maxQueueLength: 30, // 대기열 상한
  priceMin: 500, // 상품 최소 가격(원)
  priceMax: 50000, // 상품 최대 가격(원)
  sellerFeeRate: 0.2, // 판매 수수료율
  pointToCreditRate: 0.1, // 활동 포인트 1점당 크레딧
  monthlyPointEarnCap: 1000,
  monthlyPointExchangeCap: 500, // 월 교환 가능 포인트
  minSettlementAmount: 10000, // 최소 정산 요청 금액(원)
  donationMin: 1000,
  donationMax: 100000,
  maxFileBytes: 10 * 1024 * 1024,
} as const;
export type PolicyKey = keyof typeof POLICY_DEFAULTS;

@Injectable()
export class PolicyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async get<K extends PolicyKey>(key: K): Promise<number> {
    const row = await this.prisma.policy.findUnique({ where: { key } });
    return (row ? row.value : POLICY_DEFAULTS[key]) as number;
  }

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.policy.findMany();
    return { ...POLICY_DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }
}
