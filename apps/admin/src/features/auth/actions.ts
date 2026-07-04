"use server";

import { cookies } from "next/headers";
import { createClient } from "@hamza/shared/supabase/server";
import { createAdminClient } from "@hamza/shared/supabase/admin";
import { sendAdminEmail, authEmailHtml } from "@/lib/email";
import { generateCode, sha256, signOtpSession, OTP_COOKIE } from "@/lib/otp";

const OTP_TTL_MS = 10 * 60 * 1000; // code valid 10 min
const OTP_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // OTP-verified for 12h
const RESEND_COOLDOWN_MS = 30 * 1000; // 30s between resends
const RESET_TTL_MS = 30 * 60 * 1000; // reset link valid 30 min
const MAX_ATTEMPTS = 6;

type Db = ReturnType<typeof createAdminClient>;

async function findUserByEmail(db: Db, email: string) {
  // Admin user base is small — one page is plenty.
  const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const e = email.trim().toLowerCase();
  return data?.users.find((u) => (u.email ?? "").toLowerCase() === e) ?? null;
}

/** Create + email a fresh code for a purpose; stores only the hash. */
async function issueCode(db: Db, email: string, purpose: "login" | "reset"): Promise<{ code: string } | { error: string }> {
  const code = purpose === "login" ? generateCode() : crypto.randomUUID().replace(/-/g, "");
  const code_hash = await sha256(`${purpose}:${email.toLowerCase()}:${code}`);
  const { error } = await db.from("auth_codes").insert({
    email: email.toLowerCase(),
    code_hash,
    purpose,
    expires_at: new Date(Date.now() + (purpose === "login" ? OTP_TTL_MS : RESET_TTL_MS)).toISOString(),
  });
  if (error) return { error: error.message };
  return { code };
}

async function emailOtp(email: string, code: string) {
  return sendAdminEmail({
    to: email,
    subject: `Your admin login code: ${code}`,
    html: authEmailHtml("Your one-time login code", `
      <p style="font-size:14px">Enter this code to finish signing in to the admin portal:</p>
      <p style="font-size:30px;letter-spacing:6px;font-weight:700;margin:12px 0">${code}</p>
      <p style="font-size:13px;color:#7A736A">This code expires in 10 minutes. If you didn’t try to sign in, you can ignore this email.</p>`),
  });
}

/** Marks the current session as 2nd-factor-verified by setting the signed OTP cookie. */
async function setOtpVerifiedCookie(userId: string, secret: string) {
  const token = await signOtpSession(userId, OTP_SESSION_TTL_MS, secret);
  (await cookies()).set(OTP_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: OTP_SESSION_TTL_MS / 1000,
  });
}

/**
 * Step 1 — verify email+password.
 *
 * The owner keeps the emailed one-time code as a 2nd factor. Cashiers/managers
 * sign in with email + password ONLY: the OTP email uses a Resend test sender
 * that can only deliver to the owner's inbox, so emailing a code to any other
 * staff address 403s. For them the verified password IS the gate — we set the
 * OTP-verified cookie directly and never send an email.
 */
export async function startLogin(email: string, password: string): Promise<{ otpRequired: true } | { ok: true } | { error: string }> {
  const supabase = await createClient();
  const { data: signIn, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error || !signIn.user) return { error: "Invalid email or password." };

  // Only owner/manager/cashier (staff) may proceed.
  const { data: profile } = await supabase.from("profiles").select("role, active").eq("id", signIn.user.id).maybeSingle();
  const role = (profile?.role as string | undefined) ?? "cashier";
  const active = (profile?.active as boolean | undefined) ?? true;
  if (!active || !["owner", "manager", "cashier"].includes(role)) {
    await supabase.auth.signOut();
    return { error: "This account isn’t allowed to access the admin portal." };
  }

  const secret = process.env.ADMIN_OTP_SECRET;
  if (!secret) { await supabase.auth.signOut(); return { error: "Server auth secret not configured (ADMIN_OTP_SECRET)." }; }

  // Cashiers / managers: email + password only (no OTP email is ever sent).
  if (role !== "owner") {
    await setOtpVerifiedCookie(signIn.user.id, secret);
    return { ok: true };
  }

  // Owner: email a one-time code as the 2nd factor.
  const db = createAdminClient();
  const issued = await issueCode(db, signIn.user.email!, "login");
  if ("error" in issued) { await supabase.auth.signOut(); return { error: issued.error }; }

  const sent = await emailOtp(signIn.user.email!, issued.code);
  if ("error" in sent) { await supabase.auth.signOut(); return { error: sent.error }; }

  return { otpRequired: true };
}

