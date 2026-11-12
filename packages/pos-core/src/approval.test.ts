import { describe, expect, it } from 'vitest';
import { hashPin, verifyApproval } from './auth/pin';

describe('approval PIN', () => {
  it('without one, an owner login PIN approves; with one, only the approval PIN does', async () => {
    const owner = await hashPin('1111'), cashier = await hashPin('2222'), appr = await hashPin('9090');
    const staff = [
      { user_id: 'cash', role: 'cashier', active: true, pin_hash: cashier.hash, pin_salt: cashier.salt },
      { user_id: 'own', role: 'owner', active: true, pin_hash: owner.hash, pin_salt: owner.salt },
    ];
    expect(await verifyApproval('1111', staff, null)).toBe('own');
    expect(await verifyApproval('2222', staff, null)).toBeNull();
    const a = { hash: appr.hash, salt: appr.salt };
    expect(await verifyApproval('9090', staff, a)).toBe('own');       // stamped as approved by the shop's owner
    expect(await verifyApproval('1111', staff, a)).toBeNull();        // the owner's login PIN is no longer typed at the till
    expect(await verifyApproval('2222', staff, a)).toBeNull();
  });
});
