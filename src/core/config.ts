import type { Config } from './types';

/** Illustrative simulation settings. NOT clinically validated. */
export const DEFAULT_CONFIG: Config = {
  version: 'sim-1.0',
  lowMgdl: 70,
  highMgdl: 180,
  oorCount: 3,
  oorWindowHours: 72,
  missDays: 2,
  completenessAdequate: 0.8,
  completenessWindowDays: 7,
  ackSlaHours: 4,
  duplicateWindowMinutes: 5,
  futureToleranceMinutes: 10,
  staleDays: 14,
  plausibleMinMgdl: 20,
  plausibleMaxMgdl: 600,
  unitMixUpMaxMgdl: 35,
  taskDueHours: 24,
  responseDueHours: 48,
};

export const RULE_VERSIONS: Record<string, string> = {
  'R-CALL': '1.0',
  'R-OOR': '1.0',
  'R-MISS': '1.0',
  'R-QUAL': '1.0',
};

/** Priority hierarchy (1 = highest). Documented in docs/algorithm-spec.md */
export const TIER = {
  CALLBACK: 1,
  REPEATED_OOR: 2,
  WORKFLOW_OVERDUE: 3,
  MISSING: 4,
  VERIFY_DATA: 5,
  MONITOR: 6,
} as const;

export const MMOL_TO_MGDL = 18.016;
