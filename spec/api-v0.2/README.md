# API redesign v0.2 implementation contract

Requested 2026-09-11. Baseline: `0c5a5aeb29b1a11195cb74d562f00c5dd6edec15`.
This specification supersedes the old two-operation public API and schema-driven retrieval. The original v1 files remain unmodified for provenance and compatibility testing.

The bound client provides `read(state, options)`, `search(query, options)`, `inspect(ref, options)`, `write(content, options)`, and `edit(callback, options)`. Routine calls require neither classification labels nor manually assembled IDs, revisions, policy IDs, vector-space settings, or full budgets. Internal authorization, provenance, version, and space validation remain mandatory.

All operations share one Atom store, candidate provider, reference resolver, bidirectional traversal, and deterministic packer. Links preserve role, direction, multiplicity, sequence, and n-ary relations. Schema and role names never gate general retrieval. A local exact reference candidate provider ranks the inspected scope before truncating output; scan exhaustion is explicit. Lexical access remains enabled with embeddings, including newly committed unembedded revisions.

Read accepts context, visible thought, observations, and host-validated signals; it rejects empty signals, never answers the question or commits semantic changes, deduplicates evidence in actual serialized output, preserves distinct derived statements, includes required companion text or omits the claim, and avoids irrelevant padding. Cached signals are partitioned by authorization and encoder compatibility.

Every harness model step automatically refreshes a replaceable memory block. Original input, host instructions, working state, recent observations, and injected memory are separate. Retrieval never blindly reuses injected text as its next signal. Explicit tools are search, inspect, and draft editing, including exact cursor continuation. Full serialized model input, tool format, output reservation, and all automatic/explicit retrieval/model work share a finite run ledger. Fixed input cannot be silently truncated. Audit storage is bounded and expiring. Revocation invalidates retained state before subsequent model calls.

Opaque references resolve an observed immutable version and require current authorization. Normal links are logical; observed links are explicit. Draft revisions infer CAS from the reference. Callback execution is never retried. Draft references cannot escape an aborted overlay. Write uses unique event IDs; transport retries reuse a persisted operation identity, while independent equal text creates distinct sources.

Supersession is an authorized edit, never a natural-language or role-name inference. It validates competing successors, cycles, and reference availability. An exact old connected arrangement is retained as a paged immutable revision manifest, with explicit retention independent of cursor TTL. If bounded capture cannot finish, supersession cannot commit. Local v0.2 supports one-to-one succession; many-to-many is out of scope. Current retrieval and historical inspect remain distinct; independent viewpoints coexist.

Derived inputs include transitive generated inputs, source versions, range observations including empty queries, model configuration, and authorization. Stale representations regenerate only through an explicitly configured bounded generator, or fall back to permitted original/lower representations with pending diagnostics. Read-time generated caches are never silently published. Blob content has bounded range/cursor access.

Deliver implementation, public types, executable examples, migration, guide/api/runtime documentation, A01–A36 plus F regressions, documentation-extracted code checks, local scaling/quality measurements, and a real-service example. Compare no automatic read, history accumulation, and replacement using identical synthetic sources/model/budget. Record mock and real-model evidence separately. Missing service credentials mean real-model evaluation is explicitly unexecuted. No existing data deletion, npm publication, or site redeployment is authorized by this change.

P0: contracts, shared retrieval, automatic replacement harness, references and generic edits.
P1: integrated packing/dependencies/regeneration, retained succession, complete Writer flow.
P2: local measured retrieval/cost and concurrency evaluation. Distributed implementation and model-quality claims remain separate.
