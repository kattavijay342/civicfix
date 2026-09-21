import "server-only";
import type { NotificationChannel, ChannelSendInput, ChannelSendResult } from "./types";

/**
 * 🔵 BLOCKED — no SMS/WhatsApp provider is configured for this project (no
 * TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN or similar in .env.local, no SMS/
 * WhatsApp package in package.json). Real integration point for a future
 * provider (Twilio, MSG91, Gupshup WhatsApp Business API, ...). Never
 * called from any real code path today. Never uses a fabricated phone
 * number and never claims a message was sent.
 */
export const smsChannel: NotificationChannel = {
  name: "sms",
  isConfigured() {
    return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  },
  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { status: "not_configured", reason: "No SMS/WhatsApp provider is configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN unset)." };
    }
    void input;
    return { status: "not_configured", reason: "SMS/WhatsApp provider is configured but not yet implemented." };
  },
};
