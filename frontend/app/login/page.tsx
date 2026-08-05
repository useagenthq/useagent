import type { Metadata } from 'next';

import { AuthForm } from './auth-form';

export const metadata: Metadata = {
  title: 'Sign in — skynet-a',
  description: 'Sign in to your skynet-a workspace.',
};

export default function LoginPage() {
  return <AuthForm mode='signin' />;
}
