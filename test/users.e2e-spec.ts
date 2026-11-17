import type { INestApplication } from '@nestjs/common';
import { StorageService } from '../src/common/storage.service.js';
import { cleanup, client, createApp, REQUIRED_TERMS, signedUp } from './helpers.js';

// 1x1 투명 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('사용자·약관·업로드·창작자', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof createApp>>;
  const withdrawn: string[] = []; // 탈퇴 후 이메일이 비워진 테스트 사용자 ID
  beforeAll(async () => {
    ctx = await createApp();
    app = ctx.app;
    await cleanup(ctx.prisma, app.get(StorageService));
  });
  afterAll(async () => {
    await cleanup(ctx.prisma, app.get(StorageService), withdrawn);
    await app.close();
  });

  it('약관 목록/상세/동의 변경', async () => {
    const list = await client(app).get('/terms');
    expect(list.body.data.items.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(REQUIRED_TERMS));
    expect((await client(app).get('/terms/term-service')).body.data.content).toContain('이용약관');
    expect((await client(app).get('/terms/nope')).body.errorCode).toBe('NOT_FOUND');

    const { c } = await signedUp(app, ctx.mail);
    expect((await c.put('/users/me/agreements', { agreedTermIds: ['term-service'] })).body.errorCode).toBe('TERMS_REQUIRED');
    expect((await c.put('/users/me/agreements', { agreedTermIds: [...REQUIRED_TERMS, 'term-marketing'] })).status).toBe(200);
  });

  it('내 정보 조회·수정, 닉네임 중복, 설정', async () => {
    const a = await signedUp(app, ctx.mail);
    const b = await signedUp(app, ctx.mail);
    const me = await a.c.get('/users/me');
    expect(me.body.data).toMatchObject({ email: a.email, role: 'USER', isCreator: false, providers: ['EMAIL'] });
    expect((await a.c.patch('/users/me', { nickname: b.nick })).body.errorCode).toBe('DUPLICATED_NICKNAME');
    const up = await a.c.patch('/users/me', { bio: '안녕하세요' });
    expect(up.body.data.bio).toBe('안녕하세요');
    expect((await a.c.patch('/users/me', { nickname: 'x' })).body.errorCode).toBe('VALIDATION_ERROR');

    const s = await a.c.patch('/users/me/settings', { notifications: { like: false } });
    expect(s.body.data.notifications).toMatchObject({ like: false, comment: true });
    expect((await a.c.get('/users/me/settings')).body.data.notifications.like).toBe(false);
  });

  it('프로필 조회와 팔로우/언팔로우', async () => {
    const a = await signedUp(app, ctx.mail);
    const b = await signedUp(app, ctx.mail);
    expect((await a.c.post(`/users/${a.id}/follow`)).body.errorCode).toBe('SELF_ACTION');
    expect((await a.c.post(`/users/${b.id}/follow`)).status).toBe(201);
    expect((await a.c.post(`/users/${b.id}/follow`)).body.errorCode).toBe('DUPLICATED');
    const p = await a.c.get(`/users/${b.id}`);
    expect(p.body.data).toMatchObject({ id: b.id, followerCount: 1, isFollowing: true });
    expect(p.body.data.email).toBeUndefined(); // 이메일은 공개 프로필에 없다
    expect((await client(app).get(`/users/${b.id}`)).body.data.isFollowing).toBe(false); // 비로그인
    expect((await a.c.del(`/users/${b.id}/follow`)).status).toBe(200);
    expect((await a.c.get(`/users/${b.id}`)).body.data.followerCount).toBe(0);
    expect((await a.c.get('/users/00000000-0000-0000-0000-000000000000')).body.errorCode).toBe('NOT_FOUND');
    const noti = await ctx.prisma.notification.count({ where: { userId: b.id, type: 'FOLLOW' } });
    expect(noti).toBe(1);
  });

  it('이미지 업로드: presign → 스토리지에 PUT → complete, 잘못된 내용·큰 파일 거부, 프로필 연결', async () => {
    const { c } = await signedUp(app, ctx.mail);
    expect((await c.post('/uploads/images/presign', { contentType: 'image/png', sizeBytes: 20 * 1024 * 1024, purpose: 'PROFILE' })).body.errorCode).toBe('FILE_TOO_LARGE');
    expect((await c.post('/uploads/images/presign', { contentType: 'image/gif', sizeBytes: 10, purpose: 'PROFILE' })).body.errorCode).toBe('VALIDATION_ERROR');

    const p = await c.post('/uploads/images/presign', { contentType: 'image/png', sizeBytes: PNG.length, purpose: 'PROFILE' });
    expect(p.status).toBe(201);
    // 아직 올리지 않음
    expect((await c.post(`/uploads/images/${p.body.data.uploadId}/complete`)).body.errorCode).toBe('VALIDATION_ERROR');
    const put = await fetch(p.body.data.uploadUrl, { method: 'PUT', headers: p.body.data.uploadHeaders, body: PNG });
    expect(put.status).toBe(200);
    const done = await c.post(`/uploads/images/${p.body.data.uploadId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ width: 1, height: 1, sizeBytes: PNG.length });
    expect((await fetch(done.body.data.url)).status).toBe(200); // 서명된 읽기 URL

    const me = await c.patch('/users/me', { profileImageUploadId: p.body.data.uploadId });
    expect(me.body.data.profileImageUrl).toMatch(/^https:\/\//);

    // PNG 라고 신고하고 다른 내용을 올리면 거부
    const fake = Buffer.from('not an image at all, just text.......');
    const p2 = await c.post('/uploads/images/presign', { contentType: 'image/png', sizeBytes: fake.length, purpose: 'REFERENCE' });
    await fetch(p2.body.data.uploadUrl, { method: 'PUT', headers: p2.body.data.uploadHeaders, body: fake });
    expect((await c.post(`/uploads/images/${p2.body.data.uploadId}/complete`)).body.errorCode).toBe('UNSUPPORTED_FILE_TYPE');

    // 남의 업로드는 접근 불가
    const other = await signedUp(app, ctx.mail);
    expect((await other.c.post(`/uploads/images/${p.body.data.uploadId}/complete`)).body.errorCode).toBe('NOT_FOUND');
    expect((await other.c.patch('/users/me', { profileImageUploadId: p.body.data.uploadId })).body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('창작자 등록·조회(계좌 마스킹)·수정, 비창작자는 NOT_CREATOR', async () => {
    const { c } = await signedUp(app, ctx.mail);
    expect((await c.get('/creators/me')).body.errorCode).toBe('NOT_CREATOR');
    const acc = { bankName: '테스트은행', accountHolder: '홍길동', accountNumber: '123-4567-8901' };
    expect((await c.post('/creators/me', { agreedTermIds: ['term-service'], payoutAccount: acc })).body.errorCode).toBe('TERMS_REQUIRED');
    expect((await c.post('/creators/me', { agreedTermIds: ['term-creator'], payoutAccount: acc })).status).toBe(201);
    expect((await c.post('/creators/me', { agreedTermIds: ['term-creator'], payoutAccount: acc })).body.errorCode).toBe('DUPLICATED');
    const g = await c.get('/creators/me');
    expect(g.body.data.payoutAccount.accountNumberMasked).toBe('***-**-8901');
    expect(JSON.stringify(g.body)).not.toContain('4567');
    expect((await c.patch('/creators/me', { payoutAccount: { ...acc, accountNumber: '999-0000-1111' } })).status).toBe(200);
    expect((await c.get('/users/me')).body.data.isCreator).toBe(true);
  });

  it('회원 탈퇴: 확인 문구 필요, 이후 로그인 불가·프로필 숨김', async () => {
    const { c, email, id } = await signedUp(app, ctx.mail);
    withdrawn.push(id);
    expect((await c.del('/users/me', { confirmText: '아니오' })).body.errorCode).toBe('VALIDATION_ERROR');
    expect((await c.del('/users/me', { confirmText: '탈퇴' })).status).toBe(200);
    expect((await c.get('/users/me')).status).toBe(401);
    expect((await client(app).post('/auth/login', { email, password: 'Test!1234pw' })).body.errorCode).toBe('INVALID_CREDENTIALS');
    expect((await client(app).get(`/users/${id}`)).body.errorCode).toBe('NOT_FOUND');
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id } });
    expect(u.email).toBeNull();
  });
});
