import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { cleanup, client, createApp, PASSWORD, REQUIRED_TERMS, signedUp, uniq } from './helpers.js';

describe('인증', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    ctx = await createApp();
    app = ctx.app;
    await cleanup(ctx.prisma);
  });
  afterAll(async () => {
    await cleanup(ctx.prisma);
    await app.close();
  });

  const lastCode = (email: string) => /(\d{6})/.exec(ctx.mail.outbox.filter((o) => o.to === email).at(-1)!.text)![1];

  it('CSRF 토큰 없이 로그인 필요 API 의 상태 변경을 하면 CSRF_INVALID', async () => {
    const { c } = await signedUp(app, ctx.mail);
    const r = await c.agent.post('/api/v1/auth/logout').send();
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe('CSRF_INVALID');
  });

  it('잘못된 Origin 은 CSRF_INVALID', async () => {
    const { c } = await signedUp(app, ctx.mail);
    const t = (await c.get('/auth/csrf')).body.data.csrfToken;
    const r = await c.agent.post('/api/v1/auth/logout').set('X-CSRF-Token', t).set('Origin', 'https://evil.example').send();
    expect(r.body.errorCode).toBe('CSRF_INVALID');
  });

  it('로그인 필요 API 는 쿠키가 없으면 UNAUTHORIZED', async () => {
    const r = await client(app).get('/users/me/identities');
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ success: false, errorCode: 'UNAUTHORIZED', data: null });
  });

  it('인증번호 → 가입 → 쿠키 발급(토큰은 body에 없음) → 로그아웃 → 로그인', async () => {
    const { c, email } = await signedUp(app, ctx.mail, uniq('flow'));
    const me = await c.get('/users/me/identities');
    expect(me.status).toBe(200);
    expect(me.body.data.items[0]).toMatchObject({ provider: 'EMAIL' });
    expect(JSON.stringify(me.body)).not.toContain('eyJ');

    const wallet = await ctx.prisma.wallet.findFirst({ where: { user: { email } } });
    expect(wallet?.creditBalance).toBe(20); // 체험 크레딧

    expect((await c.post('/auth/logout')).status).toBe(200);
    expect((await c.get('/users/me/identities')).status).toBe(401);

    const bad = await c.post('/auth/login', { email, password: 'Wrong!1234x' });
    expect(bad.body.errorCode).toBe('INVALID_CREDENTIALS');
    const ok = await c.post('/auth/login', { email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.email).toBe(email);
    const list = ok.headers['set-cookie'] as unknown as string[];
    const get = (n: string) => list.find((x) => x.startsWith(n + '='))!;
    expect(get('accessToken')).toMatch(/Path=\/;.*HttpOnly.*SameSite=Lax/);
    expect(get('refreshToken')).toMatch(/Path=\/api\/v1\/auth;.*HttpOnly/);
    expect(get('csrfToken')).not.toMatch(/HttpOnly/); // JS 가 읽어야 하는 쿠키
  });

  it('가입 검증: 약한 비밀번호, 필수 약관 누락, 이미 가입된 이메일', async () => {
    const c = client(app);
    const email = `e2e-${uniq('v')}@example.test`;
    await c.post('/auth/email/verification-codes', { email, purpose: 'SIGNUP' });
    const code = lastCode(email);
    const wrong = await c.post('/auth/email/verification-codes/verify', {
      email, code: code === '000000' ? '111111' : '000000', purpose: 'SIGNUP',
    });
    expect(wrong.body.errorCode).toBe('INVALID_VERIFICATION_CODE');
    const v = await c.post('/auth/email/verification-codes/verify', { email, code, purpose: 'SIGNUP' });
    const base = { email, verificationToken: v.body.data.verificationToken, nickname: uniq('n'), agreedTermIds: REQUIRED_TERMS };

    expect((await c.post('/auth/signup', { ...base, password: 'weak' })).body.errorCode).toBe('VALIDATION_ERROR');
    expect((await c.post('/auth/signup', { ...base, password: PASSWORD, agreedTermIds: ['term-service'] })).body.errorCode).toBe('TERMS_REQUIRED');
    expect((await c.post('/auth/signup', { ...base, password: PASSWORD })).status).toBe(201);
    expect((await c.post('/auth/signup', { ...base, password: PASSWORD, nickname: uniq('n') })).body.errorCode).toBe('DUPLICATED_EMAIL');
  });

  it('인증번호 재발송은 60초 제한, 이미 가입된 이메일은 DUPLICATED_EMAIL', async () => {
    const { c, email } = await signedUp(app, ctx.mail);
    expect((await c.post('/auth/email/verification-codes', { email, purpose: 'SIGNUP' })).body.errorCode).toBe('DUPLICATED_EMAIL');
    const e2 = `e2e-${uniq('r')}@example.test`;
    expect((await c.post('/auth/email/verification-codes', { email: e2, purpose: 'SIGNUP' })).status).toBe(200);
    expect((await c.post('/auth/email/verification-codes', { email: e2, purpose: 'SIGNUP' })).body.errorCode).toBe('RATE_LIMITED');
  });

  it('로그인 5회 실패 후에는 RATE_LIMITED', async () => {
    const { c, email } = await signedUp(app, ctx.mail);
    for (let i = 0; i < 5; i++) await c.post('/auth/login', { email, password: 'Wrong!1234x' });
    expect((await c.post('/auth/login', { email, password: PASSWORD })).body.errorCode).toBe('RATE_LIMITED');
  });

  it('refresh 토큰은 1회용이고, 재사용하면 해당 사용자의 모든 토큰이 폐기된다', async () => {
    const { c, email } = await signedUp(app, ctx.mail);
    const pick = (res: request.Response) =>
      (res.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('refreshToken='))!.split(';')[0];
    const old = pick(await c.post('/auth/login', { email, password: PASSWORD }));

    const r1 = await c.post('/auth/refresh');
    expect(r1.status).toBe(200);
    const rotated = pick(r1);
    expect(rotated).not.toBe(old);

    const t = (await c.get('/auth/csrf')).body.data.csrfToken;
    const send = (cookie: string) =>
      request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', [cookie, `csrfToken=${t}`]).set('X-CSRF-Token', t);
    expect((await send(old)).status).toBe(401); // 이미 쓴 토큰 재사용 = 탈취로 간주
    expect((await send(rotated)).status).toBe(401); // 정상 회전 토큰도 함께 폐기
  });

  it('비밀번호 변경·재설정', async () => {
    const { c, email } = await signedUp(app, ctx.mail);
    expect((await c.put('/users/me/password', { currentPassword: 'Nope!12345', newPassword: 'New!pass1234' })).body.errorCode).toBe('INVALID_PASSWORD');
    expect((await c.put('/users/me/password', { currentPassword: PASSWORD, newPassword: 'New!pass1234' })).status).toBe(200);
    expect((await client(app).post('/auth/login', { email, password: 'New!pass1234' })).status).toBe(200);

    const c2 = client(app);
    await c2.post('/auth/email/verification-codes', { email, purpose: 'PASSWORD_RESET' });
    const v = await c2.post('/auth/email/verification-codes/verify', { email, code: lastCode(email), purpose: 'PASSWORD_RESET' });
    const bad = await c2.post('/auth/password/reset', { email, verificationToken: 'x'.repeat(20), newPassword: 'Reset!pass99' });
    expect(bad.body.errorCode).toBe('INVALID_VERIFICATION_CODE');
    expect((await c2.post('/auth/password/reset', { email, verificationToken: v.body.data.verificationToken, newPassword: 'Reset!pass99' })).status).toBe(200);
    expect((await client(app).post('/auth/login', { email, password: 'Reset!pass99' })).status).toBe(200);
  });

  it('없는 이메일의 비밀번호 재설정 인증번호 요청도 같은 응답(계정 노출 방지)', async () => {
    const r = await client(app).post('/auth/email/verification-codes', { email: `e2e-${uniq('none')}@example.test`, purpose: 'PASSWORD_RESET' });
    expect(r.status).toBe(200);
  });

  it('Discord: 시작은 discord.com 으로 302 + state 쿠키, 잘못된 state 콜백은 프론트 에러 리다이렉트, LINK 는 로그인 필요', async () => {
    const c = client(app);
    const s = await c.agent.get('/api/v1/auth/discord?redirectPath=/home');
    expect(s.status).toBe(302);
    expect(s.headers.location).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize\?/);
    expect(s.headers.location).toContain('scope=identify+email');
    expect((s.headers['set-cookie'] as unknown as string[]).join(';')).toContain('oauthState=');
    const cb = await c.agent.get('/api/v1/auth/discord/callback?code=abc&state=wrong');
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toMatch(/\/login\?error=OAUTH_FAILED$/);
    expect((await client(app).get('/auth/discord?mode=LINK')).status).toBe(401);
  });

  it('로그인 수단 해제: 하나뿐이면 LAST_IDENTITY, 없는 수단은 NOT_FOUND', async () => {
    const { c } = await signedUp(app, ctx.mail);
    expect((await c.del('/users/me/identities/EMAIL')).body.errorCode).toBe('LAST_IDENTITY');
    expect((await c.del('/users/me/identities/DISCORD')).body.errorCode).toBe('NOT_FOUND');
  });
});
