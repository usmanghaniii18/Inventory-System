import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { verifyOtpSession, OTP_COOKIE } from "@/lib/otp";

// Route → allowed roles. MUST mirror the `roles` in components/layout/nav.ts so
// the server guard and the visible nav never diverge. Anything not listed here
// is open to every signed-in staff role (POS, Sales, Products, Customers).
const OWNER_MANAGER_ONLY = [
  "/admin/dashboard", "/admin/categories", "/admin/stock", "/admin/purchasing",
  "/admin/orders", "/admin/storefront", "/admin/discounts", "/admin/reports",
];
const OWNER_ONLY = ["/admin/settings"];

const underAny = (pathname: string, prefixes: string[]) =>
  prefixes.some((p) => pathname === p || pathname.startsWith(p + "/"));

/** True when the path is restricted to a subset of roles (needs a role check). */
function isRestricted(pathname: string): boolean {
  return underAny(pathname, OWNER_MANAGER_ONLY) || underAny(pathname, OWNER_ONLY);
}

/** Whether `role` may access a (restricted) `pathname`. */
function roleAllowed(pathname: string, role: string): boolean {
  if (underAny(pathname, OWNER_ONLY)) return role === "owner";
  if (underAny(pathname, OWNER_MANAGER_ONLY)) return role === "owner" || role === "manager";
  return true;
}

/** Refreshes the Supabase auth session on every request and guards /admin/*.
 *  Full admin access requires BOTH a Supabase session AND a valid OTP-verified
 *  cookie (the 2nd factor, set after the emailed code is confirmed). */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options?: CookieOptions }[],
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // 2nd factor: a signed cookie set only after the emailed OTP is verified.
  const otpUserId = await verifyOtpSession(request.cookies.get(OTP_COOKIE)?.value, process.env.ADMIN_OTP_SECRET ?? "");
  const fullyAuthed = !!user && otpUserId === user.id;

  const { pathname } = request.nextUrl;
  const isAuthRoute = pathname.startsWith("/login");
  const isAdminRoute = pathname === "/admin" || pathname.startsWith("/admin/");

  if (!fullyAuthed && isAdminRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (fullyAuthed && isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/dashboard";
    return NextResponse.redirect(url);
  }

  // Role-gate admin routes server-side (mirrors nav.ts). A cashier must never
  // reach the Dashboard or other owner/manager-only areas (sales/profit/stock
  // value, etc.) even by typing the URL — hiding the nav item is not enough.
  // Only the check is done here (a single indexed lookup, and only when the
  // path is actually restricted) so ordinary cashier pages stay fast.
  if (fullyAuthed && isAdminRoute && isRestricted(pathname)) {
    const { data: profile } = await supabase
      .from("profiles").select("role").eq("id", user!.id).maybeSingle();
    const role = (profile?.role as string | undefined) ?? "owner";
    if (!roleAllowed(pathname, role)) {
      const url = request.nextUrl.clone();
      // Send them to their own home (POS billing) rather than the blocked page.
      url.pathname = "/admin/pos";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
