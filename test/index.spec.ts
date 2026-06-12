import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('sticky assignment router', () => {
	it('routes cacheable lookups through the named entrypoint', async () => {
		const response = await SELF.fetch('https://example.com/route?customer=cust_123&endpoint=primary-api&locality=region-a');

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toContain('max-age=30');
		expect(response.headers.get('X-Origin-Path')).toBe('durable-object-rpc');

		const body = await response.json<{
			customerId: string;
			endpointGroup: string;
			locality: string;
			pool: string;
			source: string;
		}>();

		expect(body).toMatchObject({
			customerId: 'cust_123',
			endpointGroup: 'primary-api',
			locality: 'region-a',
			source: 'durable-object-rpc',
		});
		expect(body.pool).toMatch(/^pool-[a-d]$/);
	});

	it('persists sticky assignments in the Durable Object', async () => {
		const url = 'https://example.com/route?customer=cust_456&endpoint=secondary-api&locality=global';
		const first = await SELF.fetch(url);
		const second = await SELF.fetch(url);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await first.json()).toEqual(await second.json());
	});

	it('rejects non-cacheable methods at the gateway', async () => {
		const response = await SELF.fetch('https://example.com/route?customer=cust_123', {
			method: 'POST',
		});

		expect(response.status).toBe(405);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});
});
