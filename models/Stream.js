const log = require('../log.js').createLogger("stream", process.env.LEVEL_STREAM);
const Promise = require('bluebird');
const { differenceInMinutes, differenceInHours } = require('date-fns');
const config = require('../config.json');
const db = require('../connection');
const twitchClient = require('../twitch');
const discordBot = require('../discord');

/**
 * @returns {import('knex').QueryBuilder<DatabaseStream>}
 */
function dbTable() {
    return db('streams');
}

function subscribeToStream(stream) {
    log.info(`subscribing to webhook for user ${stream.user_id} ${stream.user_name}...`);
    twitchClient.subscribeToUserStream(stream.user_id);
}

/**
 * @param {ApplicationStream | DatabaseStream} stream 
 */
function alertStream(stream) {
    return Promise.try(() => {
        log.debug(`Checking title for denylisted keywords: '${stream.title.toLowerCase()}'...`);
        if (stream.title && config.twitch.blacklist.keywords.some(kw => stream.title.toLowerCase().includes(kw.toLocaleLowerCase()))) {
            log.info(`Denylisted keyword found, suppressing alert for user ${stream.user_id} ${stream.user_name}`);
            return;
        }

        log.debug(`Checking for denylisted tags: '${stream.tag_ids}'...`);
        if (stream.tag_ids && config.twitch.blacklist.tagIds.some(tag => stream.tag_ids.includes(tag))) {
            log.info(`Denylisted tag found, suppressing alert for user ${stream.user_id} ${stream.user_name}`);
            return;
        }

        if (stream.user_id && config.twitch.blacklist.userIds.includes(stream.user_id)) {
            log.info(`Denylisted user ${stream.user_id} ${stream.user_name}, suppressing alert.`);
            return;
        }

        // Update the last shoutout time as it actually is being sent now.
        stream.lastShoutOut = new Date();

        // Send the alert.
        return discordBot.newStreamAlert(stream);
    });
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

module.exports = {
    getAll() {
        return dbTable();
    },
    getLive() {
        return dbTable().where('isLive', true);
    },
    setLive(userId) {
        return dbTable().update('isLive', true).where('user_id', userId);
    },
    setEnded(userId) {
        return dbTable().update({isLive: false, offline_since: new Date()}).where('user_id', userId);
    },
    /**
     * @returns {Promise<DatabaseStream>} 
     */
    getOne(userId) {
        return dbTable().where('user_id', userId).first();
    },
    /**
     * 
     * @param {ApplicationStream | TwitchStream} stream 
     * @returns {Promise<ApplicationStream>}
     */
    async create(stream) {
        log.debug(`creating new record for ${stream.user_id} ${stream.user_name} in db...`)
        return dbTable().insert(convertToDStream(stream));
    },
        /**
     * 
     * @param {DatabaseStream} stream 
     * @param {TwitchStream} [update]
     * @returns {Promise<ApplicationStream>}
     */
    async update(stream, update) {
        let updatedStream;
        log.debug(`stream of user ${stream.user_id} ${stream.user_name} being updated...`);

        if (update) {
            updatedStream = { ...stream, ...convertToDStream(update) };
        } else {
            updatedStream = stream;
        }

        return dbTable().update(stream).where('user_id', updatedStream.user_id);
    },
    /**
     * @param {ApplicationStream | TwitchStream | DatabaseStream} stream 
     */
    isAllowlisted(stream) {
        return config.twitch.whitelist.userIds.includes(stream.user_id);
    },
    /**
     * @param {DatabaseStream} stream 
     * @param {TwitchStream} update 
     */
    async goneLive(stream, update) {
        log.info(`Existing stream, seen newly live: user ${stream.user_id} ${stream.user_name}`);
        const updatedStream = { ...stream, ...(convertToDStream(update)), isLive: true, lastShoutOut: stream.lastShoutOut, offline_since: stream.offline_since };
        const lastShoutOutAgeHours = differenceInHours(new Date(), updatedStream.lastShoutOut);
        const offlineSinceMinutes = updatedStream.offline_since !== null ? differenceInMinutes(new Date(), updatedStream.offline_since) : null;

        if (offlineSinceMinutes !== null && offlineSinceMinutes < config.thresholds.reconnect_minutes) {
            log.info(`Stream went offline ${offlineSinceMinutes} minutes ago - probably just a reconnect, suppressing shoutout for user ${stream.user_id} ${stream.user_name}`)
        } else if (lastShoutOutAgeHours !== null && lastShoutOutAgeHours >= 0 && lastShoutOutAgeHours < config.thresholds.shoutout_hours && !this.isAllowlisted(updatedStream)) {
            log.info(`Stream was already shouted out ${lastShoutOutAgeHours} hours ago - suppressing shoutout for user ${stream.user_id} ${stream.user_name}`);
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
            log.info(`${firstPart} - shouting out stream for user ${stream.user_id} ${stream.user_name}`);
            try {
                await alertStream(updatedStream);
            } catch (e) {
                log.error(`Unable to trigger alert for ${stream.user_id} ${stream.user_name}: ${e}`);
            }
        }

        subscribeToStream(updatedStream);
        return this.update(updatedStream);
    },
    /**
     * @param {TwitchStream} stream 
     */
    async addNew(stream) {
        log.debug(`stream for user ${stream.user_id} ${stream.user_name} has never been parsed before! storing internal reference...`);
        log.info(`shouting out stream for new user ${stream.user_id} ${stream.user_name}`);
            const newStream = { ...stream, isLive: true, lastShoutOut: null, offline_since: null };
            try {
                await alertStream(newStream);
            } catch (e) {
                log.error(`Unable to trigger alert for ${stream.user_id} ${stream.user_name}: ${e}`)
            } finally {
                subscribeToStream(newStream);
            }
            return this.create(newStream);
    }
}