# Atom Memory

One Atom model for content, descriptions and roleful relationships. An authenticated client provides `read`, `search`, `inspect`, `write` and `edit`, with automatic IDs, observed references, provenance and finite budgets.

**v0.2.0 introduces the new client API.** Upgrading from v0.1 requires the [migration steps](docs/migration.md).

```sh
npm install atom-memory@0.2.0
```

To verify this repository and run its examples:

```sh
npm ci
npm run check
npm run example
npm run example:writer
```

Host setup is in [the executable example](examples/basic.mjs). Once a client is bound:

```ts
const fact = await memory.write('旧クライアントは旧APIを利用している');
const group = await memory.write('旧クライアントの認証に関する情報');
await memory.write({
  text: 'このまとまりに、この情報が含まれる',
  links: { group: group.ref, member: fact.ref },
});
const page = await memory.search('旧クライアントの認証', { limit: 10 });
if (page.items[0]) await memory.inspect(page.items[0].ref, { depth: 1 });
const recalled = await memory.read({ context: '旧クライアントの認証' }, { tokens: 4096 });
await memory.edit((draft) => draft.revise(fact.ref, '訂正された本文'));
```

`MemoryHarness` (`AgentHarness`) automatically replaces the memory block before every model call. Explicit tools search, inspect and edit through the same store and retrieval engine. `AtomKernel` remains a low-level API; the old harness is `LegacyAgentHarness`.

Node.js >=22.13, ESM, TypeScript declarations, no runtime package dependencies. Memory and SQLite implement local synchronous storage transactions; the asynchronous client does not imply distributed storage support. The exact lexical/vector candidate provider ranks the whole scanned scope, reports scan limits and keeps lexical access while embeddings are pending. It is a local reference implementation, not ANN.

See [guide](docs/guide.md), [API](docs/api.md), [runtime](docs/runtime.md), [migration](docs/migration.md), [acceptance](docs/acceptance.md), and [verification record](validation/README.md). [The llama.cpp example](examples/llama-cpp.mjs) is an actual model adapter with token counting, bounded calls and cancellation. Deterministic tests do not establish model quality; the real-model run is explicitly recorded separately.

The historical v1 specification remains unchanged in `spec/`. The [v0.2 requirements](spec/api-v0.2/README.md) supersede its two-operation API and schema-driven retrieval. MIT License.
