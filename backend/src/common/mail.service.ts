import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { env } from '../config.js';

@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  /** 테스트에서 보낸 메일 본문을 확인하기 위한 저장소(MAIL_DRY=1 이거나 SMTP 미설정일 때 채워진다). */
  readonly outbox: { to: string; subject: string; text: string }[] = [];
  private readonly transporter = env('SMTP_USER')
    ? nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') } })
    : null;

  async send(to: string, subject: string, text: string) {
    if (env('MAIL_DRY') === '1' || !this.transporter) {
      this.outbox.push({ to, subject, text });
      this.log.warn(`[dry] mail to ${to}: ${subject}`);
      return;
    }
    await this.transporter.sendMail({ from: `EmoMix <${env('SMTP_USER')}>`, to, subject, text });
  }
}
