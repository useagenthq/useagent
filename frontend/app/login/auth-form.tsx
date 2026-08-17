'use client';

import { OrbitKnotMark } from "@/components/foundations/brand/orbit-knot-mark";
import { RiLockLine, RiMailLine, RiUserLine } from '@remixicon/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ComponentType, type FormEvent, useId, useState } from 'react';

import { GoogleSignInButton } from '@/components/auth/google-sign-in-button';
import * as Input from '@/components/ui/input';
import * as Label from '@/components/ui/label';
import { backendFetch } from '@/lib/backend-fetch';
import { useAuthConfig } from '@/lib/auth';
import { cnExt } from '@/utils/cn';

type AuthMode = 'signin' | 'signup';

type IconComponent = ComponentType<{ className?: string }>;

const COPY: Record<
  AuthMode,
  {
    title: string;
    subtitle: string;
    submit: string;
    pending: string;
    swapPrompt: string;
    swapLabel: string;
    swapHref: string;
    endpoint: string;
  }
> = {
  signin: {
    title: 'Welcome back',
    subtitle: 'Sign in to your skynet-a workspace',
    submit: 'Sign in',
    pending: 'Signing in…',
    swapPrompt: 'New to skynet-a?',
    swapLabel: 'Create an account',
    swapHref: '/signup',
    endpoint: '/api/auth/sign-in/email',
  },
  signup: {
    title: 'Create your skynet-a account',
    subtitle: 'Start building with your autonomous engineer',
    submit: 'Create account',
    pending: 'Creating account…',
    swapPrompt: 'Already have an account?',
    swapLabel: 'Sign in',
    swapHref: '/login',
    endpoint: '/api/auth/sign-up/email',
  },
};

/** Full-width dark pill submit. */
const SUBMIT_PILL =
  'inline-flex h-11 w-full items-center justify-center rounded-full bg-bg-strong-950 text-label-sm text-text-white-0 shadow-regular-xs outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary-base focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

function Field({
  label,
  icon,
  ...inputProps
}: {
  label: string;
  icon: IconComponent;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>) {
  const id = useId();
  return (
    <div className='flex flex-col gap-1.5'>
      <Label.Root htmlFor={id}>{label}</Label.Root>
      <Input.Root>
        <Input.Wrapper>
          <Input.Icon as={icon} />
          <Input.Input id={id} {...inputProps} />
        </Input.Wrapper>
      </Input.Root>
    </div>
  );
}

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const copy = COPY[mode];
  const authConfig = useAuthConfig();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);

    const body =
      mode === 'signup' ? { name, email, password } : { email, password };

    try {
      const res = await backendFetch(copy.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        setError(
          data?.message ?? 'Something went wrong. Please try again.',
        );
        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      // Network failure / backend down — keep the page usable, surface inline.
      setError("Couldn't reach the server. Please try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className='flex min-h-dvh w-full items-center justify-center bg-bg-weak-50 p-4 sm:p-6'>
      <div className='animate-ai-fade-up mx-auto flex w-full max-w-[420px] flex-col rounded-2xl border border-stroke-soft-200 bg-bg-white-0 px-6 py-10 shadow-regular-md sm:px-8'>
        <OrbitKnotMark className='size-8' />
        <h1 className='mt-5 text-display-sm text-text-strong-950'>{copy.title}</h1>
        <p className='mt-1.5 text-paragraph-sm text-text-sub-600'>
          {copy.subtitle}
        </p>

        <div className='mt-8'>
          <GoogleSignInButton enabled={authConfig?.google ?? false} />
        </div>

        <div className='my-6 flex items-center gap-3' aria-hidden>
          <span className='h-px flex-1 bg-stroke-soft-200' />
          <span className='text-mono-label text-text-soft-400'>or</span>
          <span className='h-px flex-1 bg-stroke-soft-200' />
        </div>

        <form
          className='flex flex-col gap-4'
          onSubmit={handleSubmit}
          noValidate
        >
          {mode === 'signup' && (
            <Field
              label='Name'
              icon={RiUserLine}
              placeholder='Ada Lovelace'
              autoComplete='name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          )}
          <Field
            label='Email'
            icon={RiMailLine}
            type='email'
            placeholder='you@company.com'
            autoComplete='email'
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Field
            label='Password'
            icon={RiLockLine}
            type='password'
            placeholder='••••••••'
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          {error && (
            <p role='alert' className='text-paragraph-sm text-error-base'>
              {error}
            </p>
          )}

          <button
            type='submit'
            className={cnExt(SUBMIT_PILL, 'mt-2')}
            disabled={pending}
          >
            {pending ? copy.pending : copy.submit}
          </button>
        </form>

        <p className='mt-6 text-center text-paragraph-sm text-text-sub-600'>
          {copy.swapPrompt}{' '}
          <Link
            href={copy.swapHref}
            className='text-label-sm text-text-strong-950 underline-offset-2 hover:underline'
          >
            {copy.swapLabel}
          </Link>
        </p>
      </div>
    </main>
  );
}
