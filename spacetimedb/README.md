# Sightline SpacetimeDB module

Pinned to **SpacetimeDB 2.14.1** (module, generated bindings and official CLI).
The application server is the only trusted reader/writer. Every raw table is
private; the public `*_view` names return rows only to an identity that has
claimed the backend.

## Local tooling (no root)

Official 2.14.1 Linux CLI archive (S3 mirror used by the official installer):

```sh
mkdir -p .tools "$HOME/tmp/sightline-tools"
curl -fL \
  https://spacetimedb-client-binaries.s3.amazonaws.com/refs/tags/v2.14.1/spacetime-x86_64-unknown-linux-gnu.tar.gz \
  -o "$HOME/tmp/sightline-tools/spacetime-2.14.1.tar.gz"
tar -xzf "$HOME/tmp/sightline-tools/spacetime-2.14.1.tar.gz" -C .tools
chmod +x .tools/spacetimedb-cli
.tools/spacetimedb-cli --version   # spacetimedb tool version 2.14.1
```

The archive also contains `spacetimedb-standalone`; the application does not use
it. Alternatively install through `https://install.spacetimedb.com`, but keep
the CLI at 2.14.1 so generated bindings stay in lockstep with the host.

## Server

The host must also be 2.14.1. The repository runtime uses the official image on
loopback:

```sh
bun run db:start
```

The helper uses a named volume mounted at `/data` and starts the image with
`--user 0:0` to initialize that volume. This is root inside the container, not
a host-root command. Do not use `spacetime dev`: it would publish and replace
the database behind the application server's back.

## Build, generate, publish

Run from the repository root:

```sh
.tools/spacetimedb-cli build --module-path spacetimedb
.tools/spacetimedb-cli generate --lang typescript \
  --out-dir spacetimedb/bindings --module-path spacetimedb --yes
.tools/spacetimedb-cli publish sightline \
  --server http://127.0.0.1:3000 --module-path spacetimedb --yes
```

`src/backend.ts` imports the checked-in `bindings/`. Regenerate and republish
after changing table columns, reducers or views. If a new column is added to a
published database, give it a default (for example
`t.string().default('')`) so automatic migration can backfill existing rows.

The module's own package uses TypeScript 5.9.3 for `spacetime build`; do not run
package-level Prettier. Repository formatting/linting owns the source style.

## Backend identity (bootstrap)

The first `createBackend()` connection calls `claim_backend`, then writes the
SpacetimeDB token to `$DATA_DIR/spacetime-token` (default
`./data/spacetime-token`, mode 0600). Server and smoke processes must share
`DATA_DIR` (or an explicit `SPACETIME_TOKEN`) so they reuse one trusted identity.
Two processes starting with no token at the same instant are handled by a short
shared-token retry, but starting the server before the smoke process is simpler.

Optional hardening: publish with a private `BACKEND_TOKEN` environment value and
run every backend process with the same `BACKEND_TOKEN`; the first claim then
requires it. Without it, the first local backend wins the trust-on-first-use
claim. Never expose the token in browser code or reports.

## Scenarios

- `shop` seeds clean stock 5 / "In stock" or defect stock 0 / "Out of stock".
- `portal` seeds clean "All systems normal" or defect "Planned maintenance in progress".
- Every run inserts a one-shot transition due **10,000 ms** after creation. It
  updates the world revision and appends a durable `world` evidence event in the
  same transaction; `world_transition_view` exposes `requestedAt`,
  `scheduledFor` (due), `executedAt`, `status`, `detail`. A terminal run marks
  the transition `skipped` instead of mutating the frozen world. An overdue
  pending transition (due + 15 s) is marked `failed` and records an `error`
  evidence event; there is no retry queue.
- World actions: `search`, `select`, `variant`, `addToCart`, `checkout`,
  `panel`, `closePanel`, `schedule`. Values and IDs are validated in the module;
  world actions and evidence writes reject terminal runs. `acknowledge_world`
  ignores late render acknowledgements on terminal runs.
