import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { StorageService } from './storage.service.js';
import { PolicyService } from './policy.service.js';
import { MailService } from './mail.service.js';
import { RateService } from './rate.service.js';
import { NotifyService } from './notify.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { RewardService } from './reward.service.js';

const providers = [PrismaService, StorageService, PolicyService, MailService, RateService, NotifyService, IdempotencyService, RewardService];

@Global()
@Module({ providers, exports: providers })
export class CommonModule {}
