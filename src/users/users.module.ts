import { Module } from '@nestjs/common';
import { UploadController } from '../upload/upload.controller.js';
import { CreatorsController } from './creators.controller.js';
import { TermsController } from './terms.controller.js';
import { UsersController } from './users.controller.js';

@Module({ controllers: [UsersController, CreatorsController, TermsController, UploadController] })
export class UsersModule {}
