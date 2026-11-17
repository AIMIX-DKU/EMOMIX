import { Module } from '@nestjs/common';
import { CharacterController } from '../character/character.controller.js';
import { DownloadController } from '../emoticon/download.controller.js';
import { ExportService } from '../emoticon/export.service.js';
import { EmoticonController } from '../emoticon/emoticon.controller.js';
import { WorkerController } from '../worker/worker.controller.js';
import { GenerationController } from './generation.controller.js';
import { GenerationService } from './generation.service.js';

@Module({
  controllers: [CharacterController, GenerationController, EmoticonController, DownloadController, WorkerController],
  providers: [GenerationService, ExportService],
  exports: [GenerationService, ExportService],
})
export class GenerationModule {}
