import { describe, expect, it } from 'vitest';
import { bareMime, googleKey, googleTranscribe, VOICE_NONE } from './google';
import { forgetRoutes, loadRoute, toRoute, voiceCost, type Route } from './routes';
import { oggSeconds, runVoice, VOICE_MAX_BYTES } from './voice';

const route: Route = toRoute({ task: 'voice', provider: 'google', model: 'g-main', fallback_provider: null, fallback_model: null, enabled: true, price_in_per_m: '0.30', price_out_per_m: '2.5', price_audio_per_m: '0.30' });
/** a minimal Ogg file: one page whose granule position says how many 48 kHz samples were played */
function ogg(seconds: number, pad = 0): Uint8Array {
  const b = new Uint8Array(27 + pad); b.set([0x4f, 0x67, 0x67, 0x53], pad);
  let g = Math.round(seconds * 48000); for (let k = 0; k < 8; k++) { b[pad + 6 + k] = g % 256; g = Math.floor(g / 256); }
  return b;
}
const heard = (text: string, audio = 960) => async () => ({ text, usage: { audio_tokens: audio, text_tokens: 120, output_tokens: 40 } });

describe('voice: route, cost, length', () => {
  it('prices come from the route; a missing price is charged at the dearest one', () => {
    expect(voiceCost(route, { audio_tokens: 1_000_000, text_tokens: 0, output_tokens: 0 })).toBe(0.3);
    expect(voiceCost(route, { audio_tokens: 960, text_tokens: 120, output_tokens: 40 })).toBeCloseTo((960 * 0.3 + 120 * 0.3 + 40 * 2.5) / 1e6, 6);
    expect(voiceCost({ price_in_per_m: null, price_out_per_m: 2.5, price_audio_per_m: null }, { audio_tokens: 1_000_000, text_tokens: 0, output_tokens: 0 })).toBe(2.5);
  });
  it('reads the length of an Ogg voice note from its last page', () => {
    expect(oggSeconds(ogg(30))).toBe(30); expect(oggSeconds(ogg(119.5, 300))).toBeCloseTo(119.5, 3);
    expect(oggSeconds(new Uint8Array(100))).toBeNull(); expect(oggSeconds(new Uint8Array(3))).toBeNull();
  });
  it('a note over 2 minutes, or over the size limit, is refused before anything is paid', async () => {
    let calls = 0; const t = async () => { calls++; return { text: 'x', usage: { audio_tokens: 1, text_tokens: 1, output_tokens: 1 } }; };
    expect(await runVoice(route, 'k', ogg(125), 'audio/ogg', t)).toEqual({ status: 'too_long' });
    expect(await runVoice(route, 'k', new Uint8Array(VOICE_MAX_BYTES + 1), 'audio/ogg', t)).toEqual({ status: 'too_long' });
    expect(calls).toBe(0);
  });
  it('the words, the model and the cost; white space tidied', async () => {
    const r = await runVoice(route, 'k', ogg(30), 'audio/ogg; codecs=opus', heard('  بدي ربطتين خبز\n و 3 pepsi '), (() => { let n = 0; return () => (n += 700); })());
    expect(r).toMatchObject({ status: 'ok', text: 'بدي ربطتين خبز و 3 pepsi', model: 'g-main', audio_tokens: 960, ms: 700 });
    expect(r.status === 'ok' && r.cost_usd).toBeCloseTo(0.000424, 6);
  });
  it('silence, noise, or only symbols: nothing heard, still costed', async () => {
    for (const t of [VOICE_NONE, '', ' … ', `${VOICE_NONE}.`]) expect(await runVoice(route, 'k', ogg(5), 'audio/ogg', heard(t))).toMatchObject({ status: 'nothing', model: 'g-main' });
  });
  it('the provider counted more audio than 2 minutes (a file whose length could not be read): too long', async () => {
    expect(await runVoice(route, 'k', new Uint8Array(50), 'audio/mp4', heard('long talk', 140 * 32))).toEqual({ status: 'too_long' });
  });
  it('the main model fails: the fallback once; no fallback: failed with the reason', async () => {
    const seen: string[] = []; const t = async (o: { model: string }) => { seen.push(o.model); if (o.model === 'g-main') throw new Error('voice_http_503: busy'); return { text: 'labne', usage: { audio_tokens: 100, text_tokens: 10, output_tokens: 5 } }; };
    expect(await runVoice({ ...route, fallback_provider: 'google', fallback_model: 'g-back' }, 'k', ogg(4), 'audio/ogg', t)).toMatchObject({ status: 'ok', text: 'labne', model: 'g-back' });
    expect(seen).toEqual(['g-main', 'g-back']);
    expect(await runVoice({ ...route, fallback_provider: 'google', fallback_model: 'g-back' }, 'k', ogg(4), 'audio/ogg', t)).toMatchObject({ fallback_from: 'g-main: voice_http_503: busy' });      // why the main model did not answer is kept
    expect(await runVoice(route, 'k', ogg(4), 'audio/ogg', t)).toEqual({ status: 'failed', error: 'voice_http_503: busy' });
    expect(await runVoice({ ...route, provider: 'anthropic' }, 'k', ogg(4), 'audio/ogg', t)).toEqual({ status: 'failed', error: 'no_voice_provider' });
  });
  it('a route is read once a minute; a failing read is "no route"', async () => {
    forgetRoutes(); let n = 0; const read = async () => { n++; return { task: 'voice', provider: 'google', model: 'm', enabled: true, price_out_per_m: 1, price_audio_per_m: 1 }; };
    expect((await loadRoute('voice', read, 1000))?.model).toBe('m'); await loadRoute('voice', read, 50_000); expect(n).toBe(1);
    await loadRoute('voice', read, 62_000); expect(n).toBe(2);
    forgetRoutes(); expect(await loadRoute('voice', async () => { throw new Error('no table'); }, 1)).toBeNull();
  });
});

