/**
 * PROOF, in bytes, that the 304 path actually works.
 *
 * Every other test in this repo asserts behaviour. This one asserts SIZE,
 * because the outage was not a behavioural failure: /api/catalog returned
 * correct data, quickly, with no errors, for nineteen days — it just returned
 * 1.2 MB of it to every till on every poll until the Supabase egress quota was
 * gone and the whole project started 402ing, auth included.
 *
 * A regression here would look exactly the same: green tests, correct data,
 * nothing visibly wrong, and a bill climbing until every cashier is locked out
 * again. So these tests drive the REAL route handler with a REAL Request and
 * weigh the REAL serialized response. If the 304 path ever quietly starts
 * shipping a body, the byte assertions below fail loudly.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// ---------------------------------------------------------------------------
// A catalogue the size of the real one. The numbers these tests report are only
// meaningful if the payload is the payload that caused the incident.
// ---------------------------------------------------------------------------
const ROWS = 2297;

function dbRow(i: number) {
  const id = `0003662f-d4b3-4a9f-83ee-${String(i).padStart(12, "0")}`;
  return {
    variant_id: id,
    product_id: `1113662f-d4b3-4a9f-83ee-${String(i).padStart(12, "0")}`,
    product_name: `Sooper Biscuit Family Pack ${i}`,
    brand: i % 3 === 0 ? "EBM" : null,
    has_variants: false,
    is_variable_weight: false,
    sku: `SKU-${String(i).padStart(6, "0")}`,
    label: "Default",
    barcode: `896110000${String(i).padStart(4, "0")}`,
    barcodes: [`896110000${String(i).padStart(4, "0")}`],
    price: 120.5,
    cost: 90.25,
    avg_cost: 95.75,
    disc_type: null,
    disc_value: 0,
    reorder_point: 5,
    category_id: `2223662f-d4b3-4a9f-83ee-${String(i % 40).padStart(12, "0")}`,
    image_url: null,
    unit: "Pcs",
    available: 34.0,
    active: true,
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

const ALL_ROWS = Array.from({ length: ROWS }, (_, i) => dbRow(i));

/** Rows the fake PostgREST will serve; a test may swap these to force a change. */
let served = ALL_ROWS;
/** What catalog_fingerprint() returns; moves when `served` does. */
let fingerprint = "2297:f72a3676000bc1db3f8faae8a08f13c3";
let rpcCalls = 0;
let rowReads = 0;

vi.mock("@hamza/shared/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "owner@x" } } }) },
    rpc: async (fn: string) => {
      if (fn !== "catalog_fingerprint") return { data: null, error: { message: "no such fn" } };
      rpcCalls++;
      return { data: fingerprint, error: null };
    },
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        range: (from: number, to: number) => {
          if (from === 0) rowReads++;
          return Promise.resolve({ data: served.slice(from, to + 1), error: null });
        },
      };
      return q;
    },
  }),
}));

/**
 * What a client actually pays for a response: the body, plus the headers that
 * describe it. Counting only the body would flatter the 304 case, which has no
 * body at all — the honest comparison includes what it does still cost.
 */
async function weigh(res: Response) {
  const body = await res.clone().text();
  let headerBytes = 0;
  res.headers.forEach((v, k) => { headerBytes += k.length + v.length + 4; });
  return {
    status: res.status,
    bodyBytes: Buffer.byteLength(body),
    headerBytes,
    totalBytes: Buffer.byteLength(body) + headerBytes,
    etag: res.headers.get("ETag"),
  };
}

function get(ifNoneMatch?: string | null) {
  return new Request("https://admin.local/api/catalog", {
    headers: ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {},
  });
}

async function freshRoute() {
  vi.resetModules();
  served = ALL_ROWS;
  fingerprint = "2297:f72a3676000bc1db3f8faae8a08f13c3";
  rpcCalls = 0;
  rowReads = 0;
  const cache = await import("@/lib/catalog-server-cache");
  cache.reset();
  const guard = await import("@/lib/catalog-egress-guard");
  guard.reset();
  const { GET } = await import("./route");
  return { GET, cache, guard };
}

const MB = 1024 * 1024;
const report: string[] = [];

beforeEach(async () => { await freshRoute(); });

