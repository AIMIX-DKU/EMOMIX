const BASE = '/api/v1';
let csrfRequest;
let refreshRequest;

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function csrfCookie() {
  const entry = document.cookie
    .split('; ')
    .find((part) => part.startsWith('csrfToken='));
  return entry ? decodeURIComponent(entry.slice('csrfToken='.length)) : '';
}

async function send(path, options) {
  let response;
  try {
    response = await fetch(BASE + path, {
      ...options,
      credentials: 'include',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError(
      '서버에 연결하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.',
      0,
      'NETWORK_ERROR',
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw new ApiError(
      body?.message || '서버 요청을 처리하지 못했어요.',
      response.status,
      body?.errorCode,
    );
  }
  return body.data;
}

export function initializeCsrf() {
  if (!csrfRequest) {
    csrfRequest = send('/auth/csrf', { method: 'GET' }).catch((error) => {
      csrfRequest = undefined;
      throw error;
    });
  }
  return csrfRequest;
}

async function csrfToken() {
  const cookie = csrfCookie();
  if (cookie) return cookie;
  const data = await initializeCsrf();
  return csrfCookie() || data.csrfToken;
}

// A refresh is shared across concurrent 401 responses so rotating cookies are used once.
function refresh() {
  if (!refreshRequest) {
    refreshRequest = csrfToken()
      .then((token) =>
        send('/auth/refresh', {
          method: 'POST',
          headers: { 'X-CSRF-Token': token },
        }),
      )
      .finally(() => {
        refreshRequest = undefined;
      });
  }
  return refreshRequest;
}

export async function api(
  path,
  { method = 'GET', body, idempotencyKey, retry = true } = {},
) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = await csrfToken();
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  try {
    return await send(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error.status !== 401 || !retry || path.startsWith('/auth/'))
      throw error;
    await refresh();
    return api(path, { method, body, idempotencyKey, retry: false });
  }
}

export async function uploadImage(file, purpose) {
  const presign = await api('/uploads/images/presign', {
    method: 'POST',
    body: { contentType: file.type, sizeBytes: file.size, purpose },
  });
  const response = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: presign.uploadHeaders,
    body: file,
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error('이미지 업로드에 실패했어요.');
  return api(
    '/uploads/images/' + encodeURIComponent(presign.uploadId) + '/complete',
    { method: 'POST' },
  );
}
