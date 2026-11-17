import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  // TODO: 워커 마지막 claim 시각과 대기열 길이는 DB 연결 후 채운다.
  @Get()
  get() {
    return { status: 'UP', generationWorker: 'DOWN', queueLength: 0 };
  }
}
