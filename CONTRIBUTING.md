# Contributing to UseAgent

Thanks for helping. This page gets you from a fresh clone to a merged pull request.

## Pick an issue

- Browse [`good first issue`](https://github.com/useagenthq/useagent/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
  for something you can finish in a few hours, or
  [`hacktoberfest`](https://github.com/useagenthq/useagent/issues?q=is%3Aopen+label%3Ahacktoberfest)
  for the full Hacktoberfest list.
- Comment on the issue that you're taking it. If nobody has pushed anything after a week,
  the issue is open again.
- Something not listed? Open an issue first and describe the change, so we can agree on the
  shape before you write it.

## Set up

You need [bun](https://bun.sh) (never npm) and Postgres 16+ with
[pgvector](https://github.com/pgvector/pgvector). The README's
[Get started](README.md#get-started) section has the commands. Each package installs on its
own; there are no workspaces.

Most UI and backend work needs no sandbox or model key: the tests run against a throwaway
database and fakes. A real agent run needs a sandbox provider key (Daytona is the easiest)
and a model key; see the [setup guide](https://useagent.org/docs/getting-started/quickstart/).

## Before you open a pull request

Run what CI runs:

```bash
bun run typecheck                 # from the repo root, covers every package
cd backend && bun run test        # uses its own throwaway database
cd frontend && bun run test && bun run lint
```

- Keep a pull request to one change. Small pull requests get reviewed fast.
- Add or update a test for the behaviour you changed.
- Match the code around you. Read [`AGENTS.md`](AGENTS.md) and, for UI work,
  [`frontend/AGENTS.md`](frontend/AGENTS.md) first.
- User-visible text: plain words, no em dashes.
- Commit subjects in the imperative ("Add the Discord transport"), no `type(scope):` prefixes.

## Where things plug in

| You want to add | Start from |
|---|---|
| A messaging channel (Discord, Telegram, Teams) | [`backend/src/connectors/`](backend/src/connectors/): the `Transport` and `Renderer` contracts in `types.ts`, with `email/` as the worked example |
| A sandbox provider | [`packages/sandbox-contract`](packages/sandbox-contract) and the provider packages next to it; [`packages/conformance`](packages/conformance) is the acceptance suite |
| A UI component | [`frontend/components/base/`](frontend/components/base/), the shared kit; compose it rather than writing a new one |
| Docs | [`docs-site/`](docs-site/README.md) |

## Using AI tools

AI help is fine. Blind AI output is not.

- Understand every line you submit, run it yourself, and show it working in the app with your own screenshots or recording.
- Pull requests that look generated and untested are closed without a reply and labeled `spam`, so they don't count for Hacktoberfest. Signs we look for: no proof from a real run, code that ignores this repo's patterns or reinvents helpers that already exist, unrelated files changed, a description that only restates the issue, and failing checks nobody looked at.
- One pull request per issue, by the person who claimed it. Pull requests on issues someone else has taken, or several near-identical pull requests for the same bounty, count as farming.
- Bounties are paid only for the verified outcome the issue describes, never for a write-up, a plan, or an unfinished attempt.
- Answer review questions in your own words. If you can't explain your change, we can't merge it.

## Hacktoberfest

Merged, approved or `hacktoberfest-accepted` pull requests count. Pull requests that only
reformat, rename or add noise get the `spam` label and do not count.

## License and CLA

UseAgent is AGPL-3.0. By opening a pull request you agree to the
[Contributor License Agreement](CLA.md): you keep ownership of your work and grant the
maintainers the rights to ship it, including under commercial terms.

On your first pull request a bot asks you to sign the CLA: reply with the one line it
gives you. It records your signature on the `cla-signatures` branch of this repository,
so later pull requests pass without asking again. The bot matches commits to people by
their GitHub account, so commit with an email address that is on your GitHub profile.
It reads only the first 30 comments on a pull request; on a longer thread, ask a maintainer
to record your signature.
