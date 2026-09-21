"use client";

import { useActionState, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { signIn, signUp, type AuthFormState } from "@/lib/actions/auth";
import { cn } from "@/lib/utils";

const initialState: AuthFormState = {};

const inputClasses =
  "w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground placeholder:text-foreground-muted/70 outline-none transition focus:border-civic-400 focus:ring-2 focus:ring-civic-100";

export function SignInForm() {
  const [tab, setTab] = useState<"sign-in" | "sign-up">("sign-in");
  const [signInState, signInAction, signInPending] = useActionState(signIn, initialState);
  const [signUpState, signUpAction, signUpPending] = useActionState(signUp, initialState);

  return (
    <div className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
      <div role="tablist" aria-label="Sign in or sign up" className="mb-6 flex rounded-full bg-surface-muted p-1">
        {(["sign-in", "sign-up"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${t}-tab`}
            aria-selected={tab === t}
            aria-controls={`${t}-panel`}
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 rounded-full py-2 text-sm font-semibold transition",
              tab === t ? "bg-white text-foreground shadow-sm" : "text-foreground-muted",
            )}
          >
            {t === "sign-in" ? "Sign In" : "Citizen Sign Up"}
          </button>
        ))}
      </div>

      {tab === "sign-in" ? (
        <form
          action={signInAction}
          id="sign-in-panel"
          role="tabpanel"
          aria-labelledby="sign-in-tab"
          className="flex flex-col gap-4"
        >
          <Field label="Email" name="email" type="email" required autoComplete="email" errorId={signInState.error ? "signin-form-error" : undefined} />
          <Field label="Password" name="password" type="password" required autoComplete="current-password" errorId={signInState.error ? "signin-form-error" : undefined} />
          <FormError state={signInState} id="signin-form-error" />
          <SubmitButton pending={signInPending} label="Sign In" />
        </form>
      ) : (
        <form
          action={signUpAction}
          id="sign-up-panel"
          role="tabpanel"
          aria-labelledby="sign-up-tab"
          className="flex flex-col gap-4"
        >
          <p className="rounded-xl bg-civic-50 px-3.5 py-2.5 text-xs text-civic-800">
            This creates a <strong>citizen</strong> account. Government and department accounts are
            provisioned by an administrator, not through self sign-up.
          </p>
          <Field label="Full name" name="fullName" type="text" required autoComplete="name" errorId={signUpState.error ? "signup-form-error" : undefined} />
          <Field label="Mobile number" name="mobile" type="tel" required autoComplete="tel" placeholder="10-digit mobile number" errorId={signUpState.error ? "signup-form-error" : undefined} />
          <Field label="Email" name="email" type="email" required autoComplete="email" errorId={signUpState.error ? "signup-form-error" : undefined} />
          <Field
            label="Password"
            name="password"
            type="password"
            required
            autoComplete="new-password"
            minLength={8}
            errorId={signUpState.error ? "signup-form-error" : undefined}
          />
          <FormError state={signUpState} id="signup-form-error" />
          <SubmitButton pending={signUpPending} label="Create account" />
        </form>
      )}
    </div>
  );
}

function Field({
  label,
  name,
  errorId,
  ...rest
}: { label: string; name: string; errorId?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <input
        name={name}
        className={inputClasses}
        aria-invalid={!!errorId}
        aria-describedby={errorId}
        {...rest}
      />
    </label>
  );
}

function FormError({ state, id }: { state: AuthFormState; id: string }) {
  if (!state.error) return null;
  return (
    <p id={id} role="alert" className="flex items-center gap-1.5 rounded-lg bg-priority-critical-bg px-3 py-2 text-sm text-priority-critical">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      {state.error}
    </p>
  );
}

function SubmitButton({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-1 inline-flex items-center justify-center gap-2 rounded-full bg-civic-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {label}
    </button>
  );
}
