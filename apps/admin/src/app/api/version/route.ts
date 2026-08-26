import { NextResponse } from "next/server";

// The build the SERVER is currently running.
//
// A Next.js App Router page never reloads itself. A till browser opened on
// Monday keeps running the JavaScript it downloaded on Monday, however many
// times the app is deployed underneath it — which is exactly how a shop ended
// up scanning against a bundle that predated a scanning fix, with no sign that
// anything was out of date. There is no service worker here to blame: a
// long-lived tab is simply a long-lived tab.
//
// The client compares this against NEXT_PUBLIC_BUILD_ID, which next.config.mjs
// inlines into the bundle at BUILD time. When the two differ, the page in front
// of the cashier is older than the server and says so.
//
// Both sides read the same Railway-provided commit SHA: it is present in the
// build environment (so it gets inlined) and in the runtime environment (so
// this route reports the deployment actually serving). Where it is absent —
// local dev, or any host that does not provide it — both sides are empty, the
// comparison is skipped, and nothing is ever claimed.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { buildId: process.env.RAILWAY_GIT_COMMIT_SHA ?? "" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
