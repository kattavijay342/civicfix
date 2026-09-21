import "server-only";
import type { NotificationChannel, ChannelSendInput, ChannelSendResult } from "./types";

/**
 * 🔵 BLOCKED — no email provider is configured for this project (no
 * RESEND_API_KEY/SENDGRID_API_KEY/POSTMARK_API_KEY/similar in .env.local or
 * .env.local.example, no email-sending package in package.json). This
 * exists only as the real integration point: implement `send()` for the
 * chosen provider (Resend, SendGrid, Postmark, ...) behind this same
 * interface once a real key is configured and tested. Never called from any
 * real code path today, and never fabricates a "sent" result.
 */
export const emailChannel: NotificationChannel = {
  name: "email",
  isConfigured() {
    return Boolean(process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY || process.env.POSTMARK_API_KEY);
  },
  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { status: "not_configured", reason: "No email provider is configured (RESEND_API_KEY/SENDGRID_API_KEY/POSTMARK_API_KEY unset)." };
    }
    // Provider integration point — intentionally unimplemented until a real
    // key is configured and this has been tested against it.
    void input;
    return { status: "not_configured", reason: "Email provider is configured but not yet implemented." };
  },
};
