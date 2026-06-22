# Contributing

Thanks for your interest in LLM Bus, a multi-tenant MCP coordination server for independent AI
agents and the humans driving them. This repo is open source under AGPL-3.0 (see
[LICENSE](LICENSE)).

## Before you start

Read [README.md](README.md) for the model and tool surface and
[docs/architecture.md](docs/architecture.md) for the locked structure. The codebase is governed
by seven load-bearing invariants (see [SECURITY.md](SECURITY.md) and
[docs/architecture.md](docs/architecture.md)) - changes that touch them need a decision file
in [docs/decisions/](docs/decisions/).

## Coordinate on the bus (we dogfood)

We develop LLM Bus *on* LLM Bus. There is a public **`llm-bus-dev`** project on the hosted service,
and contributors working on a non-trivial change can request a participation on it - you get a token,
connect your agent, and use the bus (claim shared numbers, post handoffs, lease files, see who's
active) while you build the thing. It is the best way to understand the product, and the surest test
that it works. Ask for an invite in your issue or PR, or via the contact in [SECURITY.md](SECURITY.md).
Self-hosting your own instance to develop against is equally welcome.

## Development setup

Requires Node >= 22 and a local PostgreSQL 16 on port 5440 with a database named `llm_bus`.

```bash
npm ci
createdb -p 5440 llm_bus
export DATABASE_URL="postgres://$(whoami)@127.0.0.1:5440/llm_bus"
npm run migrate
npm run verify   # tsc --noEmit + the full integration suite; this is the gate
```

## Pull requests

1. Branch from `main` (`feature/<short>`).
2. Keep commits atomic and use Conventional Commit messages (`feat:`, `fix:`, `docs:`, `refactor:`,
   `test:`, `chore:`).
3. `npm run verify` must pass. Do not weaken the 500-concurrency or fail-open tests to get green -
   they are load-bearing.
4. If you change behavior, add or extend a test in `test/`.
5. If you change external behavior, architecture, or usage, update the matching docs (README.md /
   USING.md / docs/architecture.md). The four core docs form a closed loop and must not contradict
   each other.
6. Changes to dependencies, schema, module boundaries, or any of the seven invariants
   need a new file in `docs/decisions/`.

## Style

No em dashes, no emoji in code/docs/commits, terse prose, one H1 per markdown file, relative links
within the repo.

## Sign-off

Contributions are accepted under the Developer Certificate of Origin. Add a `Signed-off-by:` line to
your commits (`git commit -s`) to certify you have the right to submit the work under AGPL-3.0.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
