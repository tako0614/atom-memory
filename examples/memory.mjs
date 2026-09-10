import { MemoryHost, LocalAuthority } from 'atom-memory';

// Configure the example's local host once; application code imports memory.
const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'support-app',
  readPolicies: ['notes'],
  writePolicies: ['notes'],
  canIngestSource: true,
});
const host = new MemoryHost({ authority });
export const memory = host.connect({
  auth,
  writePolicy: 'notes',
  actor: { type: 'human' },
});
