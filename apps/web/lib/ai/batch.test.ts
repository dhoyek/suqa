import { describe, expect, it } from 'vitest';
import { batchBody, createCleanupBatch, readBatch, getCleanupBatch } from './batch';

const png = Buffer.from([9, 8, 7]).toString('base64');
describe('Google batch for photo cleanup', () => {
  it('one inline request per photo, keyed, asking for a square picture back', () => {
    const b = batchBody([{ key: 'p1', image: new Uint8Array([1]), mime: 'image/jpeg; x=1' }, { key: 'p2', image: new Uint8Array([2]), mime: 'image/png' }], 'n');
    const reqs = b.batch.input_config.requests.requests;
    expect(reqs.map(r => r.metadata.key)).toEqual(['p1', 'p2']);
    expect(reqs[0].request.contents[0].parts[1]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'AQ==' } });
    expect(reqs[0].request.generation_config.response_modalities).toEqual(['IMAGE']);
  });
  it('sends to the model\'s batch address with the key in a header and returns the job name', async () => {
    let seen = { url: '', key: '' };
    const name = await createCleanupBatch({ key: 'K', model: 'img-1', photos: [], name: 'n', fetch: async (url, init) => { seen = { url, key: init.headers['x-goog-api-key'] }; return { ok: true, status: 200, text: async () => '{"name":"batches/abc_1"}' }; } });
    expect(name).toBe('batches/abc_1'); expect(seen.url).toMatch(/models\/img-1:batchGenerateContent$/); expect(seen.key).toBe('K');
    await expect(createCleanupBatch({ key: 'K', model: 'm', photos: [], name: 'n', fetch: async () => ({ ok: false, status: 400, text: async () => 'model not supported' }) })).rejects.toThrow(/batch_http_400: model not supported/);
  });
  it('reads the state and pictures from every documented place', () => {
    const resp = { metadata: { key: 'p1' }, response: { candidates: [{ content: { parts: [{ text: 'hi' }, { inlineData: { data: png, mimeType: 'image/png' } }] } }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 1290, thoughtsTokenCount: 10 } } };
    const a = readBatch({ metadata: { state: 'JOB_STATE_SUCCEEDED' }, response: { inlinedResponses: { inlinedResponses: [resp, { metadata: { key: 'p2' }, error: { message: 'blocked' } }] } } });
    expect(a.done).toBe(true); expect(a.items[0].key).toBe('p1'); expect(a.items[0].image?.mime).toBe('image/png');
    expect(Array.from(a.items[0].image!.data)).toEqual([9, 8, 7]); expect(a.items[0].output_tokens).toBe(1300); expect(a.items[1].error).toBe('blocked');
    const b = readBatch({ state: 'JOB_STATE_SUCCEEDED', done: true, dest: { inlinedResponses: [resp] } });
    expect(b.items.length).toBe(1);
    expect(readBatch({ metadata: { state: 'JOB_STATE_RUNNING' } })).toEqual({ state: 'JOB_STATE_RUNNING', done: false, items: [] });
  });
  it('refuses a job name that is not Google\'s shape', async () => {
    await expect(getCleanupBatch({ key: 'K', name: '../x', fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }) })).rejects.toThrow('batch_bad_name');
  });
});
