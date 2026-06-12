import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import {
	buildCacheRequest,
	cachedRead,
	hashToBucket,
	jsonWithWorkersCache,
	parseCacheRequest,
	readSafeSearchParam,
	rejectNonCacheableRead,
} from './cache-helpers';

const SHARD_COUNT = 256;
const ASSIGNMENT_EDGE_TTL_SECONDS = 30;
const ASSIGNMENT_STALE_SECONDS = 300;
const ASSIGNMENT_STALE_IF_ERROR_SECONDS = 3600;
const POOLS = ['pool-a', 'pool-b', 'pool-c', 'pool-d'] as const;

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
		const methodError = rejectNonCacheableRead(request);
		if (methodError) {
			return methodError;
		}

		const input = parseAssignmentCacheRequest(request);
		if (input instanceof Response) {
			return input;
		}

		const stub = this.env.STICKY_ASSIGNMENTS.getByName(`${input.endpointGroup}:${input.shard}`);
		const assignment = await stub.getAssignment(input);

		return jsonWithWorkersCache(assignment, {
			edgeTtlSeconds: ASSIGNMENT_EDGE_TTL_SECONDS,
			staleWhileRevalidateSeconds: ASSIGNMENT_STALE_SECONDS,
			staleIfErrorSeconds: ASSIGNMENT_STALE_IF_ERROR_SECONDS,
			tags: ['sticky-assignments', `endpoint:${input.endpointGroup}`, `shard:${input.shard}`],
			extraHeaders: {
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

		const methodError = rejectNonCacheableRead(request, 'Only GET and HEAD are cacheable');
		if (methodError) {
			return methodError;
		}

		const routeRequest = await buildCacheableRouteRequest(url);
		if (routeRequest instanceof Response) {
			return routeRequest;
		}

		return cachedRead(ctx.exports.CachedAssignmentLookup, routeRequest, request.method);
	},
} satisfies ExportedHandler<Env>;

async function buildCacheableRouteRequest(url: URL): Promise<Request | Response> {
	const customerId = readSafeSearchParam(url, 'customer');
	if (customerId instanceof Response) {
		return customerId;
	}

	const endpointGroup = readSafeSearchParam(url, 'endpoint', 'primary-api');
	if (endpointGroup instanceof Response) {
		return endpointGroup;
	}

	const locality = readSafeSearchParam(url, 'locality', 'global');
	if (locality instanceof Response) {
		return locality;
	}

	const shard = String(await hashToBucket(`${endpointGroup}:${customerId}`, SHARD_COUNT)).padStart(3, '0');
	return buildCacheRequest({
		resource: 'assignments',
		segments: [endpointGroup, shard, customerId],
		search: { locality },
	});
}

function parseAssignmentCacheRequest(request: Request): AssignmentRequest | Response {
	const parsed = parseCacheRequest(request, {
		resource: 'assignments',
		segmentNames: ['endpointGroup', 'shard', 'customerId'],
		searchNames: ['locality'],
	});

	if (parsed instanceof Response) {
		return parsed;
	}

	return {
		customerId: parsed.segments.customerId,
		endpointGroup: parsed.segments.endpointGroup,
		locality: parsed.search.locality,
		shard: parsed.segments.shard,
	};
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
