import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { ProfileForm } from "./ProfileForm";
import { NotificationPreferencesForm } from "./NotificationPreferencesForm";

export const metadata: Metadata = {
  title: "Settings — CivicFix",
};

export default async function SettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/sign-in");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Settings</h1>
      <p className="mt-1 text-sm text-foreground-muted">Manage your account details.</p>
      <div className="mt-8 flex max-w-md flex-col gap-6">
        <ProfileForm profile={session.profile} />
        <NotificationPreferencesForm profile={session.profile} />
      </div>
    </div>
  );
}
