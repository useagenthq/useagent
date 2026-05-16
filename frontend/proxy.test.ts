import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { proxy } from './proxy';

describe('authentication proxy', () => {
  test('redirects anonymous navigation to login', () => {
    const response = proxy(new NextRequest('https://skynet.example.com/agent/new'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://skynet.example.com/login');
  });

  test.each([
    '__Secure-better-auth.session_token',
    'better-auth.session_token',
  ])('allows navigation carrying %s', (name) => {
    const request = new NextRequest('https://skynet.example.com/agent/new', {
      headers: { cookie: `${name}=opaque-session-token` },
    });

    const response = proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
