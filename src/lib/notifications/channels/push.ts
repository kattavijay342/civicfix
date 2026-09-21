import "server-only";
import type { NotificationChannel, ChannelSendInput, ChannelSendResult } from "./types";

/**
 * 🔵 BLOCKED — no push infrastructure is configured for this project (no
 * VAPID keys, no service worker in public/, no push subscription table, no
 * web-push package in package.json). Real integration point for a future
 * Web Push implementation. Never called from any real code path today —
 * the in-app Notification Center works fully independently of this.
 */
export const pushChannel: NotificationChannel = {
  name: "push",
  isConfigured() {
    return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  },
  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { status: "not_configured", reason: "No push infrastructure is configured (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY unset, no service worker)." };
    }
    void input;
    return { status: "not_configured", reason: "Push provider is configured but not yet implemented." };
  },
};
