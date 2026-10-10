// SPDX-License-Identifier: LGPL-3.0-only
// NatLabels.java, VoxLink c475faa9. Display names never determine the punch strategy.
import { translate as t } from './i18n';

export const NAT_RAW_LABELS: Record<string, string> = {
  unknown: 'voxlinknat.unknown',
  full_cone: 'voxlinknat.full_cone',
  restricted_cone: 'voxlinknat.restricted_cone',
  port_restricted_cone: 'voxlinknat.port_restricted_cone',
  symmetric_easy_inc: 'voxlinknat.symmetric_easy_inc',
  symmetric_easy_dec: 'voxlinknat.symmetric_easy_dec',
  symmetric: 'voxlinknat.symmetric',
  open: 'voxlinknat.open',
  moderate: 'voxlinknat.moderate',
  strict: 'voxlinknat.strict',
};
export const NAT_CLASS_LABELS: Record<string, string> = {
  CONE: 'voxlinknat.cone',
  EASY_SYM: 'voxlinknat.easy_sym',
  HARD_SYM: 'voxlinknat.hard_sym',
  UNKNOWN: 'voxlinknat.unknown',
};
export const natLabel = (natClass: string | undefined, raw: unknown): string =>
  natClass && natClass !== 'UNKNOWN'
    ? t(NAT_CLASS_LABELS[natClass] ?? 'voxlinknat.unknown')
    : t(NAT_RAW_LABELS[typeof raw === 'string' ? raw.trim().toLowerCase() : 'unknown'] ?? 'voxlinknat.unknown');
