import 'dotenv/config';

export const env = (name: string, fallback = ''): string => process.env[name] ?? fallback;
export const isProd = () => env('NODE_ENV') === 'production';
export const frontendOrigins = () =>
  env('FRONTEND_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim());
