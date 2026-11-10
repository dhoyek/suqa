import type { Staff } from '@suqa/pos-core';
import type { View } from '../Shell';

/** The role that matters at the till is the one of the staff tile unlocked with the PIN ("staff" is the legacy name for cashier). */
export type PosRole = 'owner' | 'cashier' | 'stock';
export const roleOf = (s: Pick<Staff, 'role'> | null | undefined): PosRole => (s?.role === 'owner' ? 'owner' : s?.role === 'stock' ? 'stock' : 'cashier');

/**
 * "See what helps you sell, edit only what's yours."
 *  cashier: sell, orders, customers (no merge/delete), debts (collect), items read-only without cost, own shift, light settings
 *  stock:   + items/stock/purchases editing, sales reports without profit, device list
 *  owner:   everything
 */
const VIEWS_BY_ROLE: Record<PosRole, View[]> = {
  owner:   ['sell', 'orders', 'customers', 'debts', 'items', 'stock', 'purchases', 'shift', 'reports', 'settings'],
  stock:   ['sell', 'orders', 'customers', 'debts', 'items', 'stock', 'purchases', 'shift', 'reports', 'settings'],
  cashier: ['sell', 'orders', 'customers', 'debts', 'items', 'shift', 'settings'],
};
export const viewsFor = (role: PosRole): View[] => VIEWS_BY_ROLE[role];

export type Cap = 'items.edit' | 'items.cost' | 'items.tools' | 'customers.manage' | 'reports.profit' | 'shifts.all' | 'settings.shop' | 'settings.devices' | 'settings.ops' | 'newItemOnScan';
const CAPS: Record<Cap, PosRole[]> = {
  'items.edit': ['owner', 'stock'],
  'items.cost': ['owner'],
  'items.tools': ['owner'],            // quick buttons, bulk price change, import
  'customers.manage': ['owner'],       // merge / delete / inactive
  'reports.profit': ['owner'],
  'shifts.all': ['owner'],
  'settings.shop': ['owner'],          // shop settings, staff, drivers, audit, conflicts
  'settings.devices': ['owner', 'stock'],
  'settings.ops': ['owner'],           // rejected ops
  'newItemOnScan': ['owner', 'stock'],
};
export const can = (role: PosRole, cap: Cap): boolean => CAPS[cap].includes(role);
