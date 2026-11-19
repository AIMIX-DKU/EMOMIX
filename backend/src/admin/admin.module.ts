import { Module } from '@nestjs/common';
import { NotificationController } from '../notification/notification.controller.js';
import { ReportController } from '../report/report.controller.js';
import { AdminController } from './admin.controller.js';

@Module({ controllers: [AdminController, ReportController, NotificationController] })
export class AdminModule {}
