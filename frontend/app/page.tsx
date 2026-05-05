import { redirect } from 'next/navigation';

/**
 * Home is a temporary redirect to the Agent → Active runs surface.
 *
 * NOTE: the Chat agent will own the real home (`/`) later — replace this
 * redirect with the chat landing when that lands. The AlignUI foundation
 * showcase that previously lived here now lives at `/foundation`.
 */
export default function Home() {
  redirect('/agent/runs');
}
