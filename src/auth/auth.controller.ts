import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Access, CurrentUser, type Me } from '../common/access.js';
import { parse, z } from '../common/validate.js';
import { setCsrfCookie } from '../common/cookies.js';
import { AuthService, PASSWORD_RE } from './auth.service.js';

const email = z.string().email().max(200);
const password = z.string().regex(PASSWORD_RE, '8자 이상, 영문·숫자·특수문자를 각각 1개 이상 포함해야 합니다');
const purpose = z.enum(['SIGNUP', 'PASSWORD_RESET']);
const nickname = z.string().trim().min(2).max(16);
const termIds = z.array(z.string()).max(20);

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('auth/email/verification-codes') @HttpCode(200) @Access('none')
  sendCode(@Body() b: unknown) {
    const x = parse(z.object({ email, purpose }), b);
    return this.auth.sendCode(x.email, x.purpose);
  }

  @Post('auth/email/verification-codes/verify') @HttpCode(200) @Access('none')
  verify(@Body() b: unknown) {
    const x = parse(z.object({ email, code: z.string().regex(/^\d{6}$/), purpose }), b);
    return this.auth.verifyCode(x.email, x.code, x.purpose);
  }

  @Post('auth/signup') @HttpCode(201) @Access('none')
  signup(@Body() b: unknown, @Res({ passthrough: true }) res: Response) {
    const x = parse(z.object({ email, verificationToken: z.string().min(10), password, nickname, agreedTermIds: termIds }), b);
    return this.auth.signup(res, x);
  }

  @Post('auth/login') @HttpCode(200) @Access('none')
  login(@Body() b: unknown, @Res({ passthrough: true }) res: Response) {
    const x = parse(z.object({ email, password: z.string().min(1).max(200) }), b);
    return this.auth.login(res, x.email, x.password);
  }

  @Get('auth/discord') @Access('none')
  discordStart(@Req() req: Request, @Res() res: Response) {
    return this.auth.discordStart(req, res);
  }

  @Get('auth/discord/callback') @Access('none')
  discordCallback(@Req() req: Request, @Res() res: Response) {
    return this.auth.discordCallback(req, res);
  }

  @Post('auth/discord/signup') @HttpCode(201) @Access('ticket')
  discordSignup(@Body() b: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const x = parse(z.object({ nickname, agreedTermIds: termIds }), b);
    return this.auth.discordSignup(req, res, x);
  }

  @Post('auth/refresh') @HttpCode(200) @Access('refresh')
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req, res);
  }

  @Post('auth/logout') @HttpCode(200) @Access('user')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req, res);
  }

  @Get('auth/csrf') @Access('none')
  csrf(@Res({ passthrough: true }) res: Response) {
    return { csrfToken: setCsrfCookie(res) };
  }

  @Post('auth/password/reset') @HttpCode(200) @Access('none')
  reset(@Body() b: unknown) {
    const x = parse(z.object({ email, verificationToken: z.string().min(10), newPassword: password }), b);
    return this.auth.resetPassword(x.email, x.verificationToken, x.newPassword);
  }

  @Put('users/me/password') @Access('user')
  changePassword(@CurrentUser() me: Me, @Body() b: unknown) {
    const x = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), b);
    return this.auth.changePassword(me.id, me.fam, x.currentPassword, x.newPassword);
  }

  @Get('users/me/identities') @Access('user')
  identities(@CurrentUser() me: Me) {
    return this.auth.identities(me.id);
  }

  @Delete('users/me/identities/:provider') @Access('user')
  unlink(@CurrentUser() me: Me, @Param('provider') provider: string) {
    return this.auth.unlink(me.id, provider);
  }
}
