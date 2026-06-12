import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

const SHARD_COUNT = 256;
const ASSIGNMENT_EDGE_TTL_SECONDS = 30;
const ASSIGNMENT_STALE_SECONDS = 300;
const ASSIGNMENT_STALE_IF_ERROR_SECONDS = 3600;
const POOLS = ['pool-a', 'pool-b', 'pool-c', 'pool-d'] as const;
const SAFE_CACHE_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;

type AssignmentRequest = {
	endpointGroup: string;
	customerId: string;
	locality: string;
	shard: string;
};

type Assignment = AssignmentRequest & {
	pool: (typeof POOLS)[number];
	createdAt: number;
	updatedAt: number;
	source: 'durable-object-rpc';
};

type AssignmentRow = {
	customer_id: string;
	endpoint_group: string;
	locality: string;
	shard: string;
	pool: (typeof POOLS)[number];
	created_at: number;
	updated_at: number;
};

export class StickyAssignmentDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS assignments (
					customer_id TEXT NOT NULL,
					endpoint_group TEXT NOT NULL,
					locality TEXT NOT NULL,
					shard TEXT NOT NULL,
					pool TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					PRIMARY KEY (customer_id, endpoint_group, locality)
				);
				CREATE INDEX IF NOT EXISTS idx_assignments_endpoint_shard
					ON assignments (endpoint_group, shard);
			`);
		});
	}

	async getAssignment(input: AssignmentRequest): Promise<Assignment> {
		const row = this.ctx.storage.sql
			.exec<AssignmentRow>(
				`SELECT customer_id, endpoint_group, locality, shard, pool, created_at, updated_at
				 FROM assignments
				 WHERE customer_id = ? AND endpoint_group = ? AND locality = ?`,
				input.customerId,
				input.endpointGroup,
				input.locality,
			)
			.toArray()[0];

		if (row) {
			return assignmentFromRow(row);
		}

		const now = Date.now();
		const pool = POOLS[await hashToBucket(`${input.endpointGroup}:${input.customerId}:${input.locality}`, POOLS.length)];

		this.ctx.storage.sql.exec(
			`INSERT INTO assignments
				(customer_id, endpoint_group, locality, shard, pool, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			input.customerId,
			input.endpointGroup,
			input.locality,
			input.shard,
			pool,
			now,
			now,
		);

		return {
			...input,
			pool,
			createdAt: now,
			updatedAt: now,
			source: 'durable-object-rpc',
		};
	}
}

export class CachedAssignmentLookup extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Only GET and HEAD can use Workers Caching', {
				status: 405,
				headers: { 'Cache-Control': 'no-store' },
			});
		}

		const input = parseAssignmentCacheRequest(request);
		if (input instanceof Response) {
			return input;
		}

		const stub = this.env.STICKY_ASSIGNMENTS.getByName(`${input.endpointGroup}:${input.shard}`);
		const assignment = await stub.getAssignment(input);

		return Response.json(assignment, {
			headers: {
				'Cache-Control': 'no-store',
				'Cloudflare-CDN-Cache-Control': `public, max-age=${ASSIGNMENT_EDGE_TTL_SECONDS}, stale-while-revalidate=${ASSIGNMENT_STALE_SECONDS}, stale-if-error=${ASSIGNMENT_STALE_IF_ERROR_SECONDS}`,
				'Cache-Tag': ['sticky-assignments', `endpoint:${input.endpointGroup}`, `shard:${input.shard}`].join(','),
				'Content-Type': 'application/json',
				'X-Origin-Path': 'durable-object-rpc',
			},
		});
	}
}

export default {
	async fetch(request, _env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/') {
			return Response.json({
				usage: 'GET /route?customer=cust_123&endpoint=primary-api&locality=region-a',
				design: 'gateway fetch -> cached named WorkerEntrypoint fetch -> Durable Object RPC on cache miss',
			});
		}

		if (url.pathname !== '/route') {
			return new Response('Not Found', {
				status: 404,
				headers: { 'Cache-Control': 'no-store' },
			});
		}

		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Only GET and HEAD are cacheable', {
				status: 405,
				headers: { 'Cache-Control': 'no-store' },
			});
		}

		const routeRequest = await buildCacheableRouteRequest(url);
		if (routeRequest instanceof Response) {
			return routeRequest;
		}

		const cachedLookupResponse = await ctx.exports.CachedAssignmentLookup.fetch(routeRequest);

		if (request.method === 'HEAD') {
			return new Response(null, {
				status: cachedLookupResponse.status,
				headers: cachedLookupResponse.headers,
			});
		}

		return cachedLookupResponse;
	},
} satisfies ExportedHandler<Env>;

async function buildCacheableRouteRequest(url: URL): Promise<Request | Response> {
	const customerId = readSafeParam(url, 'customer');
	if (customerId instanceof Response) {
		return customerId;
	}

	const endpointGroup = readSafeParam(url, 'endpoint', 'primary-api');
	if (endpointGroup instanceof Response) {
		return endpointGroup;
	}

	const locality = readSafeParam(url, 'locality', 'global');
	if (locality instanceof Response) {
		return locality;
	}

	const shard = String(await hashToBucket(`${endpointGroup}:${customerId}`, SHARD_COUNT)).padStart(3, '0');
	const cacheUrl = new URL('https://assignment-cache.internal/assignments');
	cacheUrl.pathname = ['', 'assignments', encodeURIComponent(endpointGroup), shard, encodeURIComponent(customerId)].join('/');
	cacheUrl.searchParams.set('locality', locality);

	return new Request(cacheUrl, { method: 'GET' });
}

function parseAssignmentCacheRequest(request: Request): AssignmentRequest | Response {
	const url = new URL(request.url);
	const [resource, endpointGroup, shard, customerId] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	const locality = url.searchParams.get('locality')?.trim();

	if (resource !== 'assignments' || !endpointGroup || !shard || !customerId) {
		return badRequest('Malformed assignment cache key');
	}

	if (!locality) {
		return badRequest('Invalid locality');
	}

	for (const [name, value] of Object.entries({
		customer: customerId,
		endpoint: endpointGroup,
		locality,
		shard,
	})) {
		if (!value || !SAFE_CACHE_VALUE.test(value)) {
			return badRequest(`Invalid ${name}`);
		}
	}

	return { customerId, endpointGroup, locality, shard };
}

function readSafeParam(url: URL, name: string, fallback?: string): string | Response {
	const value = url.searchParams.get(name)?.trim() ?? fallback;

	if (!value) {
		return badRequest(`Missing ${name}`);
	}

	if (!SAFE_CACHE_VALUE.test(value)) {
		return badRequest(`${name} must be 1-128 chars: letters, numbers, dots, underscores, colons, or hyphens`);
	}

	return value;
}

function badRequest(message: string): Response {
	return Response.json({ error: message }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
}

function assignmentFromRow(row: AssignmentRow): Assignment {
	return {
		customerId: row.customer_id,
		endpointGroup: row.endpoint_group,
		locality: row.locality,
		shard: row.shard,
		pool: row.pool,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		source: 'durable-object-rpc',
	};
}

async function hashToBucket(input: string, bucketCount: number): Promise<number> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const view = new DataView(digest);

	return view.getUint32(0) % bucketCount;
}
