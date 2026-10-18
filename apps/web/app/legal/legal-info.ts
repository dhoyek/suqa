import type { Tenant } from '@suqa/shared';

// Platform defaults; each association can override them in Admin → Settings (legal operator, privacy contact).
export const PLATFORM_OPERATOR = 'Purple Digits (Lebanon)';
export const PLATFORM_CONTACT = 'privacy@yorgoinc.com';

export function legalInfo(t: Tenant | null) {
  return {
    OPERATOR: t?.settings.legal_operator?.trim() || PLATFORM_OPERATOR,
    CONTACT: t?.settings.legal_email?.trim() || PLATFORM_CONTACT,
  };
}
