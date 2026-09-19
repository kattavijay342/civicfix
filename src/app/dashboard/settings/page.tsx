import type { Metadata } from "next";
import { Settings } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = {
  title: "Settings — CivicFix",
};

export default function SettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Settings</h1>
      <p className="mt-1 text-sm text-foreground-muted">
        Manage your account and notification preferences.
      </p>
      <div className="mt-8">
        <EmptyState
          icon={<Settings className="h-5 w-5" aria-hidden="true" />}
          title="Account settings aren't connected yet"
          description="Profile details, notification preferences, and language settings will be available once accounts and authentication are built in a later phase."
        />
      </div>
    </div>
  );
}