// ---------------------------------------------------------------------------
// 1. Response size, directly measured.
// ---------------------------------------------------------------------------
describe("the 304 path is measurably empty", () => {
  it("serves the FULL catalogue when the client has nothing to revalidate", async () => {
    const { GET } = await freshRoute();
    const first = await weigh(await GET(get()));

    expect(first.status).toBe(200);
    expect(first.etag).toBe('"2297:f72a3676000bc1db3f8faae8a08f13c3"');

    // Megabyte-scale, and every row present — the full payload must still work
    // when it is genuinely needed, or the "saving" is just data loss.
    expect(first.bodyBytes).toBeGreaterThan(0.9 * MB);
    expect(first.bodyBytes).toBeLessThan(1.5 * MB);
    const parsed = JSON.parse(await (await GET(get())).text());
    expect(parsed.items).toHaveLength(ROWS);

    report.push(`  full 200 : ${first.bodyBytes.toLocaleString()} B body (${(first.bodyBytes / MB).toFixed(3)} MB) + ${first.headerBytes} B headers`);
  });

  it("serves 304 with a byte-for-byte EMPTY body when nothing changed", async () => {
    const { GET } = await freshRoute();
    const first = await weigh(await GET(get()));
    const second = await weigh(await GET(get(first.etag)));

    expect(second.status).toBe(304);

    // THE assertion. If a refactor ever lets the full payload through here, the
    // entire fix is silently undone and this is the line that screams.
    expect(second.bodyBytes, "a 304 must carry no body at all").toBe(0);
    expect(second.totalBytes, "a 304 must cost hundreds of bytes, not megabytes").toBeLessThan(500);

    // Stated as a ratio too, so the failure message names the real stakes.
    expect(second.totalBytes).toBeLessThan(first.totalBytes / 1000);
    expect(second.etag, "the validator must be echoed so the client can reuse it").toBe(first.etag);

    report.push(`  304      : ${second.bodyBytes} B body + ${second.headerBytes} B headers = ${second.totalBytes} B total`);
    report.push(`  ratio    : 304 is ${(first.totalBytes / second.totalBytes).toFixed(0)}x smaller than the full payload`);
  });

  it("still sends the full payload when the catalogue really did change", async () => {
    const { GET } = await freshRoute();
    const first = await weigh(await GET(get()));

    served = ALL_ROWS.slice(0, ROWS - 1);
    fingerprint = "2296:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // Past the server TTL, so the fingerprint is re-probed.
    vi.setSystemTime(Date.now() + 60_000);
    const after = await weigh(await GET(get(first.etag)));

    expect(after.status, "a stale validator must NOT be honoured").toBe(200);
    expect(after.bodyBytes).toBeGreaterThan(0.9 * MB);
    expect(after.etag).not.toBe(first.etag);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 2. The exact scenario from the audit.
// ---------------------------------------------------------------------------
describe("the idle till, hour by hour", () => {
  it("costs 99%+ less than the 60-poll hour that drained the quota", async () => {
    const { GET } = await freshRoute();

    // The audit measured a till "sitting open and touched by nobody". Such a
    // till already holds the catalogue and (since the IndexedDB blob carries
    // the validator) already holds its ETag, so every one of the hour's 60
    // polls is a revalidation. That is the like-for-like comparison: the same
    // 60 requests, before and after.
    const POLLS_PER_HOUR = 60;
    const warmUp = await weigh(await GET(get()));
    const oldPerPoll = warmUp.totalBytes;

    let etag = warmUp.etag;
    let newHourBytes = 0;
    let notModified = 0;
    let base = Date.now();

    for (let poll = 0; poll < POLLS_PER_HOUR; poll++) {
      // Advance past the server TTL so each poll genuinely re-validates rather
      // than being answered from a warm window — the pessimistic case.
      base += 60_000;
      vi.setSystemTime(base);
      const res = await weigh(await GET(get(etag)));
      expect(res.status).toBe(304);
      notModified++;
      newHourBytes += res.totalBytes;
      etag = res.etag ?? etag;
    }
    vi.useRealTimers();

    const oldHourBytes = POLLS_PER_HOUR * oldPerPoll;
    const cut = (1 - newHourBytes / oldHourBytes) * 100;

    expect(notModified).toBe(POLLS_PER_HOUR);
    expect(cut, "must be at least a 99% reduction").toBeGreaterThanOrEqual(99);

    // Supabase never re-read the rows across the whole hour: each poll past the
    // TTL cost one 37-byte fingerprint, and the rows were read once, at open.
    expect(rowReads, "the 1.2 MB read must happen exactly once").toBe(1);
    expect(rpcCalls).toBeGreaterThan(1);

    // The same hour counted from a COLD start, so the one unavoidable full
    // load is included rather than quietly left out of the headline.
    const coldBytes = warmUp.totalBytes + newHourBytes;
    const coldCut = (1 - coldBytes / oldHourBytes) * 100;
    expect(coldCut).toBeGreaterThanOrEqual(98);

    report.push(
      `
  IDLE TILL, 60 polls / 1 hour, catalogue unchanged:
` +
      `    BEFORE      : ${POLLS_PER_HOUR} x ${oldPerPoll.toLocaleString()} B = ${(oldHourBytes / MB).toFixed(2)} MB/hour
` +
      `    AFTER (warm): ${notModified} x 304 = ${newHourBytes.toLocaleString()} B = ${(newHourBytes / 1024).toFixed(2)} kB/hour
` +
      `    CUT         : ${cut.toFixed(4)}%   (${Math.round(oldHourBytes / newHourBytes).toLocaleString()}x less)
` +
      `    incl. cold start (1 full payload + 60 x 304): ${(coldBytes / MB).toFixed(3)} MB = ${coldCut.toFixed(2)}% cut
` +
      `    Supabase row reads: ${rowReads} (was ${POLLS_PER_HOUR})`,
    );
  });

  it("a 12-hour trading day stays under a megabyte", async () => {
    const { GET } = await freshRoute();
    const first = await weigh(await GET(get()));

    // 5-minute POLL_MS -> 12 polls/hour x 12 hours.
    const POLLS = 12 * 12;
    let etag = first.etag;
    let total = first.totalBytes;
    let base = Date.now();

    for (let i = 1; i < POLLS; i++) {
      base += 5 * 60_000;
      vi.setSystemTime(base);
      const res = await weigh(await GET(get(etag)));
      expect(res.status).toBe(304);
      total += res.totalBytes;
      etag = res.etag ?? etag;
    }
    vi.useRealTimers();

    const oldDay = 60 * 12 * first.totalBytes;
    expect(total).toBeLessThan(1.5 * MB);
    report.push(
      `\n  IDLE TILL, 12h day (${POLLS} polls at 5 min):\n` +
      `    BEFORE : ${(oldDay / MB).toFixed(1)} MB/day\n` +
      `    AFTER  : ${(total / 1024).toFixed(1)} kB/day  (one full payload + ${POLLS - 1} x 304)`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The smoke detector.
// ---------------------------------------------------------------------------
describe("a silently broken validator raises the alarm", () => {
  it("warns once when full payloads outnumber what a real shop can produce", async () => {
    const { GET, guard } = await freshRoute();
    // Spied on console.warn rather than an injected callback, deliberately:
    // this asserts the ROUTE is actually wired to the guard, which is the part
    // that would be lost in a refactor. Railway captures exactly this stream.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The exact regression to catch: If-None-Match never reaches the route (a
    // proxy strips it, a header gets renamed), so every poll is a full payload.
    for (let i = 0; i < guard.FULL_PAYLOAD_THRESHOLD + 10; i++) {
      const res = await GET(get());
      expect(res.status).toBe(200);
    }

    expect(warn, "the alarm must fire exactly once per window").toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("EGRESS WARNING");
    expect(msg).toContain("If-None-Match");
    expect(guard.stats().tripped).toBe(true);
    warn.mockRestore();

    report.push(`
  guard fired after ${guard.FULL_PAYLOAD_THRESHOLD} full payloads in one window,
    driven through the real route handler (console.warn -> Railway logs)`);
  });

  it("does NOT warn while the 304 path is doing its job", async () => {
    const { GET } = await freshRoute();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = await weigh(await GET(get()));
    let etag = first.etag;
    let base = Date.now();
    for (let i = 0; i < 200; i++) {
      base += 60_000;
      vi.setSystemTime(base);
      const res = await weigh(await GET(get(etag)));
      expect(res.status).toBe(304);
      etag = res.etag ?? etag;
    }
    vi.useRealTimers();

    expect(warn, "200 healthy revalidations must be silent").not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stays quiet through a healthy day of mostly-304 traffic", async () => {
    const { guard } = await freshRoute();
    const warn = vi.fn();
    guard.reset(0);

    // A busy but healthy shop: a few real changes among many revalidations.
    for (let i = 0; i < 500; i++) guard.noteServed(i % 25 === 0 ? "full" : "304", i, warn);

    expect(warn).not.toHaveBeenCalled();
    expect(guard.stats().full).toBe(20);
    expect(guard.stats().notModified).toBe(480);
  });

  it("forgets the previous window, so one bad spell does not warn forever", async () => {
    const { guard } = await freshRoute();
    const warn = vi.fn();
    guard.reset(0);

    for (let i = 0; i < 60; i++) guard.noteServed("full", i, warn);
    expect(warn).toHaveBeenCalledTimes(1);

    guard.noteServed("304", guard.WINDOW_MS + 1, warn);
    expect(guard.stats().full).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The conditions that actually caused the incident.
// ---------------------------------------------------------------------------
describe("it survives what broke it the first time", () => {
  it("gives EVERY open screen a 304 — not just whichever polled first", async () => {
    const { GET } = await freshRoute();

    // POS, Receive and Stock each mount useCatalog independently, in separate
    // tabs, with separate caches. All three were polling every 60s; three tabs
    // was three times the egress. Each must revalidate on its own.
    const tabs = ["pos", "receive", "stock"].map((name) => ({ name, etag: null as string | null }));

    for (const tab of tabs) {
      const res = await weigh(await GET(get(tab.etag)));
      expect(res.status, `${tab.name} first load`).toBe(200);
      tab.etag = res.etag;
    }

    // All three hold the SAME validator — one catalogue, one fingerprint.
    expect(new Set(tabs.map((t) => t.etag)).size).toBe(1);

    let base = Date.now();
    for (let round = 0; round < 3; round++) {
      base += 5 * 60_000;
      vi.setSystemTime(base);
      for (const tab of tabs) {
        const res = await weigh(await GET(get(tab.etag)));
        expect(res.status, `${tab.name} poll ${round}`).toBe(304);
        expect(res.bodyBytes, `${tab.name} poll ${round} body`).toBe(0);
      }
    }
    vi.useRealTimers();

    // Nine revalidations across three tabs, and the rows were read once.
    expect(rowReads).toBe(1);
  });

  it("concurrent polls from many tills share one read and all get 304", async () => {
    const { GET } = await freshRoute();
    const first = await weigh(await GET(get()));

    vi.setSystemTime(Date.now() + 60_000);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => GET(get(first.etag))).map((p) => p.then(weigh)),
    );
    vi.useRealTimers();

    expect(results.every((r) => r.status === 304)).toBe(true);
    expect(results.every((r) => r.bodyBytes === 0)).toBe(true);
    expect(rowReads, "eight simultaneous tills, one read between them").toBe(1);
  });

  it("after a sale: one full payload for the real change, then 304s again", async () => {
    const { GET } = await freshRoute();
    const first = await weigh(await GET(get()));

    // A sale moved stock. applyStockDelta patches the till locally and drops
    // its validator, and the server's fingerprint moves too — `available` is
    // fingerprinted precisely so this is NOT missed. So the next poll is
    // genuinely a change and correctly costs a full payload.
    const sold = ALL_ROWS.map((r, i) => (i === 0 ? { ...r, available: 33.0 } : r));
    served = sold;
    fingerprint = "2297:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    let base = Date.now() + 60_000;
    vi.setSystemTime(base);
    const afterSale = await weigh(await GET(get(null)));

    expect(afterSale.status, "the sale really did change the catalogue").toBe(200);
    expect(afterSale.etag).not.toBe(first.etag);
    const items = JSON.parse(await (await GET(get())).text()).items;
    expect(items[0].available, "the till must see the NEW stock figure").toBe(33);

    // And the shop settles: every subsequent poll is free again.
    let etag = afterSale.etag;
    for (let i = 0; i < 5; i++) {
      base += 5 * 60_000;
      vi.setSystemTime(base);
      const res = await weigh(await GET(get(etag)));
      expect(res.status, `settled poll ${i}`).toBe(304);
      expect(res.bodyBytes).toBe(0);
      etag = res.etag ?? etag;
    }
    vi.useRealTimers();

    report.push(
      `\n  AFTER A SALE: 1 full payload (${(afterSale.bodyBytes / MB).toFixed(3)} MB) for the real\n` +
      `    stock change, then 5/5 polls returned 304 with an empty body.`,
    );
  });

  it("an unauthenticated request is refused before any of this runs", async () => {
    vi.resetModules();
    vi.doMock("@hamza/shared/supabase/server", () => ({
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
    }));
    const { GET } = await import("./route");
    const res = await GET(get());
    expect(res.status).toBe(401);
    vi.doUnmock("@hamza/shared/supabase/server");
  });
});

// Printed after the suite so the numbers are visible in CI output, not just
// asserted. These are the figures quoted when this fix is reported.
afterAll(() => {
  if (report.length) {
    console.log("\n=== /api/catalog — MEASURED EGRESS ===\n" + report.join("\n") + "\n");
  }
});

