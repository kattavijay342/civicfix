import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = {
  title: "Sign In — CivicFix",
};

export default function SignInPage() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <Link
        href="/"
        className="mb-8 inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to home
      </Link>

      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Welcome to CivicFix</h1>
        <p className="mt-1.5 text-sm text-foreground-muted">
          Sign in to report issues and track resolutions.
        </p>
      </div>

      <SignInForm />
    </div>
  );
}
