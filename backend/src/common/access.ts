import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env, frontendOrigins } from '../config.js';
import { PrismaService } from '../prisma.service.js';
import { ApiError } from './envelope.js';
import { effectiveStatus } from './suspension.js';
import { verifyAccess } from './tokens.js';

/** none: 누구나 / optional: 로그인하면 사용자 정보 제공 / user·creator·admin: 쿠키 로그인 필요
 *  refresh·ticket: 컨트롤러가 직접 검증(CSRF 는 가드가 검사) / webhook: PG 서명을 컨트롤러가 검증 / worker: X-Worker-Key */
export type AccessLevel = 'none' | 'optional' | 'user' | 'creator' | 'admin' | 'refresh' | 'ticket' | 'webhook' | 'worker' | 'cron';
export const Access = (level: AccessLevel) => SetMetadata('access', level);

export interface Me {
  id: string;
  role: 'USER' | 'ADMIN';
  fam: string;
  creatorId?: string;
}
export type AuthedRequest = Request & { me?: Me };

/** 컨트롤러 인자에서 로그인 사용자를 꺼낸다. optional 라우트에서는 undefined 일 수 있다. */
export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().me);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const level = this.reflector.getAllAndOverride<AccessLevel>('access', [ctx.getHandler(), ctx.getClass()]) ?? 'user';

    if (level === 'worker') {
      const key = env('WORKER_API_KEY');
      const given = String(req.headers['x-worker-key'] ?? '');
      if (!key || !safeEqual(key, given)) throw new ApiError('UNAUTHORIZED', '워커 인증에 실패했습니다.');
      return true;
    }
    if (level === 'cron') {
      // Vercel Cron 은 CRON_SECRET 환경변수 값을 Authorization: Bearer 로 붙여 호출한다
      const secret = env('CRON_SECRET');
      const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!secret || !safeEqual(secret, given)) throw new ApiError('UNAUTHORIZED', '크론 인증에 실패했습니다.');
      return true;
    }
    if (level === 'webhook') return true;

    // 쿠키로 인증하는 상태 변경 요청은 CSRF 를 검사한다(none 제외).
    if (level !== 'none' && MUTATING.has(req.method)) this.checkCsrf(req);

    if (level === 'none' || level === 'refresh' || level === 'ticket') return true;

    const claims = verifyAccess(req.cookies?.accessToken);
    if (!claims) {
      if (level === 'optional') return true;
      throw new ApiError('UNAUTHORIZED', '로그인이 필요합니다.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true, role: true, status: true, suspendedUntil: true, creator: { select: { id: true, status: true } },
        // 이 기기의 세션(refresh 가족)이 폐기됐으면 액세스 토큰이 남아 있어도 거부한다
        refreshTokens: { where: { familyId: claims.fam, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true }, take: 1 },
      },
    });
    const status = user ? await effectiveStatus(this.prisma, user) : null;
    if (!user || status === 'WITHDRAWN') {
      if (level === 'optional') return true;
      throw new ApiError('UNAUTHORIZED');
    }
    if (status === 'SUSPENDED') {
      if (level === 'optional') return true;
      throw new ApiError('ACCOUNT_SUSPENDED');
    }
    // 이 기기의 세션이 폐기됐으면(로그아웃·비밀번호 변경 등) 액세스 토큰이 남아 있어도 거부
    if (user.refreshTokens.length === 0) {
      if (level === 'optional') return true;
      throw new ApiError('UNAUTHORIZED');
    }
    req.me = { id: user.id, role: user.role, fam: claims.fam, creatorId: user.creator?.status === 'ACTIVE' ? user.creator.id : undefined };

    if (level === 'creator' && !req.me.creatorId) throw new ApiError('NOT_CREATOR');
    if (level === 'admin' && user.role !== 'ADMIN') throw new ApiError('FORBIDDEN', '관리자 권한이 없습니다.');
    return true;
  }

  /** 더블 서브밋(X-CSRF-Token == csrfToken 쿠키) + Origin 검사. */
  private checkCsrf(req: Request) {
    const origin = req.headers.origin;
    if (origin && !frontendOrigins().includes(origin)) throw new ApiError('CSRF_INVALID');
    const cookie = req.cookies?.csrfToken as string | undefined;
    const header = req.headers['x-csrf-token'];
    if (!cookie || typeof header !== 'string' || !safeEqual(cookie, header)) throw new ApiError('CSRF_INVALID');
  }
}
