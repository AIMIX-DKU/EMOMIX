import { Module } from '@nestjs/common';
import { PaymentModule } from '../payment/payment.module.js';
import { SubscriptionController } from './subscription.controller.js';
import { SubscriptionService } from './subscription.service.js';

@Module({ imports: [PaymentModule], controllers: [SubscriptionController], providers: [SubscriptionService] })
export class SubscriptionModule {}
