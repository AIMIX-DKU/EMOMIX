import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { env, frontendOrigins } from '../config.js';
import { PrismaService } from '../prisma.service.js';
import { StorageService } from '../common/storage.service.js';
import { PolicyService } from '../common/policy.service.js';
import { MailService } from '../common/mail.service.js';
import { RateService } from '../common/rate.service.js';
import { ApiError } from '../common/envelope.js';
import { creditChange } from '../common/wallet.js';
import { effectiveStatus } from '../common/suspension.js';
import { loadMe } from '../users/me.js';
import { randomToken, sha256, signAccess, signTicket, verifyAccess, verifyTicket, type DiscordTicket } from '../common/tokens.js';
import {
  clearSessionCookies, clearTicketCookie, setAccessCookie, setCsrfCookie, setRefreshCookie, setTicketCookie,
} from '../common/cookies.js';

const CODE_TTL = 300;
const RESEND_AFTER = 60;
const TOKEN_TTL = 600;
const REFRESH_TTL_MS = 14 * 24 * 3600 * 1000;
export const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
// 이메일 계정이 없는 경우에도 같은 시간이 걸리도록 비교할 더미 해시
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

export type Purpose = 'SIGNUP' | 'PASSWORD_RESET';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(RateService) private readonly rate: RateService,
  ) {}

  // ───────── 이메일 인증번호 ─────────
  async sendCode(emailRaw: string, purpose: Purpose) {
    const email = emailRaw.toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (purpose === 'SIGNUP' && exists) throw new ApiError('DUPLICATED_EMAIL');

    const last = await this.prisma.emailVerification.findFirst({ where: { email, purpose }, orderBy: { createdAt: 'desc' } });
    if (last && Date.now() - last.createdAt.getTime() < RESEND_AFTER * 1000) throw new ApiError('RATE_LIMITED');
    await this.rate.consume(`mail:${email}`, 10, 24 * 3600);

    const ok = purpose === 'SIGNUP' || !!exists; // 재설정은 계정이 없어도 같은 응답(존재 여부 노출 방지)
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.emailVerification.create({
      data: { email, purpose, codeHash: sha256(`${email}:${code}`), expiresAt: new Date(Date.now() + CODE_TTL * 1000) },
    });
    if (ok) {
      await this.mail.send(email, '[EmoMix] 이메일 인증번호', `인증번호: ${code}\n${CODE_TTL / 60}분 안에 입력해주세요.`);
    }
    return { expiresInSeconds: CODE_TTL, resendAfterSeconds: RESEND_AFTER };
  }

  async verifyCode(emailRaw: string, code: string, purpose: Purpose) {
    const email = emailRaw.toLowerCase();
    const row = await this.prisma.emailVerification.findFirst({
      where: { email, purpose, verifiedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || row.attempts >= 5) throw new ApiError('INVALID_VERIFICATION_CODE');
    if (row.codeHash !== sha256(`${email}:${code}`)) {
      await this.prisma.emailVerification.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw new ApiError('INVALID_VERIFICATION_CODE');
    }
    const token = randomToken(32);
    await this.prisma.emailVerification.update({
      where: { id: row.id },
      data: { verifiedAt: new Date(), tokenHash: sha256(token), tokenExpiresAt: new Date(Date.now() + TOKEN_TTL * 1000) },
    });
    return { verificationToken: token, expiresInSeconds: TOKEN_TTL };
  }

  /** 1회용 인증 토큰을 소비한다. 이미 쓰였거나 만료/불일치면 INVALID_VERIFICATION_CODE. */
  private async consumeToken(email: string, token: string, purpose: Purpose) {
    const r = await this.prisma.emailVerification.updateMany({
      where: { email, purpose, tokenHash: sha256(token), consumedAt: null, tokenExpiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (r.count !== 1) throw new ApiError('INVALID_VERIFICATION_CODE');
  }

  // ───────── 가입 ─────────
  private async checkTerms(agreedTermIds: string[], exceptTypes: string[] = ['CREATOR']) {
    const terms = await this.prisma.term.findMany();
    const known = new Set(terms.map((t) => t.id));
    if (agreedTermIds.some((id) => !known.has(id))) throw new ApiError('VALIDATION_ERROR', '알 수 없는 약관입니다.');
    const need = terms.filter((t) => t.required && !exceptTypes.includes(t.type));
    if (need.some((t) => !agreedTermIds.includes(t.id))) throw new ApiError('TERMS_REQUIRED');
  }

  /** 사용자·로그인 수단·약관 동의·지갑(체험 크레딧)을 한 번에 만든다. */
  private async createUser(p: {
    email: string | null; passwordHash?: string; nickname: string; agreedTermIds: string[];
    provider: 'EMAIL' | 'DISCORD'; providerUserId: string; display?: string;
  }) {
    const trial = await this.policy.get('signupGrantCredits');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: p.email, passwordHash: p.passwordHash, nickname: p.nickname,
            identities: { create: { provider: p.provider, providerUserId: p.providerUserId, display: p.display } },
            agreements: { create: p.agreedTermIds.map((termId) => ({ termId })) },
          },
        });
        await tx.wallet.create({ data: { userId: user.id } });
        if (trial > 0) await creditChange(tx, user.id, 'TRIAL', trial, { type: 'SIGNUP', id: user.id });
        return user;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const t = String(e.meta?.target ?? '');
        throw new ApiError(t.includes('nickname') ? 'DUPLICATED_NICKNAME' : 'DUPLICATED_EMAIL');
      }
      throw e;
    }
  }

  async signup(res: Response, b: { email: string; verificationToken: string; password: string; nickname: string; agreedTermIds: string[] }) {
    const email = b.email.toLowerCase();
    await this.checkTerms(b.agreedTermIds);
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ApiError('DUPLICATED_EMAIL');
    if (await this.prisma.user.findUnique({ where: { nickname: b.nickname } })) throw new ApiError('DUPLICATED_NICKNAME');
    await this.consumeToken(email, b.verificationToken, 'SIGNUP');
    const user = await this.createUser({
      email, passwordHash: await bcrypt.hash(b.password, 10), nickname: b.nickname, agreedTermIds: b.agreedTermIds,
      provider: 'EMAIL', providerUserId: email,
    });
    await this.startSession(res, user.id, user.role);
    return { user: await loadMe(this.prisma, this.storage, user.id) };
  }

  // ───────── 로그인 ─────────
  async login(res: Response, emailRaw: string, password: string) {
    const email = emailRaw.toLowerCase();
    const key = `login:${email}`;
    if ((await this.rate.count(key, 600)) >= 5) throw new ApiError('RATE_LIMITED');

    const user = await this.prisma.user.findUnique({ where: { email }, include: { identities: true } });
    const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (user && !user.passwordHash) {
      throw new ApiError('ACCOUNT_LINK_REQUIRED', undefined, { providers: user.identities.map((i) => i.provider) });
    }
    if (!user || !valid || user.status === 'WITHDRAWN') {
      await this.rate.hit(key);
      throw new ApiError('INVALID_CREDENTIALS');
    }
    if ((await effectiveStatus(this.prisma, user)) === 'SUSPENDED') throw new ApiError('ACCOUNT_SUSPENDED');
    await this.rate.clear(key);
    await this.startSession(res, user.id, user.role);
    return { user: await loadMe(this.prisma, this.storage, user.id) };
  }

  // ───────── 세션(토큰) ─────────
  /** accessToken + refreshToken(새 가족 또는 기존 가족) + csrfToken 쿠키를 내려준다. */
  async startSession(res: Response, userId: string, role: 'USER' | 'ADMIN', familyId?: string) {
    const fam = familyId ?? randomToken(12);
    const refresh = randomToken(48);
    await this.prisma.refreshToken.create({
      data: { userId, familyId: fam, tokenHash: sha256(refresh), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    });
    setAccessCookie(res, signAccess({ sub: userId, role, fam }));
    setRefreshCookie(res, refresh);
    setCsrfCookie(res);
  }

  async refresh(req: Request, res: Response) {
    const token = req.cookies?.refreshToken as string | undefined;
    if (!token) throw new ApiError('UNAUTHORIZED', '로그인이 필요합니다.');
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!row || row.expiresAt < new Date() || row.revokedAt) {
      clearSessionCookies(res);
      throw new ApiError('UNAUTHORIZED');
    }
    // 1회용: 동시에 두 번 오면 한 쪽만 성공한다. 이미 쓴 토큰이 다시 오면 탈취로 보고 전부 폐기.
    const used = await this.prisma.refreshToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) {
      await this.prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      clearSessionCookies(res);
      throw new ApiError('UNAUTHORIZED');
    }
    const st = await effectiveStatus(this.prisma, row.user);
    if (st !== 'ACTIVE') {
      clearSessionCookies(res);
      throw new ApiError(st === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'UNAUTHORIZED');
    }
    await this.startSession(res, row.userId, row.user.role, row.familyId);
    return null;
  }

  async logout(req: Request, res: Response) {
    const token = req.cookies?.refreshToken as string | undefined;
    if (token) await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token) }, data: { revokedAt: new Date() } });
    clearSessionCookies(res);
    return null;
  }

  /** 사용자의 refresh 토큰을 폐기한다. exceptFamily 가 있으면 그 기기는 유지. */
  revokeAll(userId: string, exceptFamily?: string) {
    return this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, ...(exceptFamily ? { familyId: { not: exceptFamily } } : {}) },
      data: { revokedAt: new Date() },
    });
  }

  // ───────── 비밀번호 ─────────
  async resetPassword(emailRaw: string, token: string, newPassword: string) {
    const email = emailRaw.toLowerCase();
    await this.consumeToken(email, token, 'PASSWORD_RESET');
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new ApiError('INVALID_VERIFICATION_CODE');
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      this.prisma.identity.upsert({
        where: { provider_providerUserId: { provider: 'EMAIL', providerUserId: email } },
        create: { userId: user.id, provider: 'EMAIL', providerUserId: email },
        update: {},
      }),
    ]);
    await this.revokeAll(user.id);
    return null;
  }

  async changePassword(userId: string, fam: string, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash) throw new ApiError('VALIDATION_ERROR', '비밀번호가 설정되지 않은 계정입니다.');
    if (!(await bcrypt.compare(current, user.passwordHash))) throw new ApiError('INVALID_PASSWORD');
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(next, 10) } });
    await this.revokeAll(userId, fam);
    return null;
  }

  // ───────── 로그인 수단 ─────────
  async identities(userId: string) {
    const rows = await this.prisma.identity.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return {
      items: rows.map((i) => ({
        provider: i.provider,
        identifier: i.provider === 'EMAIL' ? maskEmail(i.providerUserId) : (i.display ?? i.providerUserId),
        linkedAt: i.createdAt,
      })),
    };
  }

  async unlink(userId: string, provider: string) {
    if (provider !== 'EMAIL' && provider !== 'DISCORD') throw new ApiError('VALIDATION_ERROR', '지원하지 않는 로그인 수단입니다.');
    const rows = await this.prisma.identity.findMany({ where: { userId } });
    const target = rows.find((r) => r.provider === provider);
    if (!target) throw new ApiError('NOT_FOUND');
    if (rows.length <= 1) throw new ApiError('LAST_IDENTITY');
    await this.prisma.$transaction([
      this.prisma.identity.delete({ where: { id: target.id } }),
      ...(provider === 'EMAIL' ? [this.prisma.user.update({ where: { id: userId }, data: { passwordHash: null } })] : []),
    ]);
    return null;
  }

  // ───────── Discord ─────────
  private front = () => frontendOrigins()[0];
  private safePath = (p: unknown) => (typeof p === 'string' && /^\/(?!\/)[^\s\\]*$/.test(p) ? p : '/');

  discordStart(req: Request, res: Response) {
    const mode = req.query.mode === 'LINK' ? 'LINK' : 'LOGIN';
    if (mode === 'LINK' && !verifyAccess(req.cookies?.accessToken)) throw new ApiError('UNAUTHORIZED');
    const state = randomToken(24);
    res.cookie('oauthState', JSON.stringify({ state, mode, path: this.safePath(req.query.redirectPath) }), {
      httpOnly: true, secure: env('NODE_ENV') === 'production', sameSite: 'lax', path: '/', maxAge: 5 * 60 * 1000,
    });
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: env('DISCORD_CLIENT_ID'), response_type: 'code', redirect_uri: env('DISCORD_REDIRECT_URI'),
      scope: 'identify email', state, prompt: 'none',
    }).toString();
    res.redirect(302, url.toString());
  }

  private async discordProfile(code: string): Promise<DiscordTicket> {
    const tok = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env('DISCORD_CLIENT_ID'), client_secret: env('DISCORD_CLIENT_SECRET'), grant_type: 'authorization_code',
        code, redirect_uri: env('DISCORD_REDIRECT_URI'),
      }),
    });
    if (!tok.ok) throw new Error('discord token');
    const { access_token } = (await tok.json()) as { access_token: string };
    const me = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
    if (!me.ok) throw new Error('discord me');
    const u = (await me.json()) as { id: string; username: string; email?: string | null; verified?: boolean };
    return { discordId: u.id, username: u.username, email: u.verified && u.email ? u.email.toLowerCase() : null };
  }

  /** 콜백은 JSON 이 아니라 브라우저 리다이렉트다. 실패는 프론트 /login?error=... 로 보낸다. */
  async discordCallback(req: Request, res: Response) {
    const fail = (code: string) => res.redirect(302, `${this.front()}/login?error=${code}`);
    let saved: { state: string; mode: 'LOGIN' | 'LINK'; path: string } | null = null;
    try {
      saved = JSON.parse(String(req.cookies?.oauthState ?? ''));
    } catch { /* 아래에서 처리 */ }
    res.clearCookie('oauthState', { path: '/' });
    const { code, state } = req.query as { code?: string; state?: string };
    if (!saved || !code || !state || saved.state !== state) return fail('OAUTH_FAILED');

    let profile: DiscordTicket;
    try {
      profile = await this.discordProfile(code);
    } catch {
      return fail('OAUTH_FAILED');
    }
    const existing = await this.prisma.identity.findUnique({
      where: { provider_providerUserId: { provider: 'DISCORD', providerUserId: profile.discordId } },
      include: { user: true },
    });

    if (saved.mode === 'LINK') {
      const claims = verifyAccess(req.cookies?.accessToken);
      if (!claims) return fail('UNAUTHORIZED');
      if (existing && existing.userId !== claims.sub) return fail('ALREADY_LINKED');
      if (!existing) {
        await this.prisma.identity.upsert({
          where: { userId_provider: { userId: claims.sub, provider: 'DISCORD' } },
          create: { userId: claims.sub, provider: 'DISCORD', providerUserId: profile.discordId, display: profile.username },
          update: { providerUserId: profile.discordId, display: profile.username },
        });
      }
      return res.redirect(302, this.front() + saved.path);
    }

    if (existing) {
      if (existing.user.status === 'SUSPENDED') return fail('ACCOUNT_SUSPENDED');
      if (existing.user.status === 'WITHDRAWN') return fail('OAUTH_FAILED');
      await this.startSession(res, existing.userId, existing.user.role);
      return res.redirect(302, this.front() + saved.path);
    }
    if (profile.email && (await this.prisma.user.findUnique({ where: { email: profile.email } }))) {
      return fail('ACCOUNT_LINK_REQUIRED');
    }
    setTicketCookie(res, signTicket(profile));
    return res.redirect(302, `${this.front()}/signup/discord`);
  }

  async discordSignup(req: Request, res: Response, b: { nickname: string; agreedTermIds: string[] }) {
    const t = verifyTicket(req.cookies?.signupTicket);
    if (!t) throw new ApiError('UNAUTHORIZED', '가입 시간이 만료되었습니다. 다시 로그인해주세요.');
    await this.checkTerms(b.agreedTermIds);
    if (await this.prisma.identity.findUnique({ where: { provider_providerUserId: { provider: 'DISCORD', providerUserId: t.discordId } } })) {
      throw new ApiError('DUPLICATED');
    }
    if (t.email && (await this.prisma.user.findUnique({ where: { email: t.email } }))) throw new ApiError('DUPLICATED_EMAIL');
    const user = await this.createUser({
      email: t.email, nickname: b.nickname, agreedTermIds: b.agreedTermIds,
      provider: 'DISCORD', providerUserId: t.discordId, display: t.username,
    });
    clearTicketCookie(res);
    await this.startSession(res, user.id, user.role);
    return { user: await loadMe(this.prisma, this.storage, user.id) };
  }
}

function maskEmail(e: string) {
  const [l, d] = e.split('@');
  return `${l.slice(0, 2)}${'*'.repeat(Math.max(1, l.length - 2))}@${d}`;
}
