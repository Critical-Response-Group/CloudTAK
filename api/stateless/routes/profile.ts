import { Static } from '@sinclair/typebox';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import Auth from '../../common/auth.js';
import { ProfileResponse, ProfilePatchBody } from '../../common/types.js';
import type ConfigStateless from '../config.js';
import ProfileControl from '../lib/control/profile.js';

type ProfilePatchBodyType = Static<typeof ProfilePatchBody>;
type ProfilePatchValue = ProfilePatchBodyType[keyof ProfilePatchBodyType];

// batch-schema logs the whole body of a response that fails validation, so a
// profile is checked with the same options first and fails without its plugin_settings
const validProfile = (() => {
    const ajv = new Ajv({ strict: false, allErrors: true, useDefaults: true, removeAdditional: 'all', coerceTypes: true, discriminator: true });
    addFormats.default(ajv);
    return ajv.compile(ProfileResponse);
})();

function checked(profile: Static<typeof ProfileResponse>): Static<typeof ProfileResponse> {
    if (!validProfile(JSON.parse(JSON.stringify(profile)))) {
        throw new Err(400, null, 'Profile could not be read - a stored setting does not match its type');
    }

    return profile;
}

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

            res.json(checked(profile));
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

            await config.models.ProfileConfig.commit(user.email, profile_config, {
                touch: Object.keys(profile_config).some((key) => key !== 'plugin::settings'),
            });

            const profile = await profileControl.from(user.email);

            res.json(checked(profile));
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
