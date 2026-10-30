// Mirrors lib/riyadh-time.ts + lib/branch-hours.ts so the server rejects an
// out-of-hours pickup using the same wall-clock/opening-hours logic the app
// displays as "open now" — duplicated here because this NestJS project
// doesn't share a module graph with the Expo app's lib/.
import { Logger } from '@nestjs/common';

const logger = new Logger('BranchHours');

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

interface DayHours {
  closed?: boolean;
  open?: string;
  close?: string;
}

function toRiyadhParts(date: Date): { weekday: number; hour: number; minute: number } {
  const shifted = new Date(date.getTime() + RIYADH_OFFSET_MS);
  return {
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function toMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Returns true/false when the branch's opening hours are known and
// conclusive for `at`, or null when there's no (or malformed) hours data —
// callers should not block a booking on missing data, only on a confirmed
// closed window.
export function isWithinBranchHours(openingHoursJson: string | null | undefined, at: Date): boolean | null {
  if (!openingHoursJson) return null;
  let parsed: { days?: Record<string, DayHours> } | null = null;
  try {
    parsed = JSON.parse(openingHoursJson);
  } catch {
    // null means "don't block the booking", so corrupt hours silently switch the
    // opening-hours check off for that branch.
    logger.warn({ msg: 'Branch openingHoursJson is invalid JSON; hours check skipped', sample: openingHoursJson.slice(0, 80) });
    return null;
  }
  const days = parsed?.days;
  // `days` فاضية = مفيش قيود (الموقع بيعتبرها ٢٤/٧) — مش «مقفول كل الأيام».
  if (!days || Object.keys(days).length === 0) return null;

  const { weekday, hour, minute } = toRiyadhParts(at);
  const minutes = hour * 60 + minute;
  const today = days[String(weekday)];
  if (!today || today.closed || !today.open || !today.close) return false;

  const open = toMinutes(today.open);
  const close = toMinutes(today.close);
  if (open == null || close == null) return null;
  return minutes >= open && minutes <= close;
}
