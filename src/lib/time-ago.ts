/** "Just now" / "12 min ago" / "3 h ago" / "2 days ago". Pure (takes `now`)
 * so it is testable; callers rendering per request always show current ages. */
export function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** True when `iso` is within the last `windowMs` (default 24 h). */
export function isWithin(iso: string, windowMs = 24 * 60 * 60 * 1000, now = Date.now()): boolean {
  return now - new Date(iso).getTime() < windowMs;
}
