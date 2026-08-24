// PostgREST caps every request at 1000 rows by default. A plain
// `supabase.from(t).select(...)` therefore SILENTLY returns only the first 1000
// rows once a table grows past that — the classic "products disappeared from
// Stock / POS / reports as the catalogue grew" bug. These helpers page through
// the whole result set so no row is ever dropped.
//
// IMPORTANT: give the query a STABLE, unique .order(...) inside `build` so the
// pages tile the table without overlaps or gaps (add a tie-breaker column when
// the primary sort key isn't unique).

const PAGE = 1000; // PostgREST's hard per-request cap

type QueryResult<T> = { data: T[] | null; error: unknown };

/** Fetch EVERY row of a query, 1000 at a time, and return them as one array. */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<QueryResult<T>>,
  page = PAGE,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < page) break; // last page (fewer than a full page returned)
  }
  return out;
}

/**
 * Same as {@link fetchAll} but resolves to `{ data }`, so it drops straight into
 * existing `const [{ data }] = await Promise.all([...])` call sites in place of a
 * bare `supabase.from(...).select(...)` — keeping those reads parallel.
 */
export async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<QueryResult<T>>,
  page = PAGE,
): Promise<{ data: T[] }> {
  return { data: await fetchAll<T>(build, page) };
}

// A single `.in("col", ids)` with hundreds of ids builds a URL/header long enough
// to exceed PostgREST's/the proxy's header-size limit (empirically ~450+ uuids),
// which fails the request outright rather than truncating it. Chunk the id list
// so no single request's `.in()` list grows unbounded, and paginate each chunk.
const ID_CHUNK = 150;

/** Fetch every row matching a (possibly huge) list of ids, chunked + paginated. */
export async function fetchAllByIds<T>(
  ids: string[],
  build: (chunk: string[], from: number, to: number) => PromiseLike<QueryResult<T>>,
  chunkSize = ID_CHUNK,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    out.push(...(await fetchAll<T>((from, to) => build(chunk, from, to))));
  }
  return out;
}
