/**
 * Phase 6C — provider-agnostic external-channel interface. Every channel in
 * this directory implements this and is never called from any real code
 * path today (in-app is the only wired channel, see src/lib/notifications/
 * create.ts) — these exist purely so a future real provider slots in
 * without restructuring anything else.
 */
export interface ChannelSendInput {
  recipientId: string;
  title: string;
  body: string | null;
}

export type ChannelSendResult =
  | { status: "not_configured"; reason: string }
  | { status: "sent"; providerMessageId: string };

export interface NotificationChannel {
  readonly name: "email" | "sms" | "push";
  isConfigured(): boolean;
  send(input: ChannelSendInput): Promise<ChannelSendResult>;
}
