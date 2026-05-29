// Time helpers. Python used zoneinfo.ZoneInfo; in Workers we use the built-in
// Intl/Temporal-free approach: Intl.DateTimeFormat with a timeZone gives us the
// wall-clock HH:MM in an arbitrary IANA zone without any tz database dependency.

/** "HH:MM" of (now + aheadSeconds) rendered in `tzName`. Mirrors compute_target_hhmm. */
export function computeTargetHhmm(nowMs: number, aheadSeconds: number, tzName: string): string {
  const t = new Date(nowMs + aheadSeconds * 1000);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tzName,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    // hourCycle h23 forces midnight to render "00:00" (not "24:00"), which some
    // ICU/locale combinations emit under hour12:false alone.
    hourCycle: "h23",
  });
  // en-GB 2-digit gives "HH:MM".
  return fmt.format(t);
}

// next_fire_time in main.py works in tz-local wall time, but the boundary it
// computes is an absolute instant, so we can compute it in epoch-ms directly:
//   target   = now + ahead
//   boundary = ceil(target to next whole minute)
//   fire     = boundary - ahead - guard
// Minute boundaries are tz-independent (all IANA offsets are whole minutes for
// practical purposes), so we don't need tzName here.
/** Absolute epoch-ms of the next tick. Mirrors next_fire_time. */
export function nextFireTimeMs(nowMs: number, aheadSeconds: number, guardSeconds = 0): number {
  const targetMs = nowMs + aheadSeconds * 1000;
  const nextMinuteMs = Math.floor(targetMs / 60000) * 60000 + 60000;
  return nextMinuteMs - aheadSeconds * 1000 - guardSeconds * 1000;
}
