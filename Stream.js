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

async function announceStream(twitchStream) {
    log.debug(`Checking title for denylisted keywords: '${twitchStream.title.toLowerCase()}'...`);
    if (twitchStream.title && config.twitch.denylist.keywords.some(kw => twitchStream.title.toLowerCase().includes(kw.toLocaleLowerCase()))) {
        log.info(`Denylisted keyword found, suppressing alert for ${twitchStream.user_name} (${twitchStream.user_id}).`);
        return false;
    }

    log.debug(`Checking for denylisted tags: '${twitchStream.tag_ids}'...`);
    if (twitchStream.tag_ids && config.twitch.denylist.tagIds.some(tag => twitchStream.tag_ids.includes(tag))) {
        log.info(`Denylisted tag found, suppressing alert for ${twitchStream.user_name} (${twitchStream.user_id}).`);
        return false;
    }

    if (twitchStream.user_id && config.twitch.denylist.userIds.includes(twitchStream.user_id)) {
        log.info(`Denylisted user, suppressing alert for ${twitchStream.user_name} (${twitchStream.user_id}).`);
        return false;
    }

    // Send the alert.
    return discordBot.newStreamAnnouncement(twitchStream).then(
        () => true,
        (err) => {
            log.error(`Unable to trigger alert for ${twitchStream.user_id} ${twitchStream.user_name}: ${err}`);
            return false;
        }
    );
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

export async function createNewStreamInDB(twitchStream) {
    log.debug(`creating new record for ${twitchStream.user_id} ${twitchStream.user_name} in db...`)
    return dbTable().insert({
        user_id: twitchStream.user_id,
        user_name: twitchStream.user_name,
        isLive: 1,
        lastShoutOut: null,
        offline_since: null
    });
}

export async function updateStreamInDB(userID, userName, isLive, lastShoutOut, offlineSince) {
    let updatedStream;
    log.debug(`Database row of user ${userName} (${userID}) being updated...`);
    return dbTable().update({
        user_name: userName,
        isLive: isLive,
        lastShoutOut: lastShoutOut,
        offline_since: offlineSince
    }).where('user_id', userID);
}

export function isAllowlisted(twitchStream) {
    return config.twitch.allowlist.userIds.includes(twitchStream.user_id);
}

export async function streamGoneLive(twitchStream, dbRow) {
    log.info(`Existing stream, seen newly live: ${twitchStream.user_name} (${twitchStream.user_id}).`);
    const lastShoutOutAgeHours = differenceInHours(new Date(), dbRow.lastShoutOut);
    const offlineSinceMinutes = dbRow.offline_since !== null ? differenceInMinutes(new Date(), dbRow.offline_since) : null;

    let shoutoutGiven = false;
    let isAllowlisted = this.isAllowlisted(twitchStream);
    let streamInfoString = `${twitchStream.user_name} (${twitchStream.user_id})`;

    if (offlineSinceMinutes !== null && offlineSinceMinutes < config.thresholds.reconnect_minutes) {
        log.info(`Stream went offline ${offlineSinceMinutes} minutes ago - probably just a reconnect, suppressing shoutout for ${streamInfoString}.`)
        return false;
    } else if (lastShoutOutAgeHours !== null && lastShoutOutAgeHours >= 0 && lastShoutOutAgeHours < config.thresholds.shoutout_hours && !isAllowlisted) {
        log.info(`Stream was already shouted out ${lastShoutOutAgeHours} hours ago - suppressing shoutout for ${streamInfoString}.`);
        return false;
    } else {
        let firstPart;
        if (isAllowlisted) {
            firstPart = `User is in the allowlist`;
        } else if (lastShoutOutAgeHours === null) {
            firstPart = `Last shoutout is not set`
        } else if (lastShoutOutAgeHours < 0) {
            firstPart = `Last shoutout was a negative number of hours ago (${lastShoutOutAgeHours})`;
        } else {
            firstPart = `Last shoutout was ${lastShoutOutAgeHours} hours ago, which is over threshold`;
        }

        log.info(`${firstPart} - shouting out stream for ${streamInfoString}.`);
        return announceStream(twitchStream);
    }
}

export async function announceNewStream(twitchStream) {
    log.debug(`Stream of ${twitchStream.user_name} (${twitchStream.user_id}) has never been parsed before! storing internal reference...`);
    log.info(`Shouting out stream for new user ${twitchStream.user_name} (${twitchStream.user_id}).`);
    return announceStream(twitchStream);
}