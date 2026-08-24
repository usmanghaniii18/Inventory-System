"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Store, Loader2, ArrowLeft } from "lucide-react";
import { Button } from "@hamza/shared/ui/Button";
import { Input, Label, FieldError } from "@hamza/shared/ui/Input";
import { startLogin, verifyOtp, resendOtp } from "@/features/auth/actions";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<"password" | "otp">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function onPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined); setNotice(undefined); setLoading(true);
    const res = await startLogin(email, password);
    setLoading(false);
    if ("error" in res) return setError(res.error);
    if ("ok" in res) {
      // Cashier / manager — signed in with email + password, no OTP needed.
      router.push(params.get("next") ?? "/admin/dashboard");
      router.refresh();
      return;
    }
    setStep("otp"); setNotice(`We emailed a 6-digit code to ${email}.`); setCooldown(30);
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined); setLoading(true);
    const res = await verifyOtp(code);
    setLoading(false);
    if ("error" in res) return setError(res.error);
    router.push(params.get("next") ?? "/admin/dashboard");
    router.refresh();
  }

  async function onResend() {
    if (cooldown > 0) return;
    setError(undefined); setNotice(undefined);
    const res = await resendOtp();
    if ("error" in res) return setError(res.error);
    setNotice("A new code is on its way."); setCooldown(30);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500 text-white shadow-card">
            <Store className="h-7 w-7" />
          </div>
          <h1 className="font-heading text-2xl font-bold text-text-primary">Hamza General Store</h1>
          <p className="mt-1 text-sm text-text-tertiary">
            {step === "password" ? "Sign in to the inventory dashboard" : "Enter your one-time code"}
          </p>
        </div>

        {step === "password" ? (
          <form onSubmit={onPassword} className="rounded-2xl border border-border bg-surface p-6 shadow-card">
            <div className="mb-4">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="owner@hamzastore.pk" required />
            </div>
            <div className="mb-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
            </div>
            {error && <FieldError message={error} />}
            {notice && <p className="mt-1 text-xs text-green-text">{notice}</p>}
            <Button type="submit" className="mt-5 w-full" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Checking…" : "Continue"}
            </Button>
          </form>
        ) : (
          <form onSubmit={onVerify} className="rounded-2xl border border-border bg-surface p-6 shadow-card">
            <div className="mb-2">
              <Label htmlFor="code">6-digit code</Label>
              <Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="••••••"
                className="text-center text-lg tracking-[0.5em]" required autoFocus />
            </div>
            {error && <FieldError message={error} />}
            {notice && <p className="mt-1 text-xs text-green-text">{notice}</p>}
            <Button type="submit" className="mt-5 w-full" disabled={loading || code.length < 6}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Verifying…" : "Verify & sign in"}
            </Button>
            <div className="mt-3 flex items-center justify-between text-xs">
              <button type="button" onClick={() => { setStep("password"); setCode(""); setError(undefined); setNotice(undefined); }}
                className="flex items-center gap-1 font-medium text-text-tertiary hover:text-text-secondary">
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </button>
              <button type="button" onClick={onResend} disabled={cooldown > 0}
                className="font-medium text-brand-600 hover:underline disabled:text-text-tertiary disabled:no-underline">
                {cooldown > 0 ? `Resend code (${cooldown}s)` : "Resend code"}
              </button>
            </div>
          </form>
        )}

        <p className="mt-6 text-center text-xs text-text-tertiary">
          Authorized staff only · © {new Date().getFullYear()} Hamza General Store
        </p>
      </div>
    </div>
  );
}