describe('google adapter', () => {
  const reply = (body: unknown, status = 200) => async () => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  it('sends the audio inline, not stored, with the key in the header; reads the words and the usage', async () => {
    let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const f = async (url: string, init: { headers: Record<string, string>; body: string }) => { sent = { url, headers: init.headers, body: JSON.parse(init.body) }; return reply({ status: 'completed', steps: [{ type: 'thought', content: [{ type: 'text', text: 'hidden' }] }, { type: 'model_output', content: [{ type: 'text', text: 'بدي خبز' }] }], usage: { total_input_tokens: 1080, total_output_tokens: 12, total_thought_tokens: 8, input_tokens_by_modality: [{ modality: 'TEXT', tokens: 120 }, { modality: 'audio', tokens: 960 }] } })(); };
    const r = await googleTranscribe({ key: 'K', model: 'g-main', audio: new Uint8Array([1, 2, 3]), mime: 'audio/ogg; codecs=opus', fetch: f as never });
    expect(r).toEqual({ text: 'بدي خبز', usage: { audio_tokens: 960, text_tokens: 120, output_tokens: 20 } });
    expect(sent!.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions'); expect(sent!.headers['x-goog-api-key']).toBe('K'); expect(sent!.url).not.toContain('K');
    expect(sent!.body).toMatchObject({ model: 'g-main', store: false, input: [{ type: 'text' }, { type: 'audio', data: 'AQID', mime_type: 'audio/ogg' }] });
  });
  it('an error, a broken answer or an unfinished one is an error — never an empty transcript taken for silence', async () => {
    const a = { key: 'K', model: 'm', audio: new Uint8Array(1), mime: 'audio/ogg' };
    await expect(googleTranscribe({ ...a, fetch: reply('quota', 429) as never })).rejects.toThrow('voice_http_429');
    await expect(googleTranscribe({ ...a, fetch: reply('<html>') as never })).rejects.toThrow('voice_bad_json');
    await expect(googleTranscribe({ ...a, fetch: reply({ status: 'failed' }) as never })).rejects.toThrow('voice_status_failed');
  });
  it('the transcription model gets the audio alone; a general model starts at "minimal"; while the level itself is refused the next setting is tried (minimal → low → none), nothing else is retried', async () => {
    const done = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }], usage: { total_input_tokens: 10, total_output_tokens: 1 } };
    const levels: (string | null)[] = []; const a = { key: 'K', audio: new Uint8Array(1), mime: 'audio/ogg' };
    const f = (accepts: (string | null)[]) => async (_u: string, init: { body: string }) => { const l = (JSON.parse(init.body).generation_config.thinking_level as string | undefined) ?? null; levels.push(l); return accepts.includes(l) ? reply(done)() : reply({ error: { message: 'Thinking level is not supported for this model.' } }, 400)(); };
    let body: Record<string, unknown> = {};
    await googleTranscribe({ ...a, model: 'gemini-3.5-transcribe', fetch: (async (_u: string, init: { body: string }) => { body = JSON.parse(init.body); return reply(done)(); }) as never });
    expect(body).toEqual({ model: 'gemini-3.5-transcribe', store: false, input: [{ type: 'audio', data: 'AA==', mime_type: 'audio/ogg' }] });      // the dedicated model: the audio and nothing else
    levels.length = 0; await googleTranscribe({ ...a, model: 'gemini-3.5-flash-lite', fetch: f(['minimal']) as never }); expect(levels).toEqual(['minimal']);
    levels.length = 0; expect((await googleTranscribe({ ...a, model: 'some-new-model', fetch: f([null]) as never })).text).toBe('ok'); expect(levels).toEqual(['minimal', 'low', null]);
    levels.length = 0; await expect(googleTranscribe({ ...a, model: 'm', fetch: reply('bad audio', 400) as never })).rejects.toThrow('voice_http_400');
  });
  it('"model@ar-EG" sends the language hint to the dedicated model under its real name; a refused hint is sent again without it', async () => {
    const done = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'بدي سندويش دجاج' }] }], usage: { total_input_tokens: 10, total_output_tokens: 1 } };
    const a = { key: 'K', audio: new Uint8Array(1), mime: 'audio/ogg' }; const bodies: Record<string, unknown>[] = [];
    const f = (refuseHint: boolean) => async (_u: string, init: { body: string }) => { const b = JSON.parse(init.body); bodies.push(b); return refuseHint && b.generation_config ? reply({ error: { message: 'Unsupported language code' } }, 400)() : reply(done)(); };
    await googleTranscribe({ ...a, model: 'gemini-3.5-transcribe@ar-EG, en-US,<bad>', fetch: f(false) as never });
    expect(bodies).toEqual([{ model: 'gemini-3.5-transcribe', store: false, input: [{ type: 'audio', data: 'AA==', mime_type: 'audio/ogg' }], generation_config: { transcription_config: { language_codes: ['ar-EG', 'en-US'] } } }]);
    bodies.length = 0; expect((await googleTranscribe({ ...a, model: 'gemini-3.5-transcribe@ar-EG', fetch: f(true) as never })).text).toBe('بدي سندويش دجاج');
    expect(bodies.map(b => !!b.generation_config)).toEqual([true, false]);
    expect((await googleTranscribe({ ...a, model: 'gemini-3.5-transcribe@ar-EG', fetch: f(true) as never })).hint).toBe('refused');
    expect((await googleTranscribe({ ...a, model: 'gemini-3.5-transcribe@ar-EG', fetch: f(false) as never })).hint).toBe('used');
  });
  it('helpers', () => {
    expect(bareMime('audio/ogg; codecs=opus')).toBe('audio/ogg'); expect(bareMime('')).toBe('audio/ogg');
    expect(googleKey({ GOOGLE_AI_API_KEY: ' "abc" ' })).toBe('abc'); expect(googleKey({})).toBeNull();
  });
});
