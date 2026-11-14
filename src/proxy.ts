import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase auth session cookie on every request.
 *
 * Named `proxy.ts`, not `middleware.ts` — Next.js 16 deprecated and renamed
 * the `middleware` file convention to `proxy` (same behavior, new name/export).
 * See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
 */
/** Areas that always require a session. Anonymous requests get a real 307
 * to /sign-in here instead of a streamed in-page redirect. This is only a
 * first gate — each page still enforces the exact role (requireRole) and
 * RLS enforces data access. */
const PROTECTED_PREFIXES = ["/dashboard", "/government", "/department", "/admin", "/notifications"];

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Touching getUser() is what actually refreshes an expiring session.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && isProtectedPath(request.nextUrl.pathname)) {
    const redirect = NextResponse.redirect(new URL("/sign-in", request.url));
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
