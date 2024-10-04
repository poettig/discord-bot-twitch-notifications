import * as loglib from "./log.js"
import qs from "node:querystring"
import fetch from "node-fetch"
import config from "./config.json" assert { type: "json" }
import {getRandomInt} from "./util.js";

const URL_BASE = 'https://api.twitch.tv/helix';
const log = loglib.createLogger("twitch", process.env.LEVEL_TWITCH);

let token = null;
let tokenCreationRunning = false;

export async function apiRequest({
    endpoint,
    payload = {},
    method = "GET",
    urlBase = URL_BASE,
    responseType = 'json',
    headers = {},
    noauth = false,
    retry = false,
    ratelimitedFor = 1,
    attemptsWithAllowedFailures = 1
}) {
    if (!noauth) {
        headers["Authorization"] = 'Bearer ' + token;
    }

    const compiledHeaders = { "Client-ID": config.twitch.credentials.clientId, 'Content-Type': 'application/json', ...headers };
    const params = method.toUpperCase() === 'GET' ? `?${qs.stringify(payload)}` : '';

    log.debug(`API request to: ${urlBase}${endpoint}${params}`);
    return fetch(
        `${urlBase}${endpoint}${params}`, {
        method,
        headers: compiledHeaders,
        body: method.toUpperCase() === 'POST' ? JSON.stringify(payload) : undefined,
    }).then(async (res) => {
        if (res.status === 401) {
            log.debug(`API request to ${urlBase}${endpoint}${params} was unauthorized.`);

            if (retry) {
               log.error("Got an 'unauthorized' error with a fresh token, something is wrong.");
                process.exit(1);
            }

            // Token is invalid, refresh and try again.
            await refreshToken();
            return await apiRequest({
                endpoint,
                payload,
                method,
                urlBase,
                responseType,
                headers,
                noauth,
                retry: true,
                ratelimitedFor: ratelimitedFor,
                attemptsWithAllowedFailures: attemptsWithAllowedFailures,
            });
        } else if (res.status === 429) {
            log.debug(`API request to ${urlBase}${endpoint}${params} was ratelimited.`);

            // Linear backoff with 60 second cap (time for full restore of rate limit bucket)
            const waitTime = Math.min(60, getRandomInt(5, 10) * ratelimitedFor);
            log.warn(`Ratelimited by Twitch (${ratelimitedFor}x), waiting for ${waitTime}s before retrying.`);
            await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
            log.debug(`Done waiting for ratelimit to expire, starting retry ${ratelimitedFor}...`)
            return await apiRequest({
                endpoint,
                payload,
                method,
                urlBase,
                responseType,
                headers,
                noauth,
                retry,
                ratelimitedFor: ratelimitedFor + 1,
                attemptsWithAllowedFailures: attemptsWithAllowedFailures,
            });
        } else if (res.status !== 200) {
            log.debug(`API request to ${urlBase}${endpoint}${params} failed with ${res.status}`)
            return res.status;
        } else {
            log.debug(`API request to ${urlBase}${endpoint}${params} succeeded.`)
            log.debug(`Quota left: ${res.headers.get("Ratelimit-Remaining")}`);
            if (responseType === 'json') {
                return res.json();
            } else {
                return res.text();
            }
        }
    }, async (error) => {
        if (attemptsWithAllowedFailures < 5 && (error.code === "ECONNRESET" || error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT")) {
            const waitTime = getRandomInt(5, 10) * (attemptsWithAllowedFailures);
            log.warn(`Soft failure when requesting Twitch API (${attemptsWithAllowedFailures}x), waiting for ${waitTime}s before retrying.`);
            await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
            return await apiRequest({
                endpoint,
                payload,
                method,
                urlBase,
                responseType,
                retry,
                headers,
                noauth,
                ratelimitedFor: ratelimitedFor,
                attemptsWithAllowedFailures: attemptsWithAllowedFailures + 1,
            });
        }

        // More than 5 attempts or other errors are critical
        log.error(`Too many errors occured (attempts: ${attemptsWithAllowedFailures}) when requesting Twitch API: ${error}.`);
        process.exit(1);
    });
}

async function refreshToken() {
    if (tokenCreationRunning) {
        // Wait until creation is finished, then return
        let counter = 1;
        while (tokenCreationRunning) {
            if (counter >= 10 && counter % 10 === 0) {
                log.warn(`Waiting for token creation to finish since ${counter / 10}s already...`);
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return;
    }

    tokenCreationRunning = true;
    log.debug('Requesting new OAuth token...');
    await apiRequest({
        endpoint: '/oauth2/token',
        noauth: true,
        payload: {
            client_id: config.twitch.credentials.clientId,
            client_secret: config.twitch.credentials.clientSecret,
            grant_type: 'client_credentials',
        },
        method: 'post',
        urlBase: 'https://id.twitch.tv',
    }).then(
        ({ access_token }) => {
            token = access_token;
            log.debug('Successfully got OAuth token.');
        },
        error => {
            throw Error(`Failed to get OAuth2 token: ${error}`);
        }
    ).finally(() => {
        tokenCreationRunning = false;
    });
}

/**
 * 
 * @param {string} cursor
 * @param {Array<string>} tags
 */
function getAllTags(cursor, tags = []) {
    const endpoint = '/tags/streams';

    return apiRequest({ endpoint, payload: { first: 100, after: cursor } })
        .then(({ data, pagination }) => {
            if (!data) return tags;

            const newTags = tags.concat(
                data.map(tag => ({ id: tag.tag_id, name: tag.localization_names['en-us'] }))
            );

            if (pagination.cursor) {
                return getAllTags(pagination.cursor, newTags);
            } else {
                return newTags;
            }
        });
}

function getGameId(name) {
    const endpoint = '/games';
    return apiRequest({ endpoint, payload: { name } });
}

function getStreams(games = [], cursor, streams = []) {
    const endpoint = '/streams';

    const gameIds = Array.isArray(games) ? games.join(',') : games;
    return apiRequest({ endpoint, payload: { first: 100, game_id: gameIds, after: cursor } })
        .then(({ data, pagination }) => {
            if (!data) return streams;

            const newStreams = streams.concat(data);
            if (pagination.cursor && data.length >= 100) {
                return getStreams(games, pagination.cursor, newStreams);
            } else {
                return newStreams;
            }
        });
}

function getStreamsByTagId(gameIds, tagIds) {
    return getStreams(gameIds)
        .then(streams => streams.filter(stream => stream.tag_ids && stream.tag_ids.some(id => tagIds.includes(id))));
}

function getStreamsByKeywords(gameIds, keywords) {
    return getStreams(gameIds)
        .then(streams => streams.filter(stream => stream.title && keywords.some(kw => stream.title.toLowerCase().includes(kw.toLocaleLowerCase()))));
}

export function getStreamsByMetadata(gameIds, { tagIds, keywords }) {
    log.debug('Getting twitch streams by metadata...')
    return Promise.all([
        getStreamsByTagId(gameIds, tagIds),
        getStreamsByKeywords(gameIds, keywords),
    ]).then(([ taggedStreams, kwStreams ]) => {
        // dedupe streams that are in both groups, while merging them
        return [...taggedStreams, ...kwStreams].reduce((streams, stream) => {
            if (streams.find(s => s.id === stream.id)) {
                return streams;
            } else {
                return streams.concat(stream);
            }
        }, []);
    });
}

function getUserId(username) {
    const endpoint = '/users';
    return apiRequest({ endpoint, payload: { login: username } });
}