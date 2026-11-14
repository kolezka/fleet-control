# Source layout

The code is split by what a module is allowed to know. Three programs live under `src/`, and each keeps its own layers next to its entry points.

| Program | Directory | Storage |
| --- | --- | --- |
| Host service and client gateway | `src/` | SQLite |
| Central server | `src/central/` | PostgreSQL |
| Host agent and cooperative adapter | `src/host-agent/` | SQLite |

## Layers

Each program has the same three layers.

- `domain/`: types, error classes, limits, validators and state-transition tables. No queries, no HTTP, no MCP, no file or process access. A domain module imports only other domain modules.
- `data/`: stores. Each one owns its tables and is the only place that runs queries against them. A data module imports domain modules, other data modules, `bun`, `bun:sqlite` and `node:` built-ins. It does not import servers, routes or MCP code.
- Everything else in the program directory is transport and wiring: HTTP servers, routes, MCP tools, WebSocket registries, credential parsing and the process entry points. These modules call stores and never run a query themselves.

Dependencies point one way: transport depends on data, data depends on domain. `src/central` and `src/host-agent` may use `src/domain` (the agent wire protocol and command rules are shared), but `src/domain` never imports from them.

## Where things are

| Path | Contents |
| --- | --- |
| `src/domain/` | Command and request types and rules, session record, send result classification, agent wire protocol, model label parsing |
| `src/data/` | `Store` (opens the SQLite file and holds session records), `Commands`, `Requests` |
| `src/central/domain/` | Central command, attempt, identity and cooperative lifecycle types and rules, and the `authorize` scope check |
| `src/central/data/` | Central stores, the fresh-schema provisioner and the schema guard (PostgreSQL) |
| `src/central/test-fixtures/` | Helpers used only by tests |
| `src/host-agent/domain/` | Delivery attempt and receipt types |
| `src/host-agent/data/` | Journal, outbox and executor lease (SQLite) |
| `src/fleet/`, `src/observe/`, `src/terminal/`, `src/install/` | Adapters to the fleet CLI, Claude Code session files, the terminal viewer and the installer |
| `web/` | The browser page |
| `scripts/`, `deploy/` | Operational scripts and deployment files |

Tests sit beside the module they cover and move with it.

## Entry points keep their paths

Deployment files, the installer and several tests start these files by path, so they stay where they are:

- `index.ts`, `client.ts`, `fleet-control.ts`
- `src/central/cooperative-service.ts`, `src/central/cooperative-main.ts`, `src/central/main.ts`, `src/central/identity-cli.ts`
- `src/host-agent/cooperative-main.ts`

Moving one means changing `deploy/cooperative/`, `src/install/plan.ts` and any installed service in the same change.

## Adding code

- A new type, limit, validator or transition rule goes in `domain/`.
- A new table or query goes in a store in `data/`. Give the store a method; do not hand the database client to a route.
- A new endpoint or tool goes in the program directory and calls a store.
- A type that names a database client or transaction (for example a guard callback that receives a transaction) belongs in `data/`, not `domain/`.

## Enforcement

`src/layering.test.ts` fails when a domain module imports anything outside `domain/`, when a data module imports transport code, or when a tagged query or SQLite call appears outside `data/`. It reads import lines and query syntax, so it does not catch a query built some other way.

Two test fixtures replace modules by file path: `src/central/test-fixtures/central-shutdown-preload.ts` and `legacy-central-shutdown-preload.ts`. If a module they name moves, update the path there too. The type checker does not see this; the shutdown tests do.

## Known gaps

- The central entry points (`src/central/main.ts`, `cooperative-main.ts`, `cooperative-service.ts`, `identity-cli.ts`) build the PostgreSQL client themselves and pass it to the stores. `index.ts` takes the SQLite handle from `Store` and passes it to `Commands` and `Requests`.
- `src/central/data/requests.ts` and `src/central/data/commands.ts` take guard callbacks from the MCP layer. The callback type lives in `data/`, and the callback body runs inside the store's transaction.
- `src/server.ts`, `src/mcp.ts`, `src/central/server.ts` and `src/central/mcp.ts` mix request parsing with use-case logic. There is no separate application layer yet.
