import {
  AtomKernel,
  LocalAuthority,
  content,
  membership,
  logical,
  defaultBudget,
} from 'atom-memory';

const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'example-host',
  readPolicies: ['notes'],
  writePolicies: ['notes'],
  canIngestSource: true,
});
const memory = new AtomKernel({ authority });

await memory.write(
  {
    idempotencyKey: 'example:seed',
    guards: [],
    revisions: [
      {
        atomId: 'note',
        revisionId: 'note:1',
        expectedHead: null,
        content: content('source', 'Atom の所属は独立した Atom で表す。', 'notes'),
      },
      {
        atomId: 'topic',
        revisionId: 'topic:1',
        expectedHead: null,
        content: content('collection', { form: 'set', title: '設計ノート' }, 'notes'),
      },
      {
        atomId: 'link',
        revisionId: 'link:1',
        expectedHead: null,
        content: membership('topic', 'note', 'notes'),
      },
    ],
  },
  auth,
);

const result = await memory.read(
  {
    selector: { kind: 'relations', target: logical('topic'), role: 'group', schema: 'membership' },
    context: { requestedPolicyIds: ['notes'], consistency: { mode: 'snapshot' } },
    budget: defaultBudget,
    render: 'evidence',
  },
  auth,
);
console.log(result.atoms.map((atom) => `${atom.atomId}@${atom.revisionId}`).join('\n'));
console.log(result.diagnostics);
