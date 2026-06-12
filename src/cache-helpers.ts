const DEFAULT_INTERNAL_CACHE_ORIGIN = 'https://worker-cache.internal';
const SAFE_CACHE_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;

export type CachePolicy = {
	edgeTtlSeconds: number;
	staleWhileRevalidateSeconds?: number;
	staleIfErrorSeconds?: number;
	clientCacheControl?: string;
	tags?: string[];
	extraHeaders?: HeadersInit;
};

export type ParsedCacheRequest<SegmentName extends string, SearchName extends string> = {
	segments: Record<SegmentName, string>;
	search: Record<SearchName, string>;
};

export function rejectNonCacheableRead(request: Request, message = 'Only GET and HEAD can use Workers Caching'): Response | undefined {
	if (request.method === 'GET' || request.method === 'HEAD') {
		return undefined;
	}

	return new Response(message, {
		status: 405,
		headers: { 'Cache-Control': 'no-store' },
	});
}

export function readSafeSearchParam(url: URL, name: string, fallback?: string): string | Response {
	const value = url.searchParams.get(name)?.trim() ?? fallback;

	if (!value) {
		return badRequest(`Missing ${name}`);
	}

	return validateSafeCacheValue(name, value);
}

export function buildCacheRequest(options: {
	resource: string;
	segments: string[];
	search?: Record<string, string>;
	origin?: string;
}): Request | Response {
	const resource = validateSafeCacheValue('resource', options.resource);
	if (resource instanceof Response) {
		return resource;
	}

	const segments: string[] = [];
	for (const segment of options.segments) {
		const safeSegment = validateSafeCacheValue('cache key segment', segment);
		if (safeSegment instanceof Response) {
			return safeSegment;
		}
		segments.push(safeSegment);
	}

	const cacheUrl = new URL(options.origin ?? DEFAULT_INTERNAL_CACHE_ORIGIN);
	cacheUrl.pathname = ['', resource, ...segments.map(encodeURIComponent)].join('/');

	for (const [name, value] of Object.entries(options.search ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
		const safeName = validateSafeCacheValue('cache search name', name);
		if (safeName instanceof Response) {
			return safeName;
		}

		const safeValue = validateSafeCacheValue(name, value);
		if (safeValue instanceof Response) {
			return safeValue;
		}

		cacheUrl.searchParams.set(safeName, safeValue);
	}

	return new Request(cacheUrl, { method: 'GET' });
}

export function parseCacheRequest<SegmentName extends string, SearchName extends string>(
	request: Request,
	options: {
		resource: string;
		segmentNames: readonly SegmentName[];
		searchNames: readonly SearchName[];
	},
): ParsedCacheRequest<SegmentName, SearchName> | Response {
	const url = new URL(request.url);
	const [resource, ...segmentValues] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

	if (resource !== options.resource || segmentValues.length !== options.segmentNames.length) {
		return badRequest('Malformed cache key');
	}

	const segments = {} as Record<SegmentName, string>;
	for (const [index, name] of options.segmentNames.entries()) {
		const value = validateSafeCacheValue(name, segmentValues[index]);
		if (value instanceof Response) {
			return value;
		}
		segments[name] = value;
	}

	const search = {} as Record<SearchName, string>;
	for (const name of options.searchNames) {
		const rawValue = url.searchParams.get(name)?.trim();
		if (!rawValue) {
			return badRequest(`Missing ${name}`);
		}

		const value = validateSafeCacheValue(name, rawValue);
		if (value instanceof Response) {
			return value;
		}
		search[name] = value;
	}

	return { segments, search };
}

export function jsonWithWorkersCache(value: unknown, policy: CachePolicy, init?: ResponseInit): Response {
	const headers = withWorkersCacheHeaders(policy, init?.headers);

	return Response.json(value, {
		...init,
		headers,
	});
}

export function withWorkersCacheHeaders(policy: CachePolicy, headersInit?: HeadersInit): Headers {
	const headers = new Headers(headersInit);
	const extraHeaders = new Headers(policy.extraHeaders);

	for (const [name, value] of extraHeaders) {
		headers.set(name, value);
	}

	headers.set('Cache-Control', policy.clientCacheControl ?? 'no-store');
	headers.set('Cloudflare-CDN-Cache-Control', buildCloudflareCdnCacheControl(policy));

	if (policy.tags?.length) {
		headers.set('Cache-Tag', policy.tags.map(validateCacheTag).filter(Boolean).join(','));
	}

	return headers;
}

export async function cachedRead(
	fetchTarget: { fetch(request: Request): Response | Promise<Response> },
	cacheRequest: Request,
	method: string,
): Promise<Response> {
	const response = await fetchTarget.fetch(cacheRequest);

	if (method === 'HEAD') {
		return new Response(null, {
			status: response.status,
			headers: response.headers,
		});
	}

	return response;
}

export async function hashToBucket(input: string, bucketCount: number): Promise<number> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const view = new DataView(digest);

	return view.getUint32(0) % bucketCount;
}

export function badRequest(message: string): Response {
	return Response.json({ error: message }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
}

function validateSafeCacheValue(name: string, value: string | undefined): string | Response {
	if (!value || !SAFE_CACHE_VALUE.test(value)) {
		return badRequest(`${name} must be 1-128 chars: letters, numbers, dots, underscores, colons, or hyphens`);
	}

	return value;
}

function buildCloudflareCdnCacheControl(policy: CachePolicy): string {
	const directives = ['public', `max-age=${policy.edgeTtlSeconds}`];

	if (policy.staleWhileRevalidateSeconds !== undefined) {
		directives.push(`stale-while-revalidate=${policy.staleWhileRevalidateSeconds}`);
	}

	if (policy.staleIfErrorSeconds !== undefined) {
		directives.push(`stale-if-error=${policy.staleIfErrorSeconds}`);
	}

	return directives.join(', ');
}

function validateCacheTag(tag: string): string | undefined {
	return /^[!-~]{1,1024}$/.test(tag) ? tag : undefined;
}
