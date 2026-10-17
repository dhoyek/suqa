import { describe, it, expect } from 'vitest';
import { friendlyError, ui, STATUS_LABEL } from '../ui-text';

describe('friendlyError', () => {
  it('translates stable database error keys', () => {
    expect(friendlyError({ message: 'min_order', details: '5.00' }, 'en')).toBe('The order is below the shop minimum (5.00 USD)');
    expect(friendlyError({ message: 'outside_delivery_area' }, 'ar')).toBe(ui('err_outside_delivery_area', 'ar'));
    expect(friendlyError({ message: 'order_locked', details: 'total_usd' }, 'en')).toBe(ui('err_order_locked', 'en'));
  });
  it('maps trigger and permission errors', () => {
    expect(friendlyError({ message: 'order BAT-1: transition ready → pending not allowed' }, 'en')).toBe(ui('err_transition', 'en'));
    expect(friendlyError({ message: 'customers can only cancel a pending order' }, 'en')).toBe(ui('err_customers_cancel_pending', 'en'));
    expect(friendlyError({ message: 'new row violates row-level security policy' }, 'ar')).toBe(ui('notAllowed', 'ar'));
  });
  it('never leaks raw SQL text', () => {
    expect(friendlyError({ message: 'syntax error at or near "foo"' }, 'en')).toBe(ui('err_generic', 'en'));
    expect(friendlyError(new TypeError('Failed to fetch'), 'en')).toBe(ui('err_network', 'en'));
  });
  it('has Arabic and English for every status', () => {
    for (const v of Object.values(STATUS_LABEL)) { expect(v.ar).toBeTruthy(); expect(v.en).toBeTruthy(); }
  });
});
