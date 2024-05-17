import requestValidator from "../../middleware/requestValidator.js";
import utils from "../../utils.js";
import services from "../../services/index.js";
import BadRequestError from "../../errors/BadRequestError.js";
import UnauthorizedError from "../../errors/UnauthorizedError.js";
import {ERROR_MESSAGE} from "../../constants.js";
import ForbiddenError from "../../errors/ForbiddenError.js";

const terminateUserSession = async (userId) => {
    const [session] = await services.sessions.read(undefined, userId);

    if (session) {
        await services.sessions.delete(session.sessionId, undefined);
        await services.sessions.blackList(session.sessionId);
    }
};

const handleUserSessionCreation = async (userId) => {
    const [session] = await services.sessions.create(userId);

    return {
        accessToken: await services.auth.accessToken.sign({userId, sessionId: session.sessionId}),
        refreshToken: await services.auth.refreshToken.sign({sessionId: session.sessionId}),
    };
};

const handleSuccessfulSignIn = async (userId, res) => {
    await terminateUserSession(userId);

    const {accessToken, refreshToken} = await handleUserSessionCreation(userId);

    res.status(201).refreshTokenCookie(refreshToken).items({accessToken});
};

export default {
    signUp: {
        validator: requestValidator({
            body: utils.joi.object({
                email: utils.joi.schemas.user.email.required(),
                password: utils.joi.schemas.user.password.required(),
                name: utils.joi.schemas.user.name.required(),
            }),
        }),
        handler: async (req, res) => {
            const [user] = await services.users.read(undefined, req.body.email);

            if (user) {
                throw new BadRequestError();
            }

            await services.users.create(req.body.email, req.body.password, req.body.name);

            res.status(201).items();
        }
    },
    signIn: {
        validator: requestValidator({
            body: utils.joi.object({
                email: utils.joi.schemas.user.email.required(),
                password: utils.joi.schemas.user.password.required(),
            }),
        }),
        handler: async (req, res) => {
            const [user] = await services.users.read(undefined, req.body.email);

            if (!user) {
                throw new BadRequestError(ERROR_MESSAGE.INVALID_EMAIL_OR_PASSWORD);
            }

            if (user.verified !== true) {
                throw new ForbiddenError(ERROR_MESSAGE.USER_NOT_VERIFIED);
            }

            await services.auth.password.verify(user, req.body.password);

            if (user.mfaEnabled === true) {
                return res.items({
                    mfaAccessToken: await services.auth.mfa.accessToken.sign({userId: user.userId})
                });
            } else {
                await handleSuccessfulSignIn(user.userId, res);
            }
        }
    },
    signOut: {
        handler: async (req, res) => {
            await terminateUserSession(req.userId);

            res.refreshTokenCookie("").items();
        }
    },
    token: {
        get: {
            handler: async (req, res) => {
                const refreshToken = req.cookies["refreshToken"];

                if (!refreshToken) {
                    throw new BadRequestError();
                }

                const {payload} = await services.auth.refreshToken.verify(refreshToken);

                if (null === payload || true === await services.sessions.isBlackListed(payload.sessionId)) {
                    throw new UnauthorizedError();
                }

                const [session] = await services.sessions.read(payload.sessionId);

                if (!session) {
                    throw new BadRequestError();
                }

                res.items({
                    accessToken: await services.auth.accessToken.sign({
                        userId: session.userId,
                        sessionId: payload.sessionId,
                        ...(payload.workspaceId && {workspaceId: payload.workspaceId}),
                    })
                });
            }
        }
    },
    email: {
        requestVerification: {
            validator: requestValidator({
                body: utils.joi.object({
                    email: utils.joi.schemas.user.email.required(),
                }),
            }),
            handler: async (req, res) => {
                const [user] = await services.users.read(undefined, req.body.email);

                if (!user) {
                    throw new BadRequestError();
                }

                if (true === user.verified) {
                    return res.items();
                }

                const code = await services.auth.email.generateVerificationCode(req.body.email);

                services.auth.email.sendVerificationEmail(req.body.email, code).then(() => {
                    req.logger.info(`Email verification code sent to ${req.body.email}`);
                }).catch((error) => {
                    req.logger.error(`Failed to send email verification code to ${req.body.email}: ${error.message}`);
                });

                res.items();
            }
        },
        verify: {
            validator: requestValidator({
                body: utils.joi.object({
                    email: utils.joi.schemas.user.email.required(),
                    code: utils.joi.schemas.otp.required(),
                }),
            }),
            handler: async (req, res) => {
                const [user] = await services.users.read(undefined, req.body.email);

                if (!user) {
                    throw new BadRequestError();
                }

                if (true === user.verified) {
                    return res.items();
                }

                await services.auth.email.verify(req.body.email, req.body.code);

                await services.users.update(user.userId, {verified: true});

                res.items();
            }
        }
    },
    password: {
        reset: {
            requestVerification: {
                validator: requestValidator({
                    body: utils.joi.object({
                        email: utils.joi.schemas.user.email.required()
                    }),
                }),
                handler: async (req, res) => {
                    const [user] = await services.users.read(undefined, req.body.email);

                    if (!user) {
                        throw new BadRequestError();
                    }

                    const code = await services.auth.password.generateVerificationCode(req.body.email);

                    services.auth.password.reset.sendVerificationEmail(req.body.email, code).then(() => {
                        req.logger.info(`Password reset code sent to ${req.body.email}`);
                    }).catch((error) => {
                        req.logger.error(`Failed to send password reset code to ${req.body.email}: ${error.message}`);
                    });

                    res.items();
                }
            },
            verify: {
                validator: requestValidator({
                    body: utils.joi.object({
                        email: utils.joi.schemas.user.email.required(),
                        code: utils.joi.schemas.otp.required(),
                        password: utils.joi.schemas.user.password.required(),
                    }),
                }),
                handler: async (req, res) => {
                    const [user] = await services.users.read(undefined, req.body.email);

                    if (!user) {
                        throw new BadRequestError();
                    }

                    if (true === user.verified) {
                        return res.items();
                    }

                    await services.auth.password.reset.verify(req.body.email, req.body.code);

                    await services.users.update(user.userId, {verified: true, password: req.body.password});

                    res.items();
                }
            }
        }
    },
    mfa: {
        verify: {
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

                if (user.verified !== true) {
                    throw new ForbiddenError(ERROR_MESSAGE.USER_NOT_VERIFIED);
                }

                if (user.mfaEnabled !== true) {
                    throw new BadRequestError(ERROR_MESSAGE.MFA_NOT_ENABLED);
                }

                await services.auth.mfa.code.verify(user, req.body.code);

                await handleSuccessfulSignIn(user.userId, res);
            }
        }
    }
};