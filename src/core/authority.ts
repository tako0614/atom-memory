import type { AuthContext } from '../contracts.js';
import { clone, fail, uid, validId } from './util.js';
export interface Principal {
  readonly subject: string;
  readonly readPolicies: readonly string[];
  readonly writePolicies: readonly string[];
  readonly canIngestSource?: boolean;
  readonly generation: string;
}
export interface Authorizer {
  resolve(auth: AuthContext): Principal;
}
/** Keep this host object out of model tools. Handles are capabilities, never user IDs. */
export class LocalAuthority implements Authorizer {
  #grants = new Map<string, Principal>();
  issue(input: Omit<Principal, 'generation'>): AuthContext {
    validId(input.subject);
    input.readPolicies.forEach(validId);
    input.writePolicies.forEach(validId);
    const auth = { authorizationHandle: uid('auth') };
    this.#grants.set(auth.authorizationHandle, { ...clone(input), generation: uid('policy') });
    return auth;
  }
  resolve(auth: AuthContext): Principal {
    const grant = this.#grants.get(auth?.authorizationHandle);
    if (!grant) fail('ACCESS_DENIED');
    return clone(grant);
  }
  revoke(auth: AuthContext): void {
    this.#grants.delete(auth.authorizationHandle);
  }
  update(auth: AuthContext, input: Omit<Principal, 'generation'>): void {
    this.resolve(auth);
    this.#grants.set(auth.authorizationHandle, { ...clone(input), generation: uid('policy') });
  }
}
