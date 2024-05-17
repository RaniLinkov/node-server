import services from "../../services/index.js";
import BadRequestError from "../../errors/BadRequestError.js";
import requestValidator from "../../middleware/requestValidator.js";
import utils from "../../utils.js";
import {ERROR_MESSAGE} from "../../constants.js";

export default {
    get: {
        handler: async (req, res) => {
            const [user] = await services.users.read(req.userId, undefined);

            if (!user) {
                throw new BadRequestError();
            }

            return res.items({
                userId: user.userId,
                email: user.email,
                name: user.name
            });
        }
    },
    put: {
        validator: requestValidator({
            body: utils.joi.object({
                name: utils.joi.schemas.user.name
            })
        }),
        handler: async (req, res) => {
            if (!(await services.users.read(req.userId, undefined))) {
                throw new BadRequestError();
            }

            const [user] = await services.users.update(req.userId, {name: req.body.name});

            return res.items({
                userId: user.userId,
                email: user.email,
                name: user.name
            });
        }
    },
    password: {
        update: {
            validator: requestValidator({
                body: utils.joi.object({
                    currentPassword: utils.joi.schemas.user.password.required(),
                    newPassword: utils.joi.schemas.user.password.required()
                })
            }),
            handler: async (req, res) => {
                const [user] = await services.users.read(req.userId, undefined);

                if (!user) {
                    throw new BadRequestError();
                }

                if (await services.auth.password.verify(user, req.body.currentPassword) !== true) {
                    throw BadRequestError(ERROR_MESSAGE.INVALID_EMAIL_OR_PASSWORD);
                }

                await services.users.update(req.userId, {password: req.body.newPassword, passwordFailedAttempts: 0});

                return res.items();
            }
        }
    },
    mfa: {
        setup: {
            handler: async (req, res) => {
                const {mfaSecret, dataUrl} = await services.auth.mfa.setup.generateParams(req.userId);

                await services.users.update(req.userId, {mfaSecret});

                res.items({mfaSecret, dataUrl});
            }
        },
        enable: {
            validator: requestValidator({
                body: utils.joi.object({
                    code: utils.joi.schemas.otp.required(),
                }),
            }),
            handler: async (req, res) => {
                const [user] = await services.users.read(req.userId, undefined);

                if (!user) {
                    throw new BadRequestError();
                }

                if (user.mfaEnabled) {
                    throw BadRequestError("already enabled.");
                }

                if (await services.auth.mfa.code.verify(user.mfaSecret, req.body.code) !== true) {
                    throw BadRequestError(ERROR_MESSAGE.INVALID_MFA_TOKEN);
                }

                await services.users.update(req.userId, {mfaEnabled: true});

                res.items();
            }
        },
        disable: {
            validator: requestValidator({
                body: utils.joi.object({
                    code: utils.joi.schemas.otp.required(),
                }),
            }),
            handler: async (req, res) => {
                const [user] = await services.users.read(req.userId, undefined);

                if (!user) {
                    throw new BadRequestError();
                }

                if (user.mfaEnabled !== true) {
                    throw new BadRequestError(ERROR_MESSAGE.MFA_NOT_ENABLED);
                }

                if (await services.auth.mfa.code.verify(user.mfaSecret, req.body.code) !== true) {
                    throw new BadRequestError(ERROR_MESSAGE.INVALID_MFA_TOKEN);
                }

                await services.users.update(req.userId, {mfaEnabled: false, mfaSecret: null});

                res.items();
            }
        }
    }
}
