import { MemoryHost, LocalAuthority, MemoryStorage } from '../dist/index.js';
import { createHash } from 'node:crypto';
import { observe } from '../dist/client/observation.js';
let changeSequence = 0;

function content(value) {
  return typeof value === 'string'
    ? { text: value, links: [] }
    : { ...value, links: value.links ?? [] };
}
function changeOptions(options = {}) {
  return {
    sources: options.sources ?? [],
    ...(options.input !== undefined ? { input: options.input } : {}),
  };
}
function withAgentInput(memory, value, options = {}) {
  if (memory.binding?.actor?.type !== 'agent' || options.input !== undefined) return options;
  const payloadDigest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    ...options,
    input: observe(
      memory.engine,
      { sources: options.sources ?? [], payloadDigest },
      memory.binding,
    ),
  };
}
function operationOptions(options = {}) {
  const { idempotencyKey, budget, deadline, signal } = options;
  return {
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(deadline !== undefined ? { deadline } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}
function withOperation(view, result) {
  return {
    ...view,
    operationId: result.operationId,
    repeated: result.repeated,
    indexing: result.indexing,
  };
}
export async function create(memory, value, options = {}) {
  options = withAgentInput(memory, value, options);
  const id =
    options.changeId ??
    (options.idempotencyKey ? `create-${options.idempotencyKey}` : `create-${++changeSequence}`);
  const result = await memory.write(
    {
      changes: [{ id, op: 'create', content: content(value), ...changeOptions(options) }],
    },
    operationOptions(options),
  );
  return withOperation(result.changes[id], result);
}
export async function revise(memory, target, value, options = {}, writeOptions = {}) {
  options = withAgentInput(memory, { target, value }, options);
  const id = `revise-${++changeSequence}`;
  const result = await memory.write(
    {
      changes: [{ id, op: 'revise', target, content: content(value), ...changeOptions(options) }],
    },
    { ...operationOptions(options), ...operationOptions(writeOptions) },
  );
  const view = result.changes[id];
  return { value: view, changes: [view], operationId: result.operationId };
}
export async function retire(memory, target, options = {}, writeOptions = {}) {
  options = withAgentInput(memory, { target }, options);
  const id = `retire-${++changeSequence}`;
  const result = await memory.write(
    { changes: [{ id, op: 'retire', target, ...(options.input ? { input: options.input } : {}) }] },
    { ...operationOptions(options), ...operationOptions(writeOptions) },
  );
  const view = result.changes[id];
  return { value: view, changes: [view], operationId: result.operationId };
}
export function fixture(options = {}) {
  const authority = new LocalAuthority();
  const auth = authority.issue({
    subject: 'owner',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  const storage = options.storage ?? new MemoryStorage();
  const host = new MemoryHost({ authority, storage, ...options });
  const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
  const memory = host.connect(binding);
  return {
    authority,
    auth,
    storage,
    host,
    binding,
    memory,
    writer: host.connect({ ...binding, actor: { type: 'agent' } }),
  };
}
