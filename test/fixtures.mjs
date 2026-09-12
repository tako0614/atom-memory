import { MemoryHost, LocalAuthority, MemoryStorage } from '../dist/index.js';
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
