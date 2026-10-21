import type { AssessedReading, Config, QualityFlag, RawReading } from './types';
import { MMOL_TO_MGDL } from './config';

const MIN = 60_000;

export function parseTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export function toMgdl(value: number, unit: string): number | null {
  if (unit === 'mg/dL') return value;
  if (unit === 'mmol/L') return Math.round(value * MMOL_TO_MGDL * 10) / 10;
  return null;
}

/**
 * Assess all readings of one patient. Never deletes or silently corrects:
 * the raw reading is preserved and flags explain every limitation.
 */
export function assessReadings(raws: RawReading[], nowMs: number, cfg: Config): AssessedReading[] {
  const sorted = [...raws].sort(
    (a, b) => (parseTime(a.receivedAt) ?? 0) - (parseTime(b.receivedAt) ?? 0),
  );
  const out: AssessedReading[] = [];
  for (const raw of sorted) {
    const flags: QualityFlag[] = [];
    let invalid = false;
    let questionable = false;
    let mgdl: number | null = null;

    if (raw.value === null || raw.value === undefined || Number.isNaN(raw.value)) {
      flags.push({ code: 'MISSING_VALUE', detail: 'no value' });
      invalid = true;
    }
    if (!raw.unit) {
      flags.push({ code: 'MISSING_UNIT', detail: 'no unit' });
      invalid = true;
    } else if (raw.unit !== 'mg/dL' && raw.unit !== 'mmol/L') {
      flags.push({ code: 'UNKNOWN_UNIT', detail: raw.unit });
      invalid = true;
    }
    const takenMs = parseTime(raw.takenAt);
    if (!raw.takenAt) {
      flags.push({ code: 'MISSING_TIMESTAMP', detail: 'no measurement time' });
      invalid = true;
    } else if (takenMs === null) {
      flags.push({ code: 'INVALID_TIMESTAMP', detail: raw.takenAt });
      invalid = true;
    } else {
      if (takenMs > nowMs + cfg.futureToleranceMinutes * MIN) {
        flags.push({ code: 'FUTURE_TIMESTAMP', detail: raw.takenAt });
        questionable = true;
      }
      if (takenMs < nowMs - cfg.staleDays * 86_400_000) {
        flags.push({ code: 'STALE_TIMESTAMP', detail: raw.takenAt });
        questionable = true;
      }
    }
    if (!invalid && raw.value !== null) {
      mgdl = toMgdl(raw.value, raw.unit as string);
      if (mgdl !== null) {
        if (raw.unit === 'mg/dL' && raw.value <= cfg.unitMixUpMaxMgdl && raw.value >= 1) {
          flags.push({ code: 'POSSIBLE_UNIT_MIX_UP', detail: `${raw.value} mg/dL` });
          questionable = true;
        } else if (mgdl < cfg.plausibleMinMgdl || mgdl > cfg.plausibleMaxMgdl) {
          flags.push({ code: 'IMPLAUSIBLE_VALUE', detail: `${mgdl} mg/dL` });
          questionable = true;
        }
      }
    }
    // duplicates: same converted value and time within window of an earlier kept reading
    if (!invalid && mgdl !== null && takenMs !== null) {
      const dup = out.find(
        (o) =>
          o.status !== 'invalid' &&
          o.status !== 'duplicate' &&
          o.mgdl !== null &&
          o.takenMs !== null &&
          Math.abs(o.mgdl - mgdl!) < 0.5 &&
          Math.abs(o.takenMs - takenMs) <= cfg.duplicateWindowMinutes * MIN,
      );
      if (dup) flags.push({ code: 'DUPLICATE', detail: dup.raw.id });
    }
    const isDup = flags.some((f) => f.code === 'DUPLICATE');
    const status = invalid ? 'invalid' : isDup ? 'duplicate' : questionable ? 'questionable' : 'valid';
    const outOfRange =
      status === 'valid' && mgdl !== null ? (mgdl < cfg.lowMgdl ? 'low' : mgdl > cfg.highMgdl ? 'high' : null) : null;
    out.push({ raw, mgdl, takenMs, status, flags, outOfRange });
  }
  return out;
}
