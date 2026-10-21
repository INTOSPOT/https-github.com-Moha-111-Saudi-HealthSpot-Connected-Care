import type { AssessedReading, Completeness, Config, Patient } from './types';

const DAY = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Compare usable readings with the patient's explicit demonstration schedule.
 * Only fully elapsed UTC days inside the window are counted. A patient with no
 * schedule or no elapsed scheduled day is "insufficient_information", not "incomplete".
 */
export function assessCompleteness(
  patient: Patient,
  assessed: AssessedReading[],
  nowMs: number,
  cfg: Config,
): Completeness {
  const usable = assessed.filter((a) => (a.status === 'valid' || a.status === 'questionable') && a.takenMs !== null);
  const last = usable.reduce<AssessedReading | null>((m, a) => (!m || a.takenMs! > m.takenMs! ? a : m), null);
  const lastUsableAt = last ? new Date(last.takenMs!).toISOString() : null;
  const lastUsableAgeHours = last ? Math.max(0, Math.round(((nowMs - last.takenMs!) / 3_600_000) * 10) / 10) : null;
  const base = { lastUsableAt, lastUsableAgeHours };
  if (!patient.schedule) {
    return { state: 'insufficient_information', expected: 0, received: 0, days: [], consecutiveEmptyDays: 0, ...base };
  }
  const startMs = Date.parse(patient.schedule.startDate + 'T00:00:00Z');
  const todayStart = Date.parse(utcDay(nowMs) + 'T00:00:00Z');
  const windowStart = Math.max(startMs, todayStart - cfg.completenessWindowDays * DAY);
  const days: Completeness['days'] = [];
  for (let d = windowStart; d < todayStart; d += DAY) {
    const date = utcDay(d);
    const n = usable.filter((a) => utcDay(a.takenMs!) === date).length;
    days.push({ date, expected: patient.schedule.perDay, received: Math.min(n, patient.schedule.perDay) });
  }
  const expected = days.reduce((s, d) => s + d.expected, 0);
  const received = days.reduce((s, d) => s + d.received, 0);
  let consecutiveEmptyDays = 0;
  for (let i = days.length - 1; i >= 0 && days[i].received === 0; i--) consecutiveEmptyDays++;
  const state =
    days.length < 2 ? 'insufficient_information' : received / expected >= cfg.completenessAdequate ? 'adequate' : 'incomplete';
  return { state, expected, received, days, consecutiveEmptyDays, ...base };
}
