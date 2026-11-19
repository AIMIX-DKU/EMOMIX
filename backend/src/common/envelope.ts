import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { map } from 'rxjs';
import { ERRORS, type ErrorCode } from './error-codes.js';

/** 서비스에서 `throw new ApiError('INSUFFICIENT_CREDIT')` 처럼 사용한다. */
export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly data: unknown = null,
  ) {
    super(message ?? ERRORS[code].message);
  }
}

/** 성공 응답을 { success, message, data, errorCode } 로 감싼다. 컨트롤러가 반환한 값이 data. */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      map((data) => ({
        success: true,
        message: '요청이 성공했습니다.',
        data: data ?? null,
        errorCode: null,
      })),
    );
  }
}

/** 모든 예외를 { success:false, data:null, errorCode } 로 변환한다. */
@Catch()
export class EnvelopeFilter implements ExceptionFilter {
  private readonly log = new Logger('Exception');

  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let code: ErrorCode = 'SERVER_ERROR';
    let message: string | undefined;
    let data: unknown = null;

    if (e instanceof ApiError) {
      code = e.code;
      message = e.message;
      data = e.data;
    } else if (e instanceof HttpException) {
      const s = e.getStatus();
      code =
        s === 400 ? 'VALIDATION_ERROR'
        : s === 401 ? 'UNAUTHORIZED'
        : s === 403 ? 'FORBIDDEN'
        : s === 404 ? 'NOT_FOUND'
        : s === 429 ? 'RATE_LIMITED'
        : 'SERVER_ERROR';
    } else {
      this.log.error(e);
    }

    const { status, message: defMsg } = ERRORS[code];
    res.status(status).json({ success: false, message: message ?? defMsg, data, errorCode: code });
  }
}
