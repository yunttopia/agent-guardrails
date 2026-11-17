# agent-guardrails

Guardrail building blocks for tool-using LLM agents, extracted from a larger desktop agent and released on their own.

The pieces are small and independent. Use the ones you need:

| Module | What it does |
|---|---|
| `model/` | Streaming model adapter on top of the Vercel AI SDK (Anthropic, OpenAI, Google) that **reserves budget before every call** and settles the real cost afterwards. Retries only before the first output token. Real providers are **off by default**. Includes routing (mode → model/effort), integer price tables, a TSV cost ledger and a scriptable fake model for tests. |
| `model/guarded-fetch` | `fetch` wrapper with a host allowlist, https only, fixed User-Agent, header allowlist, credential stripping on cross-host redirects, and logging that records only host/status/size. |
| `queue/budget` | SQLite budget store: per-day and per-month caps, reservations, settle/release. No cap configured means **no call**. |
| `log/writer` | Append-only, hash-chained JSONL event log per task (each event carries `prev_hash`). Recovers a torn last line, refuses corruption elsewhere. |
| `queue/store` | Durable task queue: explicit state machine, leases, priority and not-before scheduling, a single browser slot. Every transition is logged. |
| `queue/steps` | Step journal for tool calls (`started → committed / failed / unknown`). It records which calls ended with an unknown outcome so the caller can refuse to retry them. Rebuildable from the event log. |
| `gate/` | Risk ranks (`none < irreversible < outbound < money_out`) with a check that a plan step never declares less risk than its tool (tools missing from your risk table count as the highest risk), duplicate step-id detection, and HMAC-signed **approval tokens** bound to a task, plan hash and action, with expiry rules. `verifyToken` checks the MAC (constant time), expiry and binding. `queue/approvals` stores tokens; its `consume(tokenId, check)` verifies first and counts a use only while the token is unrevoked and has uses left. |
| `db` | SQLite schema and transactions (nested savepoints, after-commit hooks). Production databases are encrypted with SQLCipher (`better-sqlite3-multiple-ciphers`); tests use `node:sqlite` in memory. |

## Why

An agent that can send messages or move money needs a few boring guarantees more than it needs a clever prompt:

- it cannot spend more than you allowed, even when a provider retries;
- every action it took is in a log that cannot be edited quietly;
- an action whose result is unknown (timeout, crash) is not repeated automatically;
- outbound actions need a token that a person (or, from delegation stage 2 up, a rule you wrote) issued for exactly that task, plan and action.

These modules implement those guarantees with plain SQLite and files, without a server.

## Install

Requires Node.js 24 or newer (uses `node:sqlite` for in-memory and test databases).

Not published to npm yet. Clone and build:

```sh
git clone https://github.com/yunttopia/agent-guardrails && cd agent-guardrails && npm ci && npm run build
```

## Example: a budget-capped model call

```ts
import { openMemoryDb, SqliteBudgetStore } from "@yunttopia/agent-guardrails";
import { createFakeLanguageModel, createMemoryLedger, createModelAdapter, createModelResolver, FAKE_PRICE_TABLE, PriceBook } from "@yunttopia/agent-guardrails/model";

const db = openMemoryDb();                                     // use openCoreDb(path, key32) for an encrypted file
const budget = new SqliteBudgetStore(db);
budget.setCap({ scope: "day", id: "default" }, 3_000_000);    // amounts are in 1/1000 KRW: KRW 3,000 per day
budget.setCap({ scope: "month", id: "default" }, 30_000_000); // KRW 30,000 per month

const model = createModelAdapter({
  budget,
  ledger: createMemoryLedger(),                                // or createFileLedger("costs.tsv")
  prices: new PriceBook([FAKE_PRICE_TABLE]),
  resolveModel: createModelResolver({ fakes: { "fake-1": createFakeLanguageModel([{ kind: "reply", parts: [{ text: "hello" }] }]) } }),
});

for await (const ev of model.stream({
  model: { provider: "fake", model: "fake-1", effort: null },
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "hi" }],
  tools: [], taskId: "app", attemptId: "app", maxOutputTokens: 1000, purpose: "worker_turn",
}, new AbortController().signal)) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
  if (ev.type === "finish") console.log("\n", ev.reason, ev.cost.cost_mkrw);
}
```

Plans passed to the gate checks have the shape `{ items: [{ steps: [{ step_id, tool, risk }] }] }`. Approval keys must be at least 32 bytes (hex).

To call a real provider, pass `real: { enabled: true, secrets: { get: async (name) => process.env[name] ?? null } }` to `createModelResolver` and load a price table from `data/prices/` (shipped in the package). Secrets are read only through that `SecretSource`; keys from environment variables are never picked up implicitly.

## Development

```sh
npm install
npm run build
npm run typecheck
npm test
```

## Limits

- **Currency.** Budgets and costs are integers in 1/1000 KRW, converted from USD prices with a fixed rate unless you pass one. Other currencies are not supported.
- **Time zone.** Day/month budget periods and task ids use Asia/Seoul (UTC+9); the budget day rolls over at 04:00 local time.
- **Prices and routing in `data/` are example values**, a snapshot from the original project (late 2026). Check current provider pricing and model names before relying on them.
- **No agent loop is included.** This package gives you the storage, budget, log and approval pieces; planning, tool execution, enforcing that every outbound call presents a consumed token, and UI are yours.
- **Approval tokens** cover a fixed list of actions (`message.send`, `form.submit_outbound`, `refund.submit`, `transfer.submit`, `payment.request`, `booking.reserve`). Change `ACTION_RISK` in `src/gate/mint-token.ts` for your own actions.
- **Token `bind` values** (amount, account/recipient fingerprints, draft hash, target) are covered by the signature but `verifyToken` does not compare them with the action you are about to run; check them yourself before executing.
- Not audited. Treat it as a starting point and review it for your threat model.

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
