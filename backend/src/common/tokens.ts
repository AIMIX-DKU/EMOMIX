import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config.js';

const secret = () => {
  const s = env('JWT_SECRET');
  if (s.length < 32) throw new Error('JWT_SECRET 이 설정되지 않았습니다.');
  return s;
};

export interface AccessClaims {
  sub: string;
  role: 'USER' | 'ADMIN';
  fam: string; // refresh 토큰 가족 ID. 현재 기기를 구분하는 데 쓴다.
}

export const signAccess = (c: AccessClaims) => jwt.sign(c, secret(), { expiresIn: '15m', audience: 'access' });

export function verifyAccess(token: string | undefined): AccessClaims | null {
  if (!token) return null;
  try {
    return jwt.verify(token, secret(), { audience: 'access' }) as unknown as AccessClaims;
  } catch {
    return null;
  }
}

export interface DiscordTicket {
  discordId: string;
  username: string;
  email: string | null; // Discord 가 인증한 이메일만 담는다
}

export const signTicket = (t: DiscordTicket) => jwt.sign(t, secret(), { expiresIn: '10m', audience: 'signup' });

export function verifyTicket(token: string | undefined): DiscordTicket | null {
  if (!token) return null;
  try {
    return jwt.verify(token, secret(), { audience: 'signup' }) as unknown as DiscordTicket;
  } catch {
    return null;
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
