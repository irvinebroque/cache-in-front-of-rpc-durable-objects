# Cache In Front Of Durable Object RPC

This is a reference pattern for putting the new Workers Caching layer in front of Durable Object work while still calling the Durable Object over RPC on cache misses.

## Design

Request path:

```text
client GET /route?... -> default Worker fetch
  -> ctx.exports.CachedAssignmentLookup.fetch(canonical GET request)
    -> Workers Caching checks CachedAssignmentLookup's cache
      -> HIT: return cached response, WorkerEntrypoint and DO do not run
      -> MISS: CachedAssignmentLookup runs and calls StickyAssignmentDurableObject.getAssignment() over RPC
```

What this deliberately does not use:

- No Workers KV.
- No module-scope or Durable Object in-memory cache.
- No old Cache API (`caches.default`, `cache.match`, `cache.put`).

The cacheable boundary is a `fetch()` handler on `CachedAssignmentLookup`, a named `WorkerEntrypoint`. Workers Caching only applies to `fetch()` invocations; custom Worker RPC methods and Durable Object invocations bypass Workers Caching.

## Why Multiple Entrypoints Matter

Durable Objects are never cached directly by Workers Caching. The workaround is to insert a Worker `fetch()` entrypoint in front of the Durable Object and put cache headers on the response from that entrypoint.

The gateway entrypoint builds a canonical internal URL:

```text
/assignments/:endpointGroup/:shard/:customerId?locality=:locality
```

Workers Caching keys by target entrypoint plus path/query string. The hostname is intentionally irrelevant, so the internal URL uses a placeholder host.

## Impact Of Per-Entrypoint Cache

If Workers Caching can be reasoned about per entrypoint, this design gets better but does not fundamentally change.

Per-entrypoint cache is valuable because `CachedAssignmentLookup` is the only entrypoint whose responses are meant to be cached. The default gateway should still run for every external request so it can validate inputs, canonicalize the request, reject non-cacheable methods, and decide which internal lookup key should be used. Keeping the cache attached to the lookup entrypoint makes the safety boundary explicit: public routing logic stays dynamic, while only normalized assignment lookups are cacheable.

Per-entrypoint cache also makes the single-Worker version more attractive. Without entrypoint-level isolation, splitting the gateway and cache lookup into separate Workers can be useful just to isolate cache behavior. With entrypoint-level cache isolation, a single Worker can keep the same separation of concerns with less deployment and service-binding overhead.

The cache key still needs to be shaped deliberately. Per-entrypoint cache separates `default.fetch` from `CachedAssignmentLookup.fetch`, but it does not remove the need for a canonical URL like:

```text
/assignments/:endpointGroup/:shard/:customerId?locality=:locality
```

Per-entrypoint cache also does not remove the `fetch()` wrapper. Durable Object invocations and custom RPC methods still bypass Workers Caching, so the cacheable unit still has to be a Worker `fetch()` entrypoint that calls the Durable Object over RPC on misses.

Net effect: per-entrypoint cache makes this pattern cleaner, safer, and easier to keep in one Worker. It does not replace the named-entrypoint wrapper unless RPC calls themselves become cacheable.

## Impact Of Cacheable RPC Calls

If Workers could cache RPC calls directly, the design would improve more substantially.

If cacheable RPC applied only to `WorkerEntrypoint` RPC methods, `CachedAssignmentLookup.fetch()` could become a typed method such as `CachedAssignmentLookup.getAssignment(input)`. That would remove the synthetic internal URL and the HTTP `Response` wrapper between the gateway and the cacheable lookup. The gateway could pass structured data directly, and the platform could key the cache by target entrypoint, method name, serialized arguments, and `ctx.props`.

If cacheable RPC also applied to Durable Object RPC methods, the wrapper entrypoint could potentially disappear entirely. The gateway could call `stub.getAssignment(input)` and have the platform cache that RPC result in front of the Durable Object. That would be the cleanest version for this workload because the cache would sit exactly at the expensive coordination boundary.

For cacheable RPC to replace this pattern safely, the platform would need equivalents for the HTTP cache controls this example depends on:

- A way to declare TTL, stale-while-revalidate, and stale-if-error for an RPC result.
- A deterministic cache key based on callee, method name, arguments, and caller context.
- Request collapsing for concurrent identical RPC calls, otherwise cold-cache bursts could still thundering-herd the Durable Object.
- Tag or prefix invalidation semantics for RPC results.
- Clear rules for errors, exceptions, streams, and non-serializable RPC return values.

Net effect: cacheable RPC would simplify the code and could remove one or both wrapper layers. Per-entrypoint cache makes the current workaround cleaner; cacheable RPC would make the workaround less necessary.

## Adoption Cost For Existing Durable Object RPC Users

For an application that already calls Durable Object RPC directly, this pattern is usually moderately invasive at the Worker boundary and minimally invasive inside the Durable Object.

The Durable Object class usually does not need to be converted back to a `fetch()`-based API. Existing read methods such as `stub.getAssignment(input)` can stay as typed RPC methods. The new code is a cacheable Worker `fetch()` entrypoint that parses a canonical cache URL, calls the existing RPC method on a miss, serializes the result into a `Response`, and attaches cache headers.

The caller does need to change. Instead of calling the Durable Object stub directly for cacheable reads, callers route those reads through the cached entrypoint. In this repo that means replacing direct call sites like:

```ts
await stub.getAssignment(input);
```

with a helper that builds the canonical internal `GET` request and calls:

```ts
await ctx.exports.CachedAssignmentLookup.fetch(cacheRequest);
```

Mutating operations, freshness-critical reads, WebSocket flows, alarms, and background jobs should continue to call the Durable Object directly. The wrapper is only for idempotent reads whose result can safely be reused.

Adoption is low effort when the existing RPC method is a pure read, has structured-cloneable or JSON-shaped arguments, returns JSON-shaped data, and already has a clear logical cache key. In that case the main tasks are adding the named entrypoint, choosing TTLs, adding tags, and changing cacheable call sites to use a small client helper.

Adoption is more invasive when the method returns streams, `Response` objects, functions, `RpcTarget` instances, stubs, or other capability-like values. It is also more invasive when the method relies on exceptions as part of the public contract, reads implicit auth state from headers instead of explicit arguments or `ctx.props`, has side effects, or needs per-request freshness. Those cases need explicit serialization, error mapping, and cache-safety review before they can go behind Workers Caching.

The riskiest part is not the RPC call itself. The riskiest part is designing the cache key and invalidation model. If the canonical URL leaves out a value that affects the result, different callers can share the wrong cached response. If it includes unstable or high-cardinality values unnecessarily, hit rate collapses and the Durable Object still sees too many misses.

## Helpers That Would Make Adoption Easier

Helpers can make this pattern feel much closer to direct RPC, even though the current cacheable boundary is still HTTP `fetch()`. This repo puts those helpers in `src/cache-helpers.ts` and uses them from `src/index.ts`.

`buildCacheRequest()` owns canonical URL construction. Call sites pass structured path and query components and receive a `Request`; they do not hand-build `/assignments/...` paths or remember query-string ordering rules.

`parseCacheRequest()` owns the reverse operation inside the cached entrypoint. It validates the resource name, maps positional path segments back to typed names, and validates required query parameters before the Durable Object RPC call runs.

`hashToBucket()` handles deterministic sharding. In this example the gateway uses it to route each logical assignment key to one of 256 Durable Objects before constructing the cache request.

`jsonWithWorkersCache()` and `withWorkersCacheHeaders()` attach the correct response headers in one place, including `Cloudflare-CDN-Cache-Control`, client-facing `Cache-Control`, and `Cache-Tag`.

`cachedRead()` hides the wrapper call from application code. Its job is to route cacheable reads through `ctx.exports.SomeCachedEntrypoint.fetch(request)` or a service binding `.fetch(request)`, while leaving direct Durable Object RPC available for bypass and mutations. It also preserves `HEAD` semantics by returning headers without a body.

`rejectNonCacheableRead()` and `readSafeSearchParam()` keep the gateway and cached entrypoint consistent about which requests are allowed into Workers Caching and which values are safe to include in a cache key.

A `defineCachedDoRpc()` helper or small registry would be the most useful abstraction. Each cacheable operation could declare its Durable Object namespace, shard function, RPC method name, argument schema, TTLs, tag builder, serializer, and deserializer. The registry could generate both the cached `fetch()` handler and the caller-side helper.

A `purgeCachedRead()` helper should mirror the tag scheme used by the cached entrypoint. Without this, reads and writes can drift: the read path may tag entries one way while the write path purges a different tag.

These helpers would reduce adoption from "rewrite call sites to know about HTTP cache wrappers" to "wrap selected read RPC methods in a cache policy." They would not remove the core platform limitation: until RPC calls themselves are cacheable, some `fetch()` wrapper still has to exist somewhere.

## Local Setup

Generate Worker runtime and binding types before type-checking a fresh clone:

```sh
npm run cf-typegen
```

`worker-configuration.d.ts` is generated by Wrangler and intentionally ignored by git.

## Cache Headers

The cached entrypoint returns:

```http
Cache-Control: no-store
Cloudflare-CDN-Cache-Control: public, max-age=30, stale-while-revalidate=300, stale-if-error=3600
Cache-Tag: sticky-assignments,endpoint:<endpoint>,shard:<shard>
```

`Cloudflare-CDN-Cache-Control` controls the Workers Caching layer while `Cache-Control: no-store` avoids asking API clients or browsers to store routing decisions.

## Multiple Worker Variant

The same design can be split into separate Workers:

```jsonc
// gateway wrangler.jsonc
{
	"services": [
		{
			"binding": "ASSIGNMENT_CACHE",
			"service": "assignment-cache-worker",
			"entrypoint": "CachedAssignmentLookup",
		},
	],
}
```

The gateway would call `env.ASSIGNMENT_CACHE.fetch(canonicalRequest)`. The callee Worker's cache is consulted before the callee runs, so a cache hit avoids both the cache Worker and the Durable Object RPC call.

## Key Limits And Caveats

- Only `GET` and `HEAD` are cacheable by Workers Caching.
- Custom RPC methods bypass Workers Caching. Expose cacheable work as `fetch()`.
- Durable Object invocations are never cached directly. Wrap them behind a Worker `fetch()` entrypoint.
- A single Durable Object has a soft limit around 1,000 requests per second for simple work, so the example shards assignments across 256 Durable Objects by deterministic hash.
- Service binding calls count toward subrequest and Worker invocation limits. A single request has a maximum of 32 Worker invocations.
- Cache key customization is not currently exposed. Shape the canonical internal URL and, for service-bound multi-tenant calls, use `ctx.props` where appropriate.
