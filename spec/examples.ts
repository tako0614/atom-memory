/** Compile-only examples. No server, model, storage or validator is implemented. */
import type { AtomContent, ProposedRevision, Slot, WriteRequest } from './contracts';

const group: AtomContent = {
  schema: 'collection', state: 'active',
  body: { kind: 'inline', value: { form: 'set', title: '内容上のまとまりP' } },
  slots: [], origins: [], policyId: 'policy:demo',
  provenance: { kind: 'organization', producerId: 'writer:demo' },
};

function membership(groupId: string, memberId: string): AtomContent {
  return {
    schema: 'membership', state: 'active',
    body: { kind: 'inline', value: null },
    slots: [
      { role: 'group', mode: 'refer', target: { kind: 'logical', atomId: groupId } },
      { role: 'member', mode: 'refer', target: { kind: 'logical', atomId: memberId } },
    ],
    origins: [], policyId: 'policy:demo',
    provenance: { kind: 'organization', producerId: 'writer:demo' },
  };
}

// A and B must already exist and be permitted, or be in the same validated batch.
export const createP: WriteRequest = {
  idempotencyKey: 'demo:create-P', guards: [],
  revisions: [
    { atomId: 'P', revisionId: 'P:1', expectedHead: null, content: group },
    { atomId: 'M1', revisionId: 'M1:1', expectedHead: null, content: membership('P', 'A') },
    { atomId: 'M2', revisionId: 'M2:1', expectedHead: null, content: membership('P', 'B') },
  ],
};

// Adding D to P does not revise P or its ancestors.
export const addD: WriteRequest = {
  idempotencyKey: 'demo:add-D-to-P', guards: [],
  revisions: [{ atomId: 'M3', revisionId: 'M3:1', expectedHead: null,
    content: membership('P', 'D') }],
};

// Retiring an occurrence leaves B itself and other memberships untouched.
export const retireM2: ProposedRevision = {
  atomId: 'M2', revisionId: 'M2:2', expectedHead: 'M2:1',
  content: { ...membership('P', 'B'), state: 'retired' },
};

export const fixedInclude: Slot = {
  role: 'part', mode: 'include',
  target: { kind: 'pinned', atomId: 'B', revisionId: 'B:1' },
};

// A compile-time test for the pinned-include rule; runtime enforcement is still required.
// @ts-expect-error include MUST target a pinned revision, not a mutable logical identity.
const invalidInclude: Slot = { role: 'part', mode: 'include', target: { kind: 'logical', atomId: 'B' } };
void invalidInclude;
