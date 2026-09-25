import type { Metadata } from "next";
import { AcceptInviteForm } from "./AcceptInviteForm";

export const metadata: Metadata = {
  title: "Activate Account — CivicFix",
  robots: { index: false, follow: false },
};

export default function AcceptInvitePage() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Activate your invited account</h1>
        <p className="mt-1.5 text-sm text-foreground-muted">
          For authorized government &amp; department users invited by a CivicFix administrator.
        </p>
      </div>
      <AcceptInviteForm />
    </div>
  );
}
