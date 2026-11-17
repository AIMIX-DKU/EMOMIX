import { NestFactory } from '@nestjs/core';
import './config.js';
import { AppModule } from './app.module.js';
import { setupApp } from './setup.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
