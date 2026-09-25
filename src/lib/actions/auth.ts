"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isValidReporterName, isValidIndianMobile, formatIndianMobile } from "@/lib/validators";
import { roleHomePath, resolveRoleHome } from "@/lib/role-routes";
import { getAuthRedirectOrigin } from "@/lib/auth-redirect";
import { checkRateLimit, getClientIp, retryAfterMessage } from "@/lib/rate-limit";

export interface AuthFormState {
  error?: string;
  /** Non-error, non-failure state — e.g. "account created, confirm your
   * email." Kept separate from `error` so the UI never has to guess
   * whether a message means something went wrong. */
  info?: string;
}

const ACCOUNT_NOT_CONFIGURED_MESSAGE =
  "Your account isn't set up for CivicFix access yet. Please contact your CivicFix administrator.";

/**
 * Public self-registration ALWAYS creates a citizen account. There is no
 * form field or code path here that lets a client choose a different role
 * — government / department-incharge / admin accounts are provisioned by
 * an existing admin (see src/lib/actions/admin.ts), never self-service.
 * The database enforces this too: handle_new_user() always inserts
 * role = 'citizen' and ignores any role in sign-up metadata
 * (supabase/migrations/0015_g1_signup_role_lockdown.sql), so even a
 * direct call to Supabase's signup endpoint can't pick a role.
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
      emailRedirectTo: `${getAuthRedirectOrigin()}/auth/callback`,
      data: {
        full_name: fullName,
        mobile_number: formatIndianMobile(mobile),
      },
    },
  });

  if (error) {
    console.error("[signUp] Supabase signUp failed", {
      code: error.code,
      status: error.status,
      message: error.message,
    });
    if (error.message.toLowerCase().includes("already registered")) {
      return { error: "An account with this email already exists. Try signing in instead." };
    }
    // Supabase's own confirmation-email send rate limit (distinct from the
    // app-level checkRateLimit above) — distinguished by Supabase's stable
    // error code, not a message match. Telling the citizen to wait is
    // honest; the generic message below would look like their input was
    // somehow wrong when it wasn't.
    if (error.code === "over_email_send_rate_limit") {
      return { error: "We're sending a lot of confirmation emails right now. Please wait a few minutes and try again." };
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

  // The destination comes only from the authenticated user's own profile
  // row (read through RLS as that user) — never from the form, URL, email,
  // or anything else the client controls. There is no role picker.
  const { data: profile } = user
    ? await supabase.from("profiles").select("role").eq("id", user.id).single()
    : { data: null };
  const home = resolveRoleHome(profile?.role);

  if (!home) {
    // Authenticated but no recognizable role: never guess one. End the
    // session so a half-configured account holds no access at all.
    console.error("[signIn] authenticated user has no valid application role", {
      userId: user?.id ?? null,
      hasProfile: !!profile,
    });
    await supabase.auth.signOut();
    return { error: ACCOUNT_NOT_CONFIGURED_MESSAGE };
  }

  redirect(home);
}

/** Roles the Government & Department sign-in (/sign-in?mode=authorized) accepts. */
const AUTHORIZED_LOGIN_ROLES = ["government", "department_incharge", "admin"];

/**
 * Sign-in for /sign-in?mode=authorized ONLY. Same Supabase password
 * sign-in and the SAME rate-limit counters as signIn (so switching pages
 * never buys extra attempts), but it only completes for an account whose
 * stored profile role is government / department_incharge / admin. Any
 * other account (e.g. a citizen) is signed straight back out and told to
 * use Citizen Sign In — this context can only narrow access, never grant
 * it. The citizen signIn action above is deliberately untouched.
 */
export async function signInAuthorized(
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
    if (error.code === "email_not_confirmed") {
      return { error: "Please confirm your email before signing in. Check your inbox for the confirmation email." };
    }
    return { error: "Invalid email or password." };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("profiles").select("role").eq("id", user.id).single()
    : { data: null };
  const role = profile?.role;

  if (!AUTHORIZED_LOGIN_ROLES.includes(role)) {
    await supabase.auth.signOut();
    if (role === "citizen") {
      return {
        error:
          "This sign-in is only for authorized government & department users. Citizens, please use Citizen Sign In.",
      };
    }
    console.error("[signInAuthorized] authenticated user has no valid application role", {
      userId: user?.id ?? null,
      hasProfile: !!profile,
    });
    return { error: ACCOUNT_NOT_CONFIGURED_MESSAGE };
  }

  redirect(roleHomePath(role));
}

/**
 * Final step of an admin invitation (/auth/accept-invite): the invited
 * Authorized Government User / Department In-charge chooses their own
 * password — the admin never sets or sees one. Requires the session the
 * invitation link just established; the landing page afterwards is, as
 * always, derived from the stored profile role.
 */
export async function completeInvitation(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (password.length < 8) return { error: "Password must be at least 8 characters." };
  if (password !== confirmPassword) return { error: "Passwords don't match." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Your invitation link has expired or was already used. Ask your administrator to send a new one." };
  }
  if (!user.invited_at) {
    return { error: "This page is only for accepting a CivicFix invitation." };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    console.error("[completeInvitation] updateUser failed", { code: error.code, status: error.status });
    if (error.code === "weak_password") {
      return { error: "That password is too weak. Please choose a longer, less common password." };
    }
    return { error: "Unable to set your password. Please try again." };
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  const home = resolveRoleHome(profile?.role);
  if (!home) {
    console.error("[completeInvitation] invited user has no valid application role", { userId: user.id });
    await supabase.auth.signOut();
    return { error: ACCOUNT_NOT_CONFIGURED_MESSAGE };
  }

  redirect(home);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