/** Step 2 — verify the emailed code; on success, set the OTP-verified cookie. */
export async function verifyOtp(code: string): Promise<{ ok: true } | { error: string }> {
  const secret = process.env.ADMIN_OTP_SECRET;
  if (!secret) return { error: "Server auth secret not configured (ADMIN_OTP_SECRET)." };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return { error: "Your session expired — please log in again." };

  const db = createAdminClient();
  const { data: rows } = await db.from("auth_codes")
    .select("id, code_hash, expires_at, attempts, consumed")
    .eq("email", user.email.toLowerCase()).eq("purpose", "login")
    .order("created_at", { ascending: false }).limit(1);
  const row = rows?.[0];
  if (!row || row.consumed) return { error: "No active code — tap “Resend code”." };
  if (new Date(row.expires_at).getTime() < Date.now()) return { error: "That code expired — tap “Resend code”." };
  if (row.attempts >= MAX_ATTEMPTS) return { error: "Too many attempts — tap “Resend code”." };

  const hash = await sha256(`login:${user.email.toLowerCase()}:${code.trim()}`);
  if (hash !== row.code_hash) {
    await db.from("auth_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    return { error: "Incorrect code. Please try again." };
  }

  await db.from("auth_codes").update({ consumed: true }).eq("id", row.id);
  await setOtpVerifiedCookie(user.id, secret);
  return { ok: true };
}

/** Resend the login code (rate-limited). */
export async function resendOtp(): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return { error: "Your session expired — please log in again." };

  const db = createAdminClient();
  const { data: last } = await db.from("auth_codes")
    .select("created_at").eq("email", user.email.toLowerCase()).eq("purpose", "login")
    .order("created_at", { ascending: false }).limit(1);
  const lastAt = last?.[0]?.created_at ? new Date(last[0].created_at).getTime() : 0;
  const wait = RESEND_COOLDOWN_MS - (Date.now() - lastAt);
  if (wait > 0) return { error: `Please wait ${Math.ceil(wait / 1000)}s before resending.` };

  const issued = await issueCode(db, user.email, "login");
  if ("error" in issued) return { error: issued.error };
  const sent = await emailOtp(user.email, issued.code);
  if ("error" in sent) return { error: sent.error };
  return { ok: true };
}

/** Forgot password — email a reset link via Resend (no user enumeration). */
export async function requestPasswordReset(email: string): Promise<{ ok: true } | { error: string }> {
  const clean = email.trim().toLowerCase();
  if (!clean) return { error: "Enter your email." };
  const db = createAdminClient();
  const user = await findUserByEmail(db, clean);
  if (user) {
    const issued = await issueCode(db, clean, "reset");
    if ("error" in issued) return { error: issued.error };
    const base = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
    const link = `${base}/reset-password?email=${encodeURIComponent(clean)}&token=${issued.code}`;
    await sendAdminEmail({
      to: clean,
      subject: "Reset your admin password",
      html: authEmailHtml("Reset your password", `
        <p style="font-size:14px">Click the button below to set a new password. This link expires in 30 minutes.</p>
        <p style="margin:16px 0"><a href="${link}" style="background:#1863D5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px">Set a new password</a></p>
        <p style="font-size:12px;color:#7A736A">If the button doesn’t work, copy this link:<br>${link}</p>`),
    });
  }
  // Always succeed to avoid revealing whether the email exists.
  return { ok: true };
}

/** Complete a password reset with the emailed token. */
export async function resetPassword(email: string, token: string, newPassword: string): Promise<{ ok: true } | { error: string }> {
  const clean = email.trim().toLowerCase();
  if (newPassword.length < 8) return { error: "Password must be at least 8 characters." };
  const db = createAdminClient();
  const { data: rows } = await db.from("auth_codes")
    .select("id, code_hash, expires_at, consumed").eq("email", clean).eq("purpose", "reset")
    .order("created_at", { ascending: false }).limit(1);
  const row = rows?.[0];
  if (!row || row.consumed || new Date(row.expires_at).getTime() < Date.now()) {
    return { error: "This reset link is invalid or has expired. Request a new one." };
  }
  const hash = await sha256(`reset:${clean}:${token.trim()}`);
  if (hash !== row.code_hash) return { error: "This reset link is invalid. Request a new one." };

  const user = await findUserByEmail(db, clean);
  if (!user) return { error: "Account not found." };
  const { error } = await db.auth.admin.updateUserById(user.id, { password: newPassword });
  if (error) return { error: error.message };
  await db.from("auth_codes").update({ consumed: true }).eq("id", row.id);
  return { ok: true };
}

/** Sign out — clears the Supabase session and the OTP-verified cookie. */
export async function signOutAdmin(): Promise<{ ok: true }> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  (await cookies()).delete(OTP_COOKIE);
  return { ok: true };
}
