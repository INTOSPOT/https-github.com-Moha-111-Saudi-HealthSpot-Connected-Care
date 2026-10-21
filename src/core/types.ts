export type Unit = 'mg/dL' | 'mmol/L';
export type Role = 'patient' | 'clinician' | 'system';

export interface RawReading {
  id: string;
  patientId: string;
  value: number | null;
  unit: string | null;
  takenAt: string | null;
  receivedAt: string;
  context?: string;
}

export type QualityFlagCode =
  | 'MISSING_VALUE'
  | 'MISSING_UNIT'
  | 'UNKNOWN_UNIT'
  | 'MISSING_TIMESTAMP'
  | 'INVALID_TIMESTAMP'
  | 'FUTURE_TIMESTAMP'
  | 'STALE_TIMESTAMP'
  | 'DUPLICATE'
  | 'IMPLAUSIBLE_VALUE'
  | 'POSSIBLE_UNIT_MIX_UP';

export interface QualityFlag {
  code: QualityFlagCode;
  detail: string;
}

/** valid: usable. questionable: kept, shown, excluded from rules until verified. duplicate: kept, excluded. invalid: cannot be interpreted. */
export type QualityStatus = 'valid' | 'questionable' | 'duplicate' | 'invalid';

export interface AssessedReading {
  raw: RawReading;
  mgdl: number | null;
  takenMs: number | null;
  status: QualityStatus;
  flags: QualityFlag[];
  outOfRange: 'low' | 'high' | null;
}

export interface Schedule {
  startDate: string; // YYYY-MM-DD (UTC) demonstration schedule start
  perDay: number;
}

export interface Patient {
  id: string;
  nameAr: string;
  nameEn: string;
  schedule: Schedule | null;
}

export type CompletenessState = 'adequate' | 'incomplete' | 'insufficient_information';
export interface Completeness {
  state: CompletenessState;
  expected: number;
  received: number;
  days: { date: string; expected: number; received: number }[];
  consecutiveEmptyDays: number;
  lastUsableAt: string | null;
  lastUsableAgeHours: number | null;
}

export type RuleId = 'R-CALL' | 'R-OOR' | 'R-MISS' | 'R-QUAL';
export interface Trigger {
  ruleId: RuleId;
  ruleVersion: string;
  tier: number;
  summaryKey: string;
  params: Record<string, string | number>;
  observationIds: string[];
  evidenceKey: string;
  firstEvidenceAt: string;
  latestEvidenceAt: string;
}

export interface Config {
  version: string;
  lowMgdl: number;
  highMgdl: number;
  oorCount: number;
  oorWindowHours: number;
  missDays: number;
  completenessAdequate: number;
  completenessWindowDays: number;
  ackSlaHours: number;
  duplicateWindowMinutes: number;
  futureToleranceMinutes: number;
  staleDays: number;
  plausibleMinMgdl: number;
  plausibleMaxMgdl: number;
  unitMixUpMaxMgdl: number;
  taskDueHours: number;
  responseDueHours: number;
}

export type CaseState = 'new' | 'acknowledged' | 'assigned' | 'awaiting_response' | 'reassessment' | 'closed';
export type EventType =
  | 'reading_submitted'
  | 'callback_requested'
  | 'case_opened'
  | 'trigger_added'
  | 'case_reopened'
  | 'acknowledged'
  | 'followup_assigned'
  | 'message_sent'
  | 'patient_responded'
  | 'reassessment_started'
  | 'returned_to_followup'
  | 'case_closed'
  | 'priority_overridden'
  | 'override_cleared'
  | 'review_session';

export interface AppEvent {
  id: string;
  seq: number;
  at: string;
  type: EventType;
  patientId: string;
  caseId?: string;
  actor: string;
  role: Role;
  payload: Record<string, any>;
}

export interface Task {
  id: string;
  caseId: string;
  owner: string;
  description: string;
  createdAt: string;
  dueAt: string;
  completedAt: string | null;
}

export interface Override {
  tier: number;
  reason: string;
  actor: string;
  at: string;
}

export interface Case {
  id: string;
  patientId: string;
  state: CaseState;
  openedAt: string;
  reopenCount: number;
  stateSince: string;
  acknowledgedAt: string | null;
  firstFollowupAt: string | null;
  closedAt: string | null;
  owner: string | null;
  seenEvidence: string[];
  override: Override | null;
  awaitingSince: string | null;
  responseDueAt: string | null;
  respondedAt: string | null;
  history: string[]; // event ids
  /** per-episode records (one per open/reopen) for metrics */
  episodes: { openedAt: string; acknowledgedAt: string | null; firstFollowupAt: string | null; closedAt: string | null }[];
}

export interface Message {
  id: string;
  caseId: string;
  patientId: string;
  templateId: string;
  text: string;
  approvedBy: string;
  at: string;
  respondedAt: string | null;
  response: { kind: string; text: string } | null;
}

export interface Derived {
  patients: Patient[];
  readings: RawReading[];
  callbacks: { id: string; patientId: string; at: string; text: string; resolvedByCaseClosure: boolean }[];
  cases: Record<string, Case>;
  tasks: Task[];
  messages: Message[];
  reviewSessions: { caseId: string; seconds: number; at: string; actor: string }[];
  events: AppEvent[];
}

export interface WorklistItem {
  patientId: string;
  caseId: string | null;
  rank: number;
  tier: number;
  baseTier: number;
  overridden: boolean;
  triggers: Trigger[];
  urgencyFlags: UrgencyFlag[];
  assessed: AssessedReading[];
  completeness: Completeness;
  state: CaseState | 'no_case';
  owner: string | null;
  unresolved: string[];
  reasonKeys: { key: string; params: Record<string, string | number> }[];
  tieBreakers: (string | number)[];
}

export type UrgencyFlag =
  | { kind: 'unacknowledged'; hours: number }
  | { kind: 'overdue_task'; hours: number; taskId: string }
  | { kind: 'response_overdue'; hours: number }
  | { kind: 'unresolved_prior'; count: number };
