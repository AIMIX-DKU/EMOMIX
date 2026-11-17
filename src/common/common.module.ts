import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { StorageService } from './storage.service.js';
import { PolicyService } from './policy.service.js';
import { MailService } from './mail.service.js';
import { RateService } from './rate.service.js';
import { NotifyService } from './notify.service.js';

@Global()
@Module({
  providers: [PrismaService, StorageService, PolicyService, MailService, RateService, NotifyService],
  exports: [PrismaService, StorageService, PolicyService, MailService, RateService, NotifyService],
})
export class CommonModule {}
