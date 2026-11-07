import type { SupabaseClient } from '@supabase/supabase-js';
import { SyncError, type Device, type OutboxOp, type PullResult, type PushResult, type Snapshot, type Transport } from '../types';

// Transport over the suqa.pos_* RPCs (21_pos.sql). The client must be created with db: { schema: 'suqa' }.
// Error mapping: the RPCs raise 'device_revoked' / 'not_a_member' / 'pos_disabled' as the message; network failures surface as 'network'.

export class SupabaseTransport implements Transport {
  constructor(private sb: SupabaseClient) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    let res;
    try { res = await this.sb.rpc(fn, args); }
    catch (e) { throw new SyncError('network', (e as Error).message); }
    if (res.error) {
      const m = res.error.message ?? '';
      if (/device_revoked/.test(m)) throw new SyncError('device_revoked', m);
      if (/not_a_member|not_signed_in|JWT|permission denied/i.test(m)) throw new SyncError('auth', m);
      if (/pos_disabled/.test(m)) throw new SyncError('pos_disabled', m);
      if (/fetch|network|Failed to fetch|Load failed/i.test(m) || (res.status ?? 0) === 0) throw new SyncError('network', m);
      throw new SyncError('server', m);
    }
    return res.data as T;
  }
  register(d: { id: string; shop_id: string; name: string; user_agent?: string; app_version?: string }): Promise<Device> {
    return this.rpc<Device>('pos_register_device', { p_id: d.id, p_shop: d.shop_id, p_name: d.name, p_user_agent: d.user_agent ?? null, p_app_version: d.app_version ?? null });
  }
  snapshot(deviceId: string): Promise<Snapshot> { return this.rpc<Snapshot>('pos_snapshot', { p_device: deviceId }); }
  pull(deviceId: string, cursor: number, limit = 1000): Promise<PullResult> { return this.rpc<PullResult>('pos_pull', { p_device: deviceId, p_cursor: cursor, p_limit: limit }); }
  push(deviceId: string, ops: Array<Pick<OutboxOp, 'op_id' | 'kind' | 'payload' | 'schema_version'>>, pending: number): Promise<PushResult> {
    return this.rpc<PushResult>('pos_push', { p_device: deviceId, p_ops: ops, p_pending: pending });
  }
}
