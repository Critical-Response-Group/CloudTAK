import { Static } from '@sinclair/typebox';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import Auth from '../../common/auth.js';
import { ProfileResponse, ProfilePatchBody } from '../../common/types.js';
import type ConfigStateless from '../config.js';
import { sql } from 'drizzle-orm';
import ProfileControl from '../lib/control/profile.js';

type ProfilePatchBodyType = Static<typeof ProfilePatchBody>;
type ProfilePatchValue = ProfilePatchBodyType[keyof ProfilePatchBodyType];

export default async function router(schema: Schema, config: ConfigStateless) {
    const profileControl = new ProfileControl(config);

    await schema.get('/profile', {
        name: 'Get Profile',
        group: 'Profile',
        description: 'Get User\'s Profile',
        res: ProfileResponse,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            const profile = await profileControl.from(user.email);

            res.json(profile);
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.patch('/profile', {
        name: 'Update Profile',
        group: 'Profile',
        description: 'Update User\'s Profile',
        body: ProfilePatchBody,
        res: ProfileResponse,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);

            const profileBody = req.body as ProfilePatchBodyType;
            const profile_config: Record<string, ProfilePatchValue> = {};
            for (const key of Object.keys(profileBody) as Array<keyof ProfilePatchBodyType>) {
                profile_config[String(key).replace('_', '::')] = profileBody[key];
            }

            if (profileBody.plugin_settings) {
                const current = await config.models.ProfileConfig.from(user.email);
                const plugin_settings = Object.fromEntries(Object.entries({
                    ...current['plugin::settings'] as Record<string, string> | undefined,
                    ...profileBody.plugin_settings,
                }).filter(([, value]) => value !== ''));

                if (Object.keys(plugin_settings).length > 100) {
                    throw new Err(400, null, 'A profile holds at most 100 plugin settings');
                }

                profile_config['plugin::settings'] = plugin_settings;
            }

            await config.models.ProfileConfig.commit(user.email, profile_config);

            await config.models.Profile.commit(user.email, {
                updated: sql`Now()`,
            });

            const profile = await profileControl.from(user.email);

            res.json(profile);
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
