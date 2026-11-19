import { Module } from '@nestjs/common';
import { CommunityController } from './community.controller.js';
import { CommunityService } from './community.service.js';
import { RankingController } from './ranking.controller.js';

@Module({ controllers: [CommunityController, RankingController], providers: [CommunityService], exports: [CommunityService] })
export class CommunityModule {}
