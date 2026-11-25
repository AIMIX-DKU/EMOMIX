// Uses only Node's built-in fetch. Credentials and session cookies stay in memory.
const base = new URL(
  process.env.EMOMIX_API_ORIGIN || 'https://emomix-backend.vercel.app',
);
const email = process.env.EMOMIX_TEST_EMAIL;
const password = process.env.EMOMIX_TEST_PASSWORD;
if (!email || !password)
  throw new Error('Set EMOMIX_TEST_EMAIL and EMOMIX_TEST_PASSWORD.');
const cookies = new Map();
let failed = 0;
async function call(path, { method = 'GET', body, expected = 200 } = {}) {
  const headers = {
    Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
  if (method !== 'GET')
    headers['X-CSRF-Token'] = decodeURIComponent(
      cookies.get('csrfToken') || '',
    );
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL('/api/v1' + path, base), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
    redirect: 'manual',
  });
  for (const entry of response.headers.getSetCookie()) {
    const pair = entry.split(';', 1)[0],
      split = pair.indexOf('=');
    cookies.set(pair.slice(0, split), pair.slice(split + 1));
  }
  const envelope = await response.json().catch(() => null);
  const ok =
    response.status === expected &&
    (expected >= 400 || envelope?.success === true);
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${method} ${path}: ${response.status}${ok ? '' : ' ' + (envelope?.errorCode || 'INVALID_ENVELOPE')}`,
  );
  if (!ok) failed++;
  return { response, data: envelope?.data, ok };
}
let loggedIn = false;
try {
  await call('/auth/csrf');
  const login = await call('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (!login.ok) throw new Error('Test login failed.');
  loggedIn = true;
  const me = (await call('/users/me')).data;
  for (const path of [
    '/users/me/identities',
    '/users/me/settings',
    '/terms',
    '/wallet',
    '/wallet/credit-transactions',
    '/wallet/point-transactions',
    '/rewards/rules',
    '/credit-packages',
    '/style-presets',
    '/emotion-presets',
    '/characters',
    '/sets',
    '/generations',
    '/users/me/bookmarks',
    '/users/me/purchases',
    '/subscription-plans',
    '/subscriptions/me',
    '/subscriptions/me/invoices',
    '/notifications',
    '/reports/me',
    '/posts',
    '/products',
    '/orders',
    '/rankings/posts?period=WEEKLY',
    '/rankings/prompts?period=WEEKLY',
    '/rankings/creators?period=WEEKLY',
    '/guides/export',
  ])
    await call(path);
  const creatorStatus = me.isCreator ? 200 : 403;
  for (const path of [
    '/creators/me',
    '/seller/balance',
    '/seller/settlements',
  ]) {
    await call(path, { expected: creatorStatus });
  }
  await call('/admin/policies', { expected: me.role === 'ADMIN' ? 200 : 403 });
  const discord = await fetch(
    new URL('/api/v1/auth/discord?mode=LOGIN&redirectPath=/', base),
    { redirect: 'manual', signal: AbortSignal.timeout(25000) },
  );
  const destination = new URL(discord.headers.get('location') || '/', base);
  const oauthOk =
    discord.status === 302 &&
    destination.origin === 'https://discord.com' &&
    destination.pathname === '/oauth2/authorize';
  console.log(`${oauthOk ? 'PASS' : 'FAIL'} Discord authorization redirect`);
  if (!oauthOk) failed++;
} finally {
  if (loggedIn) await call('/auth/logout', { method: 'POST' });
  cookies.clear();
}
console.log(
  `Live smoke: ${failed} failed. No purchases, publishing, account changes or GPU jobs performed.`,
);
process.exitCode = failed ? 1 : 0;
