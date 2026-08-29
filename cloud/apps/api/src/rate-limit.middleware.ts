import type { NextFunction, Request, Response } from 'express';

import type { RateLimitService } from './rate-limit.service.js';

const AUTH_ROUTES: Array<[string, string]> = [
  ['/sign-in/', 'login'],
  ['/sign-up/', 'register'],
  ['/request-password-reset', 'forgot-password'],
  ['/reset-password', 'forgot-password'],
  ['/refresh-token', 'refresh'],
];

export function createRateLimitMiddleware(limiter: RateLimitService) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.method !== 'POST' || !request.path.startsWith('/v1/auth/')) {
      next();
      return;
    }
    const route = AUTH_ROUTES.find(([prefix]) => request.path.includes(prefix))?.[1];
    if (!route) {
      next();
      return;
    }
    try {
      limiter.consume({ route, ip: request.ip });
      next();
    } catch (error) {
      next(error);
    }
  };
}
