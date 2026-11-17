import { describe, expect, it } from 'vitest';
import {
  createIdentity,
  identityFromStored,
  publicKeyMatchesUserId,
  signEnvelope,
  verifyEnvelope,
} from './identity';
import { createEnvelope } from './protocol';

describe('identity', () => {
  it('создаёт ключ, выводит userId и отпечаток', async () => {
    const identity = await createIdentity(123);
    expect(identity.userId.length).toBeGreaterThan(60);
    expect(identity.fingerprint).toHaveLength(8);
    expect(identity.publicJwk.kty).toBe('EC');
    expect(identity.publicJwk.crv).toBe('P-256');
    expect(identity.privateJwk.d).toBeTruthy();
    expect(identity.createdAt).toBe(123);
  });

  it('восстанавливается из сохранённых JWK с тем же userId', async () => {
    const identity = await createIdentity();
    const restored = await identityFromStored(
      identity.publicJwk,
      identity.privateJwk,
      identity.createdAt,
    );
    expect(restored.userId).toBe(identity.userId);
    expect(restored.fingerprint).toBe(identity.fingerprint);
  });

  it('подпись проверяется и ломается при изменении любого поля', async () => {
    const identity = await createIdentity();
    const envelope = createEnvelope('join', { nonce: 'n', peerId: 'p' }, identity.userId, 'ABC234');
    envelope.sig = await signEnvelope(envelope, identity.privateJwk);

    expect(await verifyEnvelope(envelope, identity.publicJwk)).toBe(true);
    expect(await verifyEnvelope({ ...envelope, d: { nonce: 'x', peerId: 'p' } }, identity.publicJwk)).toBe(false);
    expect(await verifyEnvelope({ ...envelope, t: 'welcome' }, identity.publicJwk)).toBe(false);
    expect(await verifyEnvelope({ ...envelope, to: 'peer' }, identity.publicJwk)).toBe(false);
    expect(await verifyEnvelope({ ...envelope, sig: undefined }, identity.publicJwk)).toBe(false);
  });

  it('чужой ключ не подходит', async () => {
    const first = await createIdentity();
    const second = await createIdentity();
    const envelope = createEnvelope('join', { nonce: 'n' }, first.userId, 'ABC234');
    envelope.sig = await signEnvelope(envelope, first.privateJwk);
    expect(await verifyEnvelope(envelope, second.publicJwk)).toBe(false);
  });

  it('публичный ключ сверяется с userId', async () => {
    const identity = await createIdentity();
    expect(await publicKeyMatchesUserId(identity.publicJwk, identity.userId)).toBe(true);
    expect(await publicKeyMatchesUserId(identity.publicJwk, 'someone-else')).toBe(false);
  });
});
