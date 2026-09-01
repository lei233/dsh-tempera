# dsh-tempera

English | [简体中文](README.zh-CN.md)

Tempering delegated work into trusted outcomes.

`dsh-tempera` is intended to become a durable Task Manager for delegated work,
using [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
as its pluggable Harness kernel. Tempera owns the lifecycle of work; execution
capabilities belong to the Harness. Execution authority and acceptance authority
remain separate.

## Current status

This repository contains **only an engineering skeleton**: a two-package workspace,
build and checking tools, and CI. Both source entrypoints are empty modules.
There are no Task management features, public business APIs, DSH integrations,
providers, persistence implementations, or business tests yet. Nothing is configured
for publication.

## Repository layout

```text
packages/
  domain/       @dsh-tempera/domain — reserved for Task semantics and invariants
  runtime/      @dsh-tempera/runtime — reserved for Task Manager coordination
docs/           Architecture and domain design documentation
```

All packages are private and versioned `0.0.0`. They currently have no dependencies
on each other. The future dependency direction may be `runtime → domain`, never
`domain → runtime`. The domain must remain independent of DSH, concrete providers,
storage backends, and Node.js globals; its TypeScript configuration does not
automatically include Node.js types.

## Architecture

The current implementation baseline is documented in:

- [Architecture overview](docs/architecture.md)
- [Domain model](docs/domain.md)
- [Lifecycle and continuation](docs/lifecycle.md)
- [Durability and recovery](docs/durability.md)
- [DSH capability seams](docs/capability-seams.md)
- [MVP scope](docs/mvp.md)

The central boundary is: **Task Domain is the product core; DSH is the Harness kernel.**
Tempera owns durable work lifecycle and authority, while DSH-native services and
providers supply execution, artifact, workspace, and effect capabilities.

## Development environment

- Node.js support range: `^22.19.0 || >=24.0.0`.
- Development and CI baseline: **Node.js 22.23.1**, recorded in `.nvmrc`.
- Package manager: **pnpm 9.15.4**, recorded in `packageManager`.

With nvm installed, select the development version:

```sh
nvm install
nvm use
```

Ensure `pnpm --version` reports `9.15.4`, then install dependencies:

```sh
pnpm install --frozen-lockfile
```

Development tools are declared in the root package with compatible version ranges.
The committed `pnpm-lock.yaml` fixes the resolved versions. Frozen installation
fails rather than changing an out-of-date lockfile. Only Node.js 22.23.1 is used
for the initial validation and CI; the broader declared range is not a tested
version matrix yet.

## Commands

Run these commands at the repository root:

| Command              | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `pnpm build`         | Build both packages with tsdown                                           |
| `pnpm typecheck`     | Check tool configurations and both packages with TypeScript               |
| `pnpm lint`          | Run Oxlint correctness checks                                             |
| `pnpm lint:fix`      | Apply Oxlint automatic fixes                                              |
| `pnpm format`        | Format files using Oxfmt defaults                                         |
| `pnpm format:check`  | Check formatting without rewriting files                                  |
| `pnpm test`          | Run Vitest once in the Node environment                                   |
| `pnpm test:watch`    | Run Vitest in watch mode                                                  |
| `pnpm check:exports` | Load both packages through their package names; build first               |
| `pnpm check`         | Run lint, formatting checks, type checks, tests, build, and export checks |

Each package supports independent checks and builds:

```sh
pnpm --filter @dsh-tempera/domain typecheck
pnpm --filter @dsh-tempera/domain build
pnpm --filter @dsh-tempera/runtime typecheck
pnpm --filter @dsh-tempera/runtime build
```

TypeScript uses strict mode, ESM, and NodeNext resolution. tsdown emits only ESM,
without minification, to each package's `dist/index.js`, alongside `dist/index.d.ts`.
Package exports point to these generated files. Build output is not committed.

Vitest is configured, but **there are no test files yet**. Tests will be discovered
under `packages/*/src/**/*.test.ts` and `packages/*/tests/**/*.test.ts`. An empty test
run currently exits successfully and reports that no test files were found; this
does not demonstrate business correctness. Remove the no-tests allowance when
business tests are introduced.

Formatting excludes local handoff material, dependencies, generated output,
caches, coverage files, and the generated lockfile. EditorConfig standardizes
UTF-8, LF, two-space indentation, and a final newline. No Git hooks are installed.

## Development guidelines

All commits must follow
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

## Continuous integration

GitHub Actions runs on pushes and pull requests using Ubuntu, Node.js 22.23.1,
and pnpm 9.15.4 with read-only repository permissions. It performs frozen-lockfile
installation, lint, formatting checks, type checks, tests, package builds, and
package export loading. It does not publish or deploy anything.