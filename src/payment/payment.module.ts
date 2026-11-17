import { Module } from '@nestjs/common';
import { CommunityModule } from '../community/community.module.js';
import { DonationController } from './donation.controller.js';
import { OrderService } from './order.service.js';
import { PaymentController } from './payment.controller.js';
import { SellerController } from './seller.controller.js';
import { TossService } from './toss.service.js';

@Module({
  imports: [CommunityModule],
  controllers: [PaymentController, DonationController, SellerController],
  providers: [OrderService, TossService],
  exports: [OrderService],
})
export class PaymentModule {}
