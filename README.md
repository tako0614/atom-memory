# Atom Memory

One immutable Atom model for source material, extracts, collections, memberships, and derived memory. Bounded `read` and atomic `write`, with provenance, current authorization, and a shared agent/Writer harness.

[日本語ドキュメント](https://atom-memory.takos.jp) · [npm](https://www.npmjs.com/package/atom-memory) · [Design specification](spec/ARCHITECTURE.md)

```sh
npm install atom-memory
```

```js
import { AtomKernel, LocalAuthority, content, logical, defaultBudget } from 'atom-memory';

const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'host', readPolicies: ['notes'], writePolicies: ['notes'], canIngestSource: true,
});
const memory = new AtomKernel({ authority });
await memory.write({
  idempotencyKey: 'hello', guards: [],
  revisions: [{ atomId: 'note', revisionId: 'note:1', expectedHead: null,
    content: content('source', 'Membership is an independent Atom.', 'notes') }],
}, auth);
const result = await memory.read({
  selector: { kind: 'refs', refs: [logical('note')] },
  context: { requestedPolicyIds: ['notes'], consistency: { mode: 'snapshot' } },
  budget: defaultBudget, render: 'evidence',
}, auth);
console.log(result.contextPack.serialized);
```

Node.js >=22.13; ESM and TypeScript declarations. No runtime dependencies. Use `SqliteStorage` from `atom-memory/sqlite` for local durability. Keep `LocalAuthority`, the kernel administration methods, and storage private to the trusted host.

This is the local reference implementation of the supplied final v1 design, released as **0.1.0**. It includes in-memory and SQLite adapters and host-provided model/embedding/tokenizer interfaces. Distributed storage, ANN, real-model quality, and scaling claims require separate implementation and evaluation. The default tokenizer counts UTF-8 byte tokens; supply the actual model tokenizer for model token accounting.

```sh
npm ci
npm run check
npm run example
```

See [acceptance coverage](docs/acceptance.md), [adapters](docs/adapters.md), and [release instructions](docs/release.md). The original ZIP files are preserved unchanged in `spec/`.

MIT License.
