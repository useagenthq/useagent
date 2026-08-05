import type { Metadata } from 'next';

import { AuthForm } from '../login/auth-form';

export const metadata: Metadata = {
  title: 'Create account — skynet-a',
  description: 'Create your skynet-a account.',
};

export default function SignupPage() {
  return <AuthForm mode='signup' />;
}
