// Vercel 서버리스 진입점. Nest 앱을 한 번 만들어 두고(콜드스타트 때만) 요청마다 재사용한다.
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from '../dist/app.module.js';
import { setupApp } from '../dist/setup.js';

let ready;

async function bootstrap() {
  const server = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), { rawBody: true, logger: ['error', 'warn'] });
  setupApp(app);
  await app.init();
  return server;
}

export default async function handler(req, res) {
  ready ??= bootstrap().catch((e) => {
    ready = undefined; // 부팅 실패는 캐시하지 않는다
    throw e;
  });
  const server = await ready;
  return server(req, res);
}
