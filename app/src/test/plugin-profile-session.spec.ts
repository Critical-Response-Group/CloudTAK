import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { Preferences } from '@capacitor/preferences';
import type { Router } from 'vue-router';
import { PluginAPI } from '../../plugin.ts';
import { db } from '../database.ts';

vi.mock('../stores/map.ts', () => ({ useMapStore: () => ({}) }));
vi.mock('../stores/float.ts', () => ({ useFloatStore: () => ({}) }));

afterEach(async () => {
    vi.unstubAllGlobals();
    await Preferences.remove({ key: 'token' });
    await Preferences.remove({ key: 'sessionId' });
});

it('drops plugin writes queued by a session that has since changed', async () => {
    const storage = new Map<string, string>();
    vi.mocked(window.localStorage.getItem).mockImplementation(key => storage.get(key) ?? null);
    vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => { storage.set(key, value); });
    vi.mocked(window.localStorage.removeItem).mockImplementation(key => { storage.delete(key); });
    await db.profile.clear();
    await Preferences.set({ key: 'token', value: 'synthetic-a' });
    await Preferences.set({ key: 'sessionId', value: 'session-a' });

    const headers: Array<string | null> = [];
    let finishFirst = () => {};
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
        headers.push(request.headers.get('Authorization'));
        if (headers.length === 1) await new Promise<void>(resolve => { finishFirst = resolve; });
        return Response.json({ plugin_settings: { fixture: 'synthetic-value' } });
    }));

    const api = new PluginAPI(createApp({}), {} as Router, createPinia());
    const first = api.profile.setPluginSetting('first', 'one');
    const second = api.profile.setPluginSetting('second', 'two');
    await vi.waitFor(() => expect(headers).toHaveLength(1));

    await Preferences.set({ key: 'token', value: 'synthetic-b' });
    await Preferences.set({ key: 'sessionId', value: 'session-b' });
    finishFirst();

    const results = await Promise.allSettled([first, second]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(headers).toEqual(['Bearer synthetic-a']);
    expect(await db.profile.get('plugin_settings')).toBeUndefined();
});

it('keeps writing after the session refreshes its token', async () => {
    await db.profile.clear();
    await Preferences.set({ key: 'token', value: 'synthetic-a' });
    await Preferences.set({ key: 'sessionId', value: 'session-a' });

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ plugin_settings: { first: 'one' } })));

    const api = new PluginAPI(createApp({}), {} as Router, createPinia());
    const write = api.profile.setPluginSetting('first', 'one');
    await Preferences.set({ key: 'token', value: 'synthetic-a-refreshed' });
    await write;

    expect((await db.profile.get('plugin_settings'))?.value).toEqual({ first: 'one' });
});
