import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/setup.js';
import { MailService } from '../src/common/mail.service.js';
import { PrismaService } from '../src/prisma.service.js';

process.env.MAIL_DRY = '1';

export async function createApp() {
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = m.createNestApplication();
  setupApp(app);
  await app.init();
  return { app, mail: app.get(MailService), prisma: app.get(PrismaService) };
}

/** 쿠키를 유지하는 클라이언트. 상태 변경 요청마다 CSRF 토큰을 새로 받아 헤더에 넣는다. */
export function client(app: INestApplication) {
  const agent = request.agent(app.getHttpServer());
  const csrf = async () => (await agent.get('/api/v1/auth/csrf')).body.data.csrfToken as string;
  const call = async (method: 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const token = await csrf(); // 쿠키는 요청 생성 시점에 붙으므로, 토큰을 먼저 받고 요청을 만든다
    return agent[method]('/api/v1' + url).set('X-CSRF-Token', token).send(body);
  };
  return {
    agent,
    get: (url: string) => agent.get('/api/v1' + url),
    post: (url: string, body?: object) => call('post', url, body),
    put: (url: string, body?: object) => call('put', url, body),
    patch: (url: string, body?: object) => call('patch', url, body),
    del: (url: string, body?: object) => call('delete', url, body),
  };
}

export type Client = ReturnType<typeof client>;

export const PASSWORD = 'Test!1234pw';
export const REQUIRED_TERMS = ['term-service', 'term-privacy', 'term-ai'];
export const uniq = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 이메일 인증 → 가입까지 마친 로그인 상태 클라이언트를 만든다. */
export async function signedUp(app: INestApplication, mail: MailService, nick = uniq('u')) {
  const c = client(app);
  const email = `e2e-${nick}@example.test`;
  await c.post('/auth/email/verification-codes', { email, purpose: 'SIGNUP' });
  const code = /(\d{6})/.exec(mail.outbox.filter((o) => o.to === email).at(-1)!.text)![1];
  const v = await c.post('/auth/email/verification-codes/verify', { email, code, purpose: 'SIGNUP' });
  if (v.status !== 200) throw new Error('인증 실패: ' + JSON.stringify(v.body));
  const r = await c.post('/auth/signup', {
    email, verificationToken: v.body.data.verificationToken, password: PASSWORD, nickname: nick, agreedTermIds: REQUIRED_TERMS,
  });
  if (r.status !== 201) throw new Error('가입 실패: ' + JSON.stringify(r.body));
  return { c, email, nick, id: r.body.data.user.id as string };
}

/** 테스트로 만든 사용자와 관련 데이터를 지운다(이메일이 e2e- 로 시작). */
export async function cleanup(prisma: PrismaService) {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'e2e-' } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.$transaction([
      prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } }),
      prisma.creditTransaction.deleteMany({ where: { userId: { in: ids } } }),
      prisma.pointTransaction.deleteMany({ where: { userId: { in: ids } } }),
      prisma.wallet.deleteMany({ where: { userId: { in: ids } } }),
      prisma.userAgreement.deleteMany({ where: { userId: { in: ids } } }),
      prisma.identity.deleteMany({ where: { userId: { in: ids } } }),
      prisma.user.deleteMany({ where: { id: { in: ids } } }),
    ]);
  }
  await prisma.emailVerification.deleteMany({ where: { email: { startsWith: 'e2e-' } } });
  await prisma.rateHit.deleteMany({ where: { key: { contains: 'e2e-' } } });
}
