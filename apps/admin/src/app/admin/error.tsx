"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, ChevronDown, ChevronRight, Copy, Check } from "lucide-react";
import { Button } from "@hamza/shared/ui/Button";
import { logError } from "@hamza/shared/log";

// Route-level error boundary for every admin screen: a friendly message + retry
// instead of a crash. Errors are reported through the central log sink.
//
// It also SHOWS the real error. Previously this rendered only "Something went
// wrong", so a crash on the till was undiagnosable from the screen alone — the
// actual message existed only in the console, which is no help when the person
// reporting the fault is a cashier with a phone camera. The details panel below
// makes the message, digest and stack readable and copyable.
//
// Outside development the panel stays collapsed behind a disclosure, so the
// customer-facing screen is still calm, but the information is one tap away.
const isDev = process.env.NODE_ENV !== "production";

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [open, setOpen] = useState(isDev);
  const [copied, setCopied] = useState(false);

  useEffect(() => { logError(error, { digest: error.digest, where: "admin-route" }); }, [error]);

  const details = [
    `Message: ${error?.message || "(no message)"}`,
    error?.name ? `Name: ${error.name}` : "",
    error?.digest ? `Digest: ${error.digest}` : "",
    `URL: ${typeof window !== "undefined" ? window.location.pathname : "-"}`,
    "",
    error?.stack || "(no stack)",
  ].filter(Boolean).join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — the text is on screen anyway */ }
  }

  return (
    <div className="flex min-h-[60vh] items-start justify-center p-6">
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-surface p-6 shadow-card">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-coral-tile text-coral-icon">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h2 className="font-heading text-lg font-semibold text-text-primary">Something went wrong</h2>
          <p className="mt-1 text-sm text-text-secondary">
            This screen hit an error. You can retry — your data is safe.
          </p>
          <Button onClick={reset} className="mt-4 w-full max-w-xs">
            <RotateCcw className="h-4 w-4" /> Try again
          </Button>
        </div>

        <div className="mt-5 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 text-left text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Error details
            <span className="ml-auto text-xs font-normal text-text-tertiary">
              {open ? "" : "tap to show"}
            </span>
          </button>

          {open && (
            <div className="mt-3">
              <div className="mb-2 flex items-start gap-2 rounded-lg bg-coral-tile px-3 py-2">
                <span className="text-sm font-medium text-coral-text">{error?.message || "(no message)"}</span>
              </div>
              <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-[11px] leading-relaxed text-text-secondary">
                {details}
              </pre>
              <Button variant="secondary" size="sm" onClick={copy} className="mt-2">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy details"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
