import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EnvelopeFilter, EnvelopeInterceptor } from './common/envelope.js';
import { AccessGuard } from './common/access.js';
import { CommonModule } from './common/common.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { GenerationModule } from './generation/generation.module.js';
import { WalletModule } from './wallet/wallet.module.js';
import { CommunityModule } from './community/community.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [CommonModule, AuthModule, UsersModule, GenerationModule, WalletModule, CommunityModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: EnvelopeFilter },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
})
export class AppModule {}
