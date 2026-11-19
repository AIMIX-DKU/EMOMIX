import { z } from 'zod';
import { ApiError } from './envelope.js';

export { z };

/** zod 스키마로 검증하고, 실패하면 VALIDATION_ERROR(첫 번째 문제를 메시지로). */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ApiError('VALIDATION_ERROR', `요청 값이 올바르지 않습니다. (${i.path.join('.') || 'body'}: ${i.message})`);
  }
  return r.data;
}

/** 페이지 쿼리(page 0부터, size 기본 20 최대 50). */
export function pageOf(q: Record<string, unknown>) {
  const page = Math.max(0, parseInt(String(q.page ?? '0'), 10) || 0);
  const size = Math.min(50, Math.max(1, parseInt(String(q.size ?? '20'), 10) || 20));
  return { page, size, skip: page * size, take: size };
}

/** 목록 응답 래퍼. */
export function pageResult<T>(items: T[], total: number, p: { page: number; size: number }) {
  return { items, page: p.page, size: p.size, totalElements: total, totalPages: Math.ceil(total / p.size) };
}
