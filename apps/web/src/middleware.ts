import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, AUTH_COOKIE } from "@/lib/supabase/env";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = SUPABASE_URL;
  const key = SUPABASE_PUBLISHABLE_KEY;

  const supabase = createServerClient(url, key, {
    cookieOptions: AUTH_COOKIE,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getUser();

  if (!data.user && request.nextUrl.pathname.startsWith("/app")) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(login);
  }
  // Signed in already: the login screen is skipped (straight to the dashboard or the page that was asked for).
  if (data.user && request.nextUrl.pathname === "/login") {
    const raw = request.nextUrl.searchParams.get("next") ?? "/app";
    const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/app";
    const dest = new URL(next, request.nextUrl.origin);
    const redirect = NextResponse.redirect(dest);
    for (const c of response.cookies.getAll()) redirect.cookies.set(c);
    return redirect;
  }
  // Remember the activity last opened, so the home-screen app reopens the same dashboard (store or creator).
  const org = request.nextUrl.searchParams.get("org");
  if (data.user && request.nextUrl.pathname.startsWith("/app") && org && /^[0-9a-f-]{36}$/i.test(org)) {
    response.cookies.set("lk_org", org, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true, secure: AUTH_COOKIE.secure });
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|downloads/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|zip)$).*)"],
};
