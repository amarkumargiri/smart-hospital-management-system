// One place that knows how to talk to the API: attaches the access token,
// refreshes it once when it expires, and turns error responses into thrown
// Errors carrying the server's message.

const API_BASE_URL = import.meta.env.VITE_API_URL || '';
const ACCESS_KEY = 'sh.accessToken';
const REFRESH_KEY = 'sh.refreshToken';

export const tokens = {
  get access() { return localStorage.getItem(ACCESS_KEY); },
  get refresh() { return localStorage.getItem(REFRESH_KEY); },
  set({ accessToken, refreshToken }) {
    if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function refreshAccessToken() {
  const refreshToken = tokens.refresh;
  if (!refreshToken) return false;
  const res = await fetch(`${API_BASE_URL}/api/auth/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    tokens.clear();
    return false;
  }
  tokens.set(await res.json());
  return true;
}

async function request(method, path, body, { retry = true, raw = false } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API_BASE_URL}/api${path}`, {
    method,
    headers: {
      ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}),
    },
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
  });

  // A single retry after a silent refresh: the access token is short-lived, and
  // the user should never see a login screen because of that alone.
  if (res.status === 401 && retry && (await refreshAccessToken())) {
    return request(method, path, body, { retry: false, raw });
  }

  if (raw) {
    if (!res.ok) throw new ApiError(res.status, 'Download failed.');
    return res.blob();
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText, data?.details);
  return data;
}

const query = (params) => {
  const clean = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== '' && v !== null);
  return clean.length ? `?${new URLSearchParams(clean)}` : '';
};

export const api = {
  get: (path, params) => request('GET', path + query(params)),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path, body) => request('DELETE', path, body),
  blob: (path, params) => request('GET', path + query(params), undefined, { raw: true }),
};

export { ApiError };
