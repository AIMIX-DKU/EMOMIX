import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

describe('공통 응답 포맷', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });
  afterAll(() => app.close());

  it('성공은 { success:true, data } 로 감싼다', async () => {
    const r = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(r.body).toMatchObject({ success: true, errorCode: null, data: { status: 'UP' } });
  });

  it('없는 경로는 NOT_FOUND 포맷', async () => {
    const r = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(r.body).toEqual({ success: false, message: '존재하지 않는 리소스입니다.', data: null, errorCode: 'NOT_FOUND' });
  });
});
