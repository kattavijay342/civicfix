"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isValidReporterName, isValidIndianMobile, formatIndianMobile } from "@/lib/validators";
import { roleHomePath } from "@/lib/role-routes";
import { checkRateLimit, getClientIp, retryAfterMessage } from "@/lib/rate-limit";

export interface AuthFormState {
  error?: string;
  /** Non-error, non-failure state — e.g. "account created, confirm your
   * email." Kept separate from `error` so the UI never has to guess
   * whether a message means something went wrong. */
  info?: string;
}

/**
 * Public self-registration ALWAYS creates a citizen account. There is no
 * form field or code path here that lets a client choose a different role
 * — government / department-incharge / admin accounts are provisioned by
 * an existing admin (see src/lib/actions/admin.ts), never self-service.
 */
export async function signUp(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const fullName = String(formData.get("fullName") ?? "").trim();
  const mobile = String(formData.get("mobile") ?? "").trim();

  if (!email || !password) {
    return { error: "Email and password are required." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (!isValidReporterName(fullName)) {
    return { error: "Enter your full name (2-60 characters)." };
  }
  if (!isValidIndianMobile(mobile)) {
    return { error: "Enter a valid 10-digit Indian mobile number." };
  }

  const ip = await getClientIp();
  const ipLimit = await checkRateLimit(`auth_signup:ip:${ip}`, 8, 60 * 60);
  if (!ipLimit.allowed) return { error: retryAfterMessage(ipLimit.retryAfterSeconds) };
  const emailLimit = await checkRateLimit(`auth_signup:email:${email.toLowerCase()}`, 4, 60 * 60);
  if (!emailLimit.allowed) return { error: retryAfterMessage(emailLimit.retryAfterSeconds) };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        mobile_number: formatIndianMobile(mobile),
        role: "citizen",
      },
    },
  });

  if (error) {
    if (error.message.toLowerCase().includes("already registered")) {
      return { error: "An account with this email already exists. Try signing in instead." };
    }
    return { error: "Unable to create your account. Please try again." };
  }

  // Email confirmation is required on this project, so signUp() succeeds
  // (the account and profile already exist — see the on_auth_user_created
  // trigger) but returns no session until the citizen clicks the
  // confirmation link. Redirecting to the dashboard here would just bounce
  // them straight back to /sign-in with no explanation, so this is reported
  // as a real success with a next step — never as an error.
  if (!data.session) {
    return {
      info: "Account created. Please check your email and click the confirmation link to activate your account.",
    };
  }

  redirect(roleHomePath("citizen"));
}

export async function signIn(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const ip = await getClientIp();
  const ipLimit = await checkRateLimit(`auth_signin:ip:${ip}`, 20, 10 * 60);
  if (!ipLimit.allowed) return { error: retryAfterMessage(ipLimit.retryAfterSeconds) };
  const emailLimit = await checkRateLimit(`auth_signin:email:${email.toLowerCase()}`, 8, 10 * 60);
  if (!emailLimit.allowed) return { error: retryAfterMessage(emailLimit.retryAfterSeconds) };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Distinguished by Supabase's own stable error code (not a message
    // string match, which is fragile) — this is the one auth failure that
    // genuinely isn't "wrong password," and telling the citizen to check
    // their inbox is honest, not a security-relevant disclosure the way
    // e.g. "no account with that email" would be.
    if (error.code === "email_not_confirmed") {
      return { error: "Please confirm your email before signing in. Check your inbox for the confirmation email." };
    }
    return { error: "Invalid email or password." };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let role = "citizen";
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (profile?.role) role = profile.role;
  }

  redirect(roleHomePath(role));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
