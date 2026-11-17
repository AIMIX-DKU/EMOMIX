import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';

/** main.ts 와 테스트가 같은 설정을 쓰도록 모은 앱 공통 설정. */
export function setupApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', 1);
}
