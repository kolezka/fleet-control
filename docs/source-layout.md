# Source layout

The code is split by what a module is allowed to know. Three programs live under `src/`, and each keeps its own layers next to its entry points.

| Program | Directory | Storage |
| --- | --- | --- |
| Host service and client gateway | `src/` | SQLite |
| Central server | `src/central/` | PostgreSQL |
| Host agent and cooperative adapter | `src/host-agent/` | SQLite |

## Layers

Each program has the same four layers.

- `domain/`: types, error classes, limits, validators and state-transition tables. No queries, no HTTP, no MCP, no file or process access. A domain module imports only other domain modules.
- `data/`: stores. Each one owns its tables and is the only place that runs queries against them. A data module imports domain modules, other data modules, `bun`, `bun:sqlite` and `node:` built-ins. It does not import servers, routes or MCP code.
- `application/`: use cases. One function per thing a caller can ask for: submit and deliver a command, list sessions with their model state, read a command as an operator or as a supervisor, answer a request. This is where the caller's role decides which store method runs, where an authenticated caller replaces a name given in the request, and where the owner of a run is built. An application module imports domain, data and other application modules and `node:` built-ins. It knows nothing about HTTP, MCP, Hono or zod, and it does not import `bun` or run a query.
- Everything else in the program directory is transport and wiring: HTTP servers, routes, MCP tools, WebSocket registries, credential parsing and the process entry points. These modules parse and bound the request, authenticate it, call a use case, and shape the reply and its error text. They never run a query themselves. Outside the entry points they import data modules only as types, to name what they are handed.

Dependencies point one way: transport depends on application, application on data, data on domain. Routes and tools go through a use case even when it is one store call, so a rule added later has one place to live. `src/central` and `src/host-agent` may use `src/domain` (the agent wire protocol and command rules are shared), but `src/domain` never imports from them.

## Where things are

| Path | Contents |
| --- | --- |
| `src/domain/` | Command and request types and rules, session record, send result classification, agent wire protocol, model label parsing |
| `src/data/` | `Store` (opens the SQLite file and holds session records), `Commands`, `Requests` |
| `src/application/` | `Deliverer` (one delivery at a time), command submit, deliver, read, respond and report, request operations, session listing with model state |
| `src/central/domain/` | Central command, attempt, identity and cooperative lifecycle types and rules, and the `authorize` scope check |
| `src/central/data/` | Central stores, the supervisor identity fence, the fresh-schema provisioner and the schema guard (PostgreSQL) |
| `src/central/application/` | Role-scoped command access, operator and supervisor request operations, cooperative claim and report with the secret refusal, operator inspection, assertions and settlement |
| `src/central/test-fixtures/` | Helpers used only by tests |
| `src/host-agent/domain/` | Delivery attempt and receipt types |
| `src/host-agent/data/` | Journal, outbox and executor lease (SQLite) |
| `src/host-agent/application/` | `DeliveryExecutor` (journals one delivery attempt and classifies its outcome). Parked by owner decision: no runtime starts it |
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
- A rule about who may do what, or a step that joins two stores or a store and a sender, goes in `application/`. Take stores and ports as arguments; return plain values and throw plain errors.
- A new endpoint or tool goes in the program directory. It parses the input, calls a use case, and turns the result into a response. Central routes read a request body with `readBoundedBody` or `readBoundedJson` from `src/central/http-body.ts`. If two transports need the same rule, the rule belongs in `application/` or `domain/`, not in both files.
- A port (an interface the use case needs, such as `FleetReader`, `Sender` or `ModelObserver`) is declared in `domain/`. The adapter that implements it lives in `src/fleet/`, `src/observe/` or next to the entry point.
- A type that names a database client or transaction (for example a guard callback that receives a transaction) belongs in `data/`, not `domain/`.

## Enforcement

`src/layering.test.ts` fails when a domain module imports anything outside `domain/`, when a data module imports application or transport code, when an application module imports transport code or any package other than `node:` built-ins, or when a tagged query or SQLite call appears outside `data/`. It also fails when a module outside the layers, other than a central entry point, imports a data module as a value, and when `src/server.ts` or `src/mcp.ts` imports a data module at all. It reads import lines and query syntax, so it does not catch a query built some other way.

Two test fixtures replace modules by file path: `src/central/test-fixtures/central-shutdown-preload.ts` and `legacy-central-shutdown-preload.ts`. If a module they name moves, update the path there too. The type checker does not see this; the shutdown tests do.

## Composition

The entry points wire the program together. `index.ts` opens the SQLite store and builds `Commands`, `Requests`, the sender and `Deliverer`. The central entry points (`src/central/main.ts`, `cooperative-main.ts`, `cooperative-service.ts`, `identity-cli.ts`) build the PostgreSQL client and pass it to the stores. Application and domain modules open no database and read no environment variable; they get stores and ports as arguments. The SQLite stores open their own file from a path they are given, and the adapters in `src/fleet/`, `src/observe/` and `src/terminal/` pass the process environment on to the commands they start.

## Guards run inside the store transaction

A supervisor's command reads and writes, and its request writes, must hold the lock on its identity row in the same transaction as the work. Otherwise a retirement could commit between the check and the write. So the stores in `src/central/data/commands.ts` and `src/central/data/requests.ts` take a guard callback and call it at the start of their transaction. This is deliberate and stays.

The guard is built by `identityFence` in `src/central/data/identity-fence.ts`, in the data layer, because it handles a transaction. The application layer asks for a fence and passes its parts to the store; it never sees the transaction. The fence refuses a scope that is not the identity's own host and session, then locks the identity through the registry.

## Known gaps

- `DeliveryExecutor` in `src/host-agent/application/`, the journal, outbox and executor lease in `src/host-agent/data/`, `src/host-agent/client.ts`, `src/central/data/attempts.ts` and the dispatch half of `src/central/agent-sockets.ts` are used only by tests. Starting them means central pushing text into terminals, which the cooperative pull design replaced. On 2026-11-15 the owner chose to keep them parked: not wired and not removed. `src/parked-push-path.test.ts` fails if a runtime module imports one of them or calls `dispatch` on the socket registry. Three things are missing before the path could run: the dispatch message carries no runtime instance ID although the executor requires one, nothing stops a second sender or process on the same target, and live terminal input needs the owner's authorization. See "Executor isolation is not established" in [central server status](central-server-status.md).
- The central transports still name store types in their dependency lists (`Pick<Store, method>`), so a test can inject a fake. A set of port types in `domain/` would remove those type imports; nothing depends on it today.
- `src/client-gateway.ts` and `src/host-agent/cooperative-adapter.ts` have their own bounded readers. They are different contracts (one returns null over the limit, one takes an abort signal and a deadline) and belong to other programs.
