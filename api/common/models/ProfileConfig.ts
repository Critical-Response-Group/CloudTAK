import { Pool } from '@openaddresses/batch-generic';
import Err from '@openaddresses/batch-error';
import { Profile, ProfileSetting } from '../schema.js';
import { and, eq, sql } from 'drizzle-orm';
import * as pgtypes from '../schema.js';

type Tx = Parameters<Parameters<Pool<typeof pgtypes>['transaction']>[0]>[0];

export default class ProfileConfigModel {
    pool: Pool<typeof pgtypes>;

    constructor(pool: Pool<typeof pgtypes>) {
        this.pool = pool;
    }

    async from(username: string): Promise<Record<string, unknown>> {
        const settings = await this.pool
            .select()
            .from(ProfileSetting)
            .where(eq(ProfileSetting.username, username));

        const config: Record<string, unknown> = {};
        for (const setting of settings) {
            try {
                config[setting.key] = JSON.parse(setting.value);
            } catch {
                config[setting.key] = setting.value;
            }
        }
        return config;
    }

    async commit(username: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
        const timestamp = new Date().toISOString();

        await this.pool.transaction(async (tx) => {
            for (const key of Object.keys(config)) {
                let raw = config[key];
                if (raw === undefined) continue;

                if (key === 'plugin::settings') {
                    raw = await this.#mergePluginSettings(tx, username, raw as Record<string, string>);
                }

                const value = typeof raw === 'string' ? raw : JSON.stringify(raw);

                await tx.insert(ProfileSetting)
                    .values({
                        username,
                        key,
                        value,
                        updated: timestamp,
                    })
                    .onConflictDoUpdate({
                        target: [ProfileSetting.username, ProfileSetting.key],
                        set: { value, updated: timestamp },
                    });
            }

            await tx.update(Profile)
                .set({ updated: timestamp })
                .where(eq(Profile.username, username));
        });

        return this.from(username);
    }

    async #mergePluginSettings(tx: Tx, username: string, incoming: Record<string, string>): Promise<Record<string, string>> {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`plugin::settings:${username}`}::text))`);

        const [current] = await tx.select({ value: ProfileSetting.value })
            .from(ProfileSetting)
            .where(and(eq(ProfileSetting.username, username), eq(ProfileSetting.key, 'plugin::settings')));

        const merged = Object.fromEntries(Object.entries({
            ...(current ? JSON.parse(current.value) as Record<string, string> : {}),
            ...incoming,
        }).filter(([, value]) => value !== ''));

        if (Object.keys(merged).length > 100) {
            throw new Err(400, null, 'A profile holds at most 100 plugin settings');
        }

        return merged;
    }
}
