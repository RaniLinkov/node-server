"use strict";

import jsonwebtoken from "jsonwebtoken";
import speakeasy from "speakeasy";
import qrcode from "qrcode";

import config from "../../config/index.js";
import utils from "../../utils.js";
import db from "../../db/index.js";
import mailer from "../../mailer/index.js";
import {badRequestError, tooManyAttemptsError} from "../../errors/index.js";
import {ERROR_MESSAGE} from "../../errors/constants.js";

const APP_NAME = config.APP_NAME;

const RS256 = "RS256";

const ACCESS_TOKEN_EXPIRES_IN = "1h";
const REFRESH_TOKEN_EXPIRES_IN = "1w";
const PASSWORD_FAILED_ATTEMPTS_LIMIT = 3;

const MFA_ACCESS_TOKEN_EXPIRES_IN = "3m";

const MFA_FAILED_ATTEMPTS_LIMIT = 3;
const MFA_LOCK_DURATION_IN_MINUTES = 15;

const BASE_32 = "base32";

const EMAIL_VERIFICATION = 'emailVerification';
const PASSWORD_RESET = 'passwordReset';

const jwt = {
    sign: (payload, secret, options = {}) =>
        new Promise((resolve, reject) =>
            jsonwebtoken.sign(payload, secret, options, (err, token) =>
                err ? reject(err) : resolve(token),
            ),
        ),
    verify: (token, secret, options = {}) =>
        new Promise((resolve) =>
            jsonwebtoken.verify(token, secret, options, (err, payload) => {
                if (err) {
                    resolve({
                        payload: null,
                        expired: err instanceof jsonwebtoken.TokenExpiredError,
                    });
                }

                resolve({payload});
            }),
        ),
};

const otpHelper = {
    generate: async (email, purpose) => {
        const filter = {email, purpose};

        const [otp] = await db.otps.read(filter);

        if (otp) {
            if (utils.time.now() < otp.expiresAt) {
                throw tooManyAttemptsError(ERROR_MESSAGE.TRY_AGAIN_LATER);
            }

            await db.otps.delete(filter);
        }

        const code = utils.otp.generate();

        const now = utils.time.now();

        const data = {
            email,
            purpose,
            code: await utils.encryption.hash(code),
            failedAttempts: 0,
            createdAt: now,
            expiresAt: utils.time.addMinutes(now, 5)
        };

        await db.otps.create(data);

        return code;
    },
    verify: async (email, code, purpose) => {
        const filter = {email, purpose};

        const [otp] = await db.otps.read(filter);

        if (!otp || utils.time.now() > otp.expiresAt || otp.failedAttempts > MFA_FAILED_ATTEMPTS_LIMIT) {
            throw badRequestError(ERROR_MESSAGE.INVALID_OTP);
        }

        if (true !== await utils.encryption.compare(code, otp.code)) {
            await db.otps.update(filter, {failedAttempts: otp.failedAttempts + 1});
            throw badRequestError(ERROR_MESSAGE.INVALID_OTP);
        }

        await db.otps.delete(filter);
    }
};

const passwordHelper = {
    failedAttempts: {
        increment: async (user) => {
            await db.users.update({userId: user.userId}, {
                passwordFailedAttempts: user.passwordFailedAttempts + 1,
                updatedAt: utils.time.now()
            });
        },
        reset: (user) => db.users.update({userId: user.userId}, {
            passwordFailedAttempts: 0,
            updatedAt: utils.time.now()
        })
    }
};

const mfaHelper = {
    failedAttempts: {
        increment: async (user) => {
            const mfaFailedAttempts = user.mfaFailedAttempts + 1;

            await db.users.update({userId: user.userId}, {
                mfaFailedAttempts,
                updatedAt: utils.time.now(),
                ...(mfaFailedAttempts > MFA_FAILED_ATTEMPTS_LIMIT && {mfaLockedUntil: utils.time.addMinutes(MFA_LOCK_DURATION_IN_MINUTES)})
            });
        },
        reset: (user) => db.users.update({userId: user.userId}, {
            mfaFailedAttempts: 0,
            mfaLockedUntil: null,
            updatedAt: utils.time.now()
        })
    }
};

export default {
    accessToken: {
        sign: (payload) =>
            jwt.sign(payload, config.PRIVATE_KEY, {
                algorithm: RS256,
                expiresIn: ACCESS_TOKEN_EXPIRES_IN,
            }),
        verify: (token) => jwt.verify(token, config.PUBLIC_KEY),
    },
    refreshToken: {
        sign: (payload) =>
            jwt.sign(payload, config.PRIVATE_KEY, {
                algorithm: RS256,
                expiresIn: REFRESH_TOKEN_EXPIRES_IN,
            }),
        verify: (token) => jwt.verify(token, config.PUBLIC_KEY),
    },
    mfa: {
        accessToken: {
            sign: (payload) =>
                jwt.sign(payload, config.MFA_SECRET, {
                    expiresIn: MFA_ACCESS_TOKEN_EXPIRES_IN,
                }),
            verify: (token) =>
                jwt.verify(token, config.MFA_SECRET),
        },
        code: {
            verify: async (user, code) => {
                if (user.mfaLockedUntil && (user.mfaLockedUntil > utils.time.now())) {
                    throw tooManyAttemptsError(ERROR_MESSAGE.TRY_AGAIN_LATER);
                }

                if (true !== speakeasy.totp.verify({secret: user.mfaSecret, encoding: BASE_32, token: code})) {
                    await mfaHelper.failedAttempts.increment(user);

                    throw badRequestError(ERROR_MESSAGE.INVALID_CODE);
                }

                await mfaHelper.failedAttempts.reset(user);
            }
        },
        setup: {
            generateParams: (userId) => {
                return new Promise((resolve, reject) => {
                    const {base32: mfaSecret, otpauth_url} = speakeasy.generateSecret({
                        name: `${APP_NAME} : ${userId}`,
                    });

                    qrcode.toDataURL(otpauth_url, (err, dataUrl) =>
                        err ? reject(err) : resolve({mfaSecret, dataUrl}),
                    );
                });
            }
        }
    },
    password: {
        verify: async (user, password) => {
            if (user.passwordFailedAttempts >= PASSWORD_FAILED_ATTEMPTS_LIMIT) {
                throw tooManyAttemptsError();
            }

            if (true !== await utils.encryption.compare(password, user.password)) {
                await passwordHelper.failedAttempts.increment(user);
                throw badRequestError(ERROR_MESSAGE.INVALID_EMAIL_OR_PASSWORD);
            }

            await passwordHelper.failedAttempts.reset(user);
        },
        reset: {
            generateVerificationCode: (email) => otpHelper.generate(email, PASSWORD_RESET),
            sendVerificationEmail: (email, code) => {
                return mailer.send(
                    email,
                    'Password reset Code',
                    `Your OTP Code is: ${code}`,
                    `Your OTP Code is: <b>${code}</b>`
                );
            },
            verify: (email, code) => otpHelper.verify(email, code, PASSWORD_RESET),
        }
    },
    email: {
        generateVerificationCode: (email) => otpHelper.generate(email, EMAIL_VERIFICATION),
        sendVerificationEmail: (email, code) => {
            return mailer.send(
                email,
                'Email verification Code',
                `Your OTP Code is: ${code}`,
                `Your OTP Code is: <b>${code}</b>`
            );
        },
        verify: async (email, code) => otpHelper.verify(email, code, EMAIL_VERIFICATION)
    },
}
