import type { Staff } from '@suqa/pos-core';
import type { View } from '../Shell';

/** The role that matters at the till is the one of the staff tile unlocked with the PIN ("staff" is the legacy name for cashier). */
export type PosRole = 'owner' | 'cashier' | 'stock' | 'setup';
export const roleOf = (s: { role?: Staff['role'] } | null | undefined): PosRole => (s?.role === 'owner' ? 'owner' : s?.role === 'stock' ? 'stock' : s?.role === 'setup' ? 'setup' : 'cashier');

/**
 * "See what helps you sell, edit only what's yours."
 *  cashier: sell, orders, customers (no merge/delete), debts (collect), items read-only without cost, own shift, light settings
 *  stock:   + items/stock/purchases editing, sales reports without profit, device list
 *  owner:   everything
 *  setup:   an association admin configuring the shop — items (no cost), shop settings, staff, devices. No sales, money or history.
 */
const VIEWS_BY_ROLE: Record<PosRole, View[]> = {
  // in the order of the menu: every day · people · goods · back office
  owner:   ['sell', 'orders', 'shift', 'debts', 'customers', 'drivers', 'items', 'offers', 'stock', 'purchases', 'reports', 'settings'],   // drivers: deliveries, pay and settlements — owner only
  stock:   ['sell', 'orders', 'shift', 'debts', 'customers', 'items', 'stock', 'purchases', 'reports', 'settings'],
  cashier: ['sell', 'orders', 'shift', 'debts', 'customers', 'items', 'settings'],
  setup:   ['items', 'settings'],
};
export const viewsFor = (role: PosRole): View[] => VIEWS_BY_ROLE[role];

export type Cap = 'items.edit' | 'items.cost' | 'items.tools' | 'customers.manage' | 'reports.profit' | 'shifts.all' | 'settings.shop' | 'settings.private' | 'settings.devices' | 'settings.ops' | 'newItemOnScan' | 'signOut';
const CAPS: Record<Cap, PosRole[]> = {
  'signOut': ['owner', 'setup'],                // a cashier only locks the till (🔒); leaving the account is the owner's call
  'items.edit': ['owner', 'stock', 'setup'],
  'items.cost': ['owner'],
  'items.tools': ['owner', 'setup'],            // quick buttons, bulk price change, import
  'customers.manage': ['owner'],       // merge / delete / inactive
  'reports.profit': ['owner'],
  'shifts.all': ['owner'],
  'settings.shop': ['owner', 'setup'], // shop settings, staff
  'settings.private': ['owner'],       // drivers, audit, conflicts, approval PIN, backup — the shop's own business
  'settings.devices': ['owner', 'stock', 'setup'],
  'settings.ops': ['owner'],           // rejected ops
  'newItemOnScan': ['owner', 'stock', 'setup'],
};
export const can = (role: PosRole, cap: Cap): boolean => CAPS[cap].includes(role);
