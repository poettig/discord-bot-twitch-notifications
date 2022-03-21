import * as loglib from "./log.js"
import BluebirdPromise from "bluebird"
import { differenceInMinutes, differenceInHours } from 'date-fns';
import config from "./config.json" assert { type: "json" }
import db from "./connection.js"
import * as discordBot from './discordbot.js'

const log = loglib.createLogger("stream", process.env.LEVEL_STREAM);

function dbTable() {
    return db('streams');
}

/**
 * @param {ApplicationStream | DatabaseStream} stream 
 */
function alertStream(stream) {
    return BluebirdPromise.try(() => {
        log.debug(`Checking title for denylisted keywords: '${stream.title.toLowerCase()}'...`);
        if (stream.title && config.twitch.denylist.keywords.some(kw => stream.title.toLowerCase().includes(kw.toLocaleLowerCase()))) {
            log.info(`Denylisted keyword found, suppressing alert for ${stream.user_name} (${stream.user_id}).`);
            return;
        }

        log.debug(`Checking for denylisted tags: '${stream.tag_ids}'...`);
        if (stream.tag_ids && config.twitch.denylist.tagIds.some(tag => stream.tag_ids.includes(tag))) {
            log.info(`Denylisted tag found, suppressing alert for ${stream.user_name} (${stream.user_id}).`);
            return;
        }

        if (stream.user_id && config.twitch.denylist.userIds.includes(stream.user_id)) {
            log.info(`Denylisted user, suppressing alert for ${stream.user_name} (${stream.user_id}).`);
            return;
        }

        // Update the last shoutout time as it actually is being sent now.
        stream.lastShoutOut = new Date();

        // Send the alert.
        return discordBot.newStreamAlert(stream);
    }).catch((err) => log.error(`Unable to trigger alert for ${stream.user_id} ${stream.user_name}: ${err}`));
}

/**
 * 
 * @param {ApplicationStream | TwitchStream} istream 
 * @returns {DatabaseStream} a stream object that can be digested into a database
 */
function convertToDStream(istream) {
    const { id, ...dStream } = istream;
    return {
        ...dStream,
        // @ts-ignore
        isLive: istream.isLive != null ? istream.isLive : null,
        // @ts-ignore
        lastShoutOut: istream.lastShoutOut != null ? istream.lastShoutOut : null,
        stream_id: id,
        // @ts-ignore
        offline_since: istream.offline_since != null ? istream.offline_since : null
    };
}

export function getAllLiveStreams() {
    return dbTable().where('isLive', true);
}

export function setEnded(userId) {
    return dbTable().where('user_id', userId).update({isLive: false, offline_since: new Date()});
}

export function getOne(userId) {
    return dbTable().where('user_id', userId).first();
}

/**
 *
 * @param {ApplicationStream | TwitchStream} stream
 * @returns {Promise<ApplicationStream>}
 */
export async function create(stream) {
    log.debug(`creating new record for ${stream.user_id} ${stream.user_name} in db...`)
    return dbTable().insert(convertToDStream(stream));
}

/**
 *
 * @param {DatabaseStream} stream
 * @param {TwitchStream} [update]
 * @returns {Promise<ApplicationStream>}
 */
export async function update(stream, update) {
    let updatedStream;
    log.debug(`stream of user ${stream.user_id} ${stream.user_name} being updated...`);

    if (update) {
        updatedStream = { ...stream, ...convertToDStream(update) };
    } else {
        updatedStream = stream;
    }

    return dbTable().update(stream).where('user_id', updatedStream.user_id);
}

/**
 * @param {ApplicationStream | TwitchStream | DatabaseStream} stream
 */
export function isAllowlisted(stream) {
    return config.twitch.allowlist.userIds.includes(stream.user_id);
}

/**
 * @param {DatabaseStream} stream
 * @param {TwitchStream} update
 */
export async function goneLive(stream, update) {
    log.info(`Existing stream, seen newly live: ${stream.user_name} (${stream.user_id}).`);
    const updatedStream = { ...stream, ...(convertToDStream(update)), isLive: true, lastShoutOut: stream.lastShoutOut, offline_since: stream.offline_since };
    const lastShoutOutAgeHours = differenceInHours(new Date(), updatedStream.lastShoutOut);
    const offlineSinceMinutes = updatedStream.offline_since !== null ? differenceInMinutes(new Date(), updatedStream.offline_since) : null;

    if (offlineSinceMinutes !== null && offlineSinceMinutes < config.thresholds.reconnect_minutes) {
        log.info(`Stream went offline ${offlineSinceMinutes} minutes ago - probably just a reconnect, suppressing shoutout for ${stream.user_name} (${stream.user_id}).`)
    } else if (lastShoutOutAgeHours !== null && lastShoutOutAgeHours >= 0 && lastShoutOutAgeHours < config.thresholds.shoutout_hours && !this.isAllowlisted(updatedStream)) {
        log.info(`Stream was already shouted out ${lastShoutOutAgeHours} hours ago - suppressing shoutout for ${stream.user_name} (${stream.user_id}).`);
    } else {
        let firstPart;
        if (this.isAllowlisted(updatedStream)) {
            firstPart = `User is in the allowlist`;
        } else if (lastShoutOutAgeHours === null) {
            firstPart = `Last shoutout is not set`
        } else if (lastShoutOutAgeHours < 0) {
            firstPart = `Last shoutout was a negative number of hours ago (${lastShoutOutAgeHours})`;
        } else {
            firstPart = `Last shoutout was ${lastShoutOutAgeHours} hours ago, which is over threshold`;
        }
        log.info(`${firstPart} - shouting out stream for ${stream.user_name} (${stream.user_id}).`);
        await alertStream(updatedStream);
    }

    return this.update(updatedStream);
}

/**
 * @param {TwitchStream} stream
 */
export async function addNew(stream) {
    log.debug(`Stream of ${stream.user_name} (${stream.user_id}) has never been parsed before! storing internal reference...`);
    log.info(`Shouting out stream for new user ${stream.user_name} (${stream.user_id}).`);
        const newStream = { ...stream, isLive: true, lastShoutOut: null, offline_since: null };
        await alertStream(newStream);
        return this.create(newStream);
}