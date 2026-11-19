import { Module } from '@nestjs/common';
import { CommunityModule } from '../community/community.module.js';
import { GenerationModule } from '../generation/generation.module.js';
import { MarketController } from './market.controller.js';

@Module({ imports: [CommunityModule, GenerationModule], controllers: [MarketController] })
export class MarketModule {}
