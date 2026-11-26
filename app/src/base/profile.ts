import { db, liveQuery } from '../database.ts'
import type { DBProfileConfig } from '../database.ts';
import { server } from '../std.ts';
import type { Profile } from '../types.ts';
import type { Subscription } from 'dexie';

export default class ProfileConfig<K extends keyof Profile = keyof Profile> {
    key: K;
    value: Profile[K];
    _sub?: Subscription;

    constructor(
        key: K,
        value: Profile[K],
    ) {
        this.key = key;
        this.value = value;
    }

    subscribe(): void {
        if (this._sub) return;

        this._sub = liveQuery(() => db.profile.get(this.key)).subscribe((entry) => {
            if (entry) this.value = entry.value as Profile[K];
        });
    }

    subscribed(): boolean {
        return !!this._sub;
    }

    destroy(): void {
        if (this._sub) {
            this._sub.unsubscribe();
        }
    }

    static async get<K extends keyof Profile>(key: K): Promise<ProfileConfig<K> | undefined> {
        const entry = await db.profile.get(key);
        if (!entry) return undefined;
        return new ProfileConfig<K>(entry.key as K, entry.value as Profile[K]);
    }

    static async fetch(): Promise<Profile> {
        const { data, error } = await server.GET('/api/profile', {});
        if (error || !data) throw new Error('Failed to fetch profile');
        return data as unknown as Profile;
    }

    /**
     * Save locally then on the server, stamping the value again once the server
     * has it so a profile fetched in between does not replace it
     */
    async commit(value: Profile[K]): Promise<void> {
        const written = Date.now();
        await db.profile.put({
            key: this.key,
            value,
            updated: written
        });

        await server.PATCH('/api/profile', {
            body: { [this.key]: value } as Record<string, unknown>
        });

        await db.transaction('rw', db.profile, async () => {
            const entry = await db.profile.get(this.key);
            if ((entry?.updated ?? 0) > written) return;
            await db.profile.put({ key: this.key, value, updated: Date.now() });
        });
    }

    static async delete(key: string): Promise<void> {
        await db.profile.delete(key);
    }

    static async sync(opts: {
        refresh?: boolean,
    }  = {}): Promise<void> {
        const count = await db.profile.count();
        if (count > 0 && !opts.refresh) return;

        const started = Date.now();
        const fresh = await this.fetch();
        await this.saveAll(fresh, started);
    }

    /**
     * Store a profile fetched from the server, skipping values this device
     * wrote after `started`, when the request for it began
     */
    static async saveAll(profile: Profile, started: number): Promise<void> {
        await db.transaction('rw', db.profile, async () => {
            const keys = Object.keys(profile);
            const existing = await db.profile.bulkGet(keys);

            const entries: DBProfileConfig[] = [];
            keys.forEach((key, i) => {
                if ((existing[i]?.updated ?? 0) >= started) return;
                entries.push({
                    key,
                    value: profile[key as keyof Profile]
                });
            });

            await db.profile.bulkPut(entries);
        });
    }

    /**
     * Keep a string for a plugin in `plugin_settings`, an empty string removes it.
     * Only this key changes locally, so responses arriving out of order lose nothing
     */
    static async setPluginSetting(key: string, value: string): Promise<void> {
        const { error } = await server.PATCH('/api/profile', {
            body: { plugin_settings: { [key]: value } }
        });

        if (error) throw new Error(error.message);

        await db.transaction('rw', db.profile, async () => {
            const entry = await db.profile.get('plugin_settings');
            const settings = Object.fromEntries(Object.entries({
                ...entry?.value as Record<string, string> | undefined,
                [key]: value
            }).filter(([, setting]) => setting !== ''));

            await db.profile.put({ key: 'plugin_settings', value: settings, updated: Date.now() });
        });
    }
}
