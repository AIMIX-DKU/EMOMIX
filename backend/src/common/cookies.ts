import type { Response } from 'express';
import { isProd } from '../config.js';
import { randomToken } from './tokens.js';

const base = () => ({ secure: isProd(), sameSite: 'lax' as const });
const REFRESH_PATH = '/api/v1/auth';

export const setAccessCookie = (res: Response, token: string) =>
  res.cookie('accessToken', token, { ...base(), httpOnly: true, path: '/', maxAge: 15 * 60 * 1000 });

export const setRefreshCookie = (res: Response, token: string) =>
  res.cookie('refreshToken', token, { ...base(), httpOnly: true, path: REFRESH_PATH, maxAge: 14 * 24 * 3600 * 1000 });

/** JS 가 읽어서 X-CSRF-Token 헤더에 넣어야 하므로 httpOnly 가 아니다. */
export function setCsrfCookie(res: Response) {
  const t = randomToken(24);
  res.cookie('csrfToken', t, { ...base(), httpOnly: false, path: '/' });
  return t;
}

export const setTicketCookie = (res: Response, token: string) =>
  res.cookie('signupTicket', token, { ...base(), httpOnly: true, path: '/', maxAge: 10 * 60 * 1000 });

export function clearSessionCookies(res: Response) {
  res.clearCookie('accessToken', { ...base(), httpOnly: true, path: '/' });
  res.clearCookie('refreshToken', { ...base(), httpOnly: true, path: REFRESH_PATH });
}
export const clearTicketCookie = (res: Response) => res.clearCookie('signupTicket', { ...base(), httpOnly: true, path: '/' });
