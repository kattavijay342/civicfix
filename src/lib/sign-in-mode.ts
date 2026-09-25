/**
 * Which sign-in UI /sign-in shows. Citizen mode submits signIn; authorized
 * mode submits signInAuthorized, which additionally refuses any account
 * whose stored role isn't government / department_incharge / admin. The
 * destination is always derived server-side from the stored profile role —
 * the mode can only narrow who may sign in, never grant or imply a role.
 */
export type SignInMode = "citizen" | "authorized";

export const AUTHORIZED_SIGN_IN_PATH = "/sign-in?mode=authorized";
export const CITIZEN_SIGN_IN_PATH = "/sign-in";
/** The existing admin-invitation activation page (G1). Visiting it without
 * a valid invitation link/session only shows instructions — it never
 * creates an account. */
export const ACTIVATE_INVITE_PATH = "/auth/accept-invite";

/** Anything other than exactly "authorized" (missing, misspelled, arrays,
 * junk) falls back to the normal citizen experience. */
export function parseSignInMode(value: unknown): SignInMode {
  return value === "authorized" ? "authorized" : "citizen";
}
