import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { frontendOrigins } from './config.js';

/** main.ts 와 테스트가 같은 설정을 쓰도록 모은 앱 공통 설정. */
export function setupApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  // 로컬 개발(프론트 5173 → API 3000)용 CORS. 운영은 같은 사이트(rewrite)라 영향 없다. 쿠키를 쓰므로 origin 을 명시한다.
  app.enableCors({
    origin: frontendOrigins(), credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'],
  });
  app.use(cookieParser());
  (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', 1);
}
