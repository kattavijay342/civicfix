import "server-only";
import type { NotificationCategory } from "./types";

/** Shape stored in profiles.notification_preferences (nullable JSONB). Any
 * category absent from a stored object, or the column being null entirely
 * (the default for every existing/new user), means "on" — preferences are
 * opt-out, never opt-in, so a user who's never visited settings still gets
 * every real event. */
export type NotificationPreferences = Partial<Record<NotificationCategory, boolean>>;

export function isCategoryEnabled(prefs: NotificationPreferences | null | undefined, category: NotificationCategory): boolean {
  if (!prefs) return true;
  const value = prefs[category];
  return value !== false;
}
