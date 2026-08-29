'use client';

function apiUrl(path, baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3200') {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    throw new Error('API base URL must be a valid API origin');
  }
  if (!['http:', 'https:'].includes(new URL(baseUrl).protocol)) {
    throw new Error('API base URL must be a valid API origin');
  }
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    this.code = payload?.code || null;
  }
}

async function apiRequest(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    method: options.method || 'GET',
    credentials: 'include',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (!response.ok) {
    throw new ApiError(payload?.code || payload?.message || 'Request failed', response.status, payload);
  }
  return payload;
}

module.exports = { ApiError, apiRequest, apiUrl };
