import * as loglib from "./log.js"
import qs from "node:querystring"
import fetch from "node-fetch"
import config from "./config.json" assert { type: "json" }

const URL_BASE = 'https://api.twitch.tv/helix';
const log = loglib.createLogger("twitch", process.env.LEVEL_TWITCH);

let token;

export function apiRequest({
    endpoint,
    payload = {},
    method = "GET",
    urlBase = URL_BASE,
    responseType = 'json',
    headers = {},
    retries = 1,
    noauth = false
}) {

    if (!noauth) {
        headers["Authorization"] = 'Bearer ' + token;
    }

    const compiledHeaders = { "Client-ID": config.twitch.credentials.clientId, 'Content-Type': 'application/json', ...headers };
    const params = method.toUpperCase() === 'GET' ? `?${qs.stringify(payload)}` : '';

    log.debug(`API request to: ${urlBase}${endpoint}${params}`);
    return fetch(`${urlBase}${endpoint}${params}`, {
        method,
        headers: compiledHeaders,
        body: method.toUpperCase() === 'POST' ? JSON.stringify(payload) : undefined,
    }).then((res) => {
        if (res.status === 401) {
            // Token most likely expired. Get a new one as client-credentials tokens can't be refreshed.
            token = null;

            if (retries === 0) {
                log.error("API request failed with authentication failure.");
                log.info(res);
                process.exit(1);
            }

            throw new Error();
        } else if (res.status !== 200) {
            return res.status;
        } else {
            log.debug(`Quota left: ${res.headers.get("Ratelimit-Remaining")}`);
            if (responseType === 'json') {
                return res.json();
            } else {
                return res.text();
            }
        }
    }).then((value) => {
        return value;
    }, () => {
        // Get new token and retry
        log.info("OAuth token expired, getting a new one...");
        token = null;
        ensureToken().then(() => {
            // Retry. Exit condition is "retries == 0" two thens above.
            return apiRequest({
                endpoint,
                payload,
                method,
                urlBase,
                responseType,
                headers,
                retries: retries - 1
            });
        });
    });
}

/**
 * @returns {Promise<string>}
 */
export function ensureToken() {
    return new Promise((resolve, reject) => {
        // @TODO: implement token expiration handling
        if (token) {
            resolve(token);
            return;
        }

        log.debug('Requesting new OAuth token...');
        apiRequest({
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
                resolve(token);
            },
            error => {
                reject(`Failed to get OAuth2 token: ${error}`)
            }
        );
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

/**
 * 
 * @param {Array<string>} gameIds 
 * @param {Array<string>} tagIds
 * @returns {Promise<TwitchStream[]>}
 */
function getStreamsByTagId(gameIds, tagIds) {
    return getStreams(gameIds)
        .then(streams => streams.filter(stream => stream.tag_ids && stream.tag_ids.some(id => tagIds.includes(id))));
}

/**
 * 
 * @param {Array<string>} gameIds 
 * @param {Array<string>} keywords
 * @returns {Promise<TwitchStream[]>}
 */
function getStreamsByKeywords(gameIds, keywords) {
    return getStreams(gameIds)
        .then(streams => streams.filter(stream => stream.title && keywords.some(kw => stream.title.toLowerCase().includes(kw.toLocaleLowerCase()))));
}

/**
 * Exported alias for getStreamsByTagId
 * @param {Array<string>} gameIds
 * @param {{ tagIds: Array<string>, keywords: Array<string> }} options
 * @returns {Promise<Array<TwitchStream>>}
 */
export function getStreamsByMetadata(gameIds, { tagIds, keywords }) {
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