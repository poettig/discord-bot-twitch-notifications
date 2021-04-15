const log = require('./log.js').createLogger("app", process.env.LEVEL_APP)
const Promise = require('bluebird');
const express = require('express');
const bodyParser = require('body-parser');
const twitchClient = require('./twitch');
const config = require('./config.json');
const Stream = require('./models/Stream');
const Discord = require('./discord');
const db = require('./connection');
const fetch = require('node-fetch');

const app = express();

app.use('/streamUpdate/:userId', bodyParser.json(), async (req, res) => {
    log.debug('Webhook received', req.params.userId);
    const userId = req.params.userId;

    if (req.query['hub.challenge']) {
        log.debug(`Verification request received on webhook for user ${userId} with challenge ${req.query['hub.challenge']}`);
        return res.send(req.query['hub.challenge']);
    }

    if (Array.isArray(req.body.data) && !req.body.data.length) {
        log.debug(`End of stream webhook came in for user id ${userId}, unsubscribing...`);
        await Stream.setEnded(userId);
        return twitchClient.unsubscribeFromUserStream(userId).then(() => res.sendStatus(200));
    } else {
        log.debug(`Non-empty webhook came in for user id ${userId}, leaving alone`);
    }

    return res.sendStatus(200);
});

/**
 * 
 * @param {Array<TwitchStream>} streams 
 */
function validateStreams(streams) {
    return Promise.map(streams, async (stream) => {
        const existingStream = await Stream.getOne(stream.user_id);

        // Stupid new fields that twitch added and break the database, yeet them.
        delete stream["user_login"];
        delete stream["game_name"];
        delete stream["is_mature"];

        if (existingStream && existingStream.isLive) {
            return Stream.update(existingStream, stream);
        } else if (existingStream) {
            return Stream.goneLive(existingStream, stream);
        } else {
            return Stream.addNew(stream);
        }
    })
}

async function checkStreams() {
    Promise.try(() => {
        log.debug('Verifying current webhook subs...');
        return twitchClient.getAllWebhooks()
    }).then((subs) => {
        log.debug('Getting twitch streams by metadata...')
        return twitchClient.getStreamsByMetadata(config.twitch.whitelist.gameIds, {
            tagIds: config.twitch.whitelist.tagIds,
            keywords: config.twitch.whitelist.keywords
        });
    }).then((streams) => {
        if (!streams.length) {
            log.debug('no active streams found with your search configuration');
            return;
        }

        log.debug(`${streams.length} active stream(s) found with your search configuration, validating for actions....`);
        return validateStreams(streams).then(
            () => {
                // Do nothing on success.
            },
            (error) => {
                log.error(`Error updating a stream:\n${error}`);
                process.exit(-1);
            }
        );
    }).catch({ code: 'ECONNREFUSED' }, (err) => {
        // being rate limited by twitch... let's let it calm down a bit extra...
        log.warn('Twitch refused API request (likly due to rate limit) - waiting an additional 30 seconds');
        return Promise.delay(30000);
    }).finally(() => {
        // debug('polling cycle done, waiting 30s ...')
        return Promise.delay(30000).then(() => checkStreams());
    });
}

function fetchAllFromSRCURL(pageUrl, earliest_submission_timestamp = 0, data = []) {
    return fetch(pageUrl).then((response) => {
        return response.json();
    }).then((jsonData) => {
        let filtered = jsonData["data"].filter(elem => {
            return new Date(elem["submitted"]).getTime() / 1000 >= earliest_submission_timestamp
        });

        // No more runs found that are early enough.
        if (filtered.length === 0) {
            return data;
        }

        const newData = [...data, ...filtered];

        if (!("pagination" in jsonData)) {
            return newData;
        }

        let url = null;
        jsonData["pagination"]["links"].forEach((elem) => {
            if (elem["rel"] === "next") {
                url = elem["uri"];
            }
        });

        if (url != null) {
            return fetchAllFromSRCURL(url, earliest_submission_timestamp, newData);
        } else {
            return newData;
        }
    })
}

async function checkSRC() {
    const INTERVAL = 60 * 60 * 1000; // Each hour.
    const URL = "https://www.speedrun.com/api/v1/runs?game=9d35xw1l&orderby=date&direction=desc&embed=category,players";
    const TARGET_CHANNEL = "🏢speedrun-administration";
    const GAME_ID = "9d35xw1l";

    db("src").select().orderBy("internal_id", "desc").first().then((row) => {
        if (row == null) {
            db("src").insert({latest: Math.trunc(Date.now() / 1000)}).then();
            return 0;
        } else {
            db("src").update({latest: Math.trunc(Date.now() / 1000)}).then();
            return row["latest"];
        }
    }).then((limit) => {
            // Load runs from SRC
            return fetchAllFromSRCURL(URL, limit);
    }).then((runs) => {
        twitchClient.ensureToken().then(() => {
            let logMsg = `Scanning ${runs.length} run${runs.length !== 1 ? "s" : ""} for invalid video proof.`;
            runs.length > 0 ? log.info(logMsg) : log.debug(logMsg);

            function sendMessageWithRunInformation(run, prefix) {
                let message = prefix;

                let players = [];
                run["players"]["data"].forEach((player) => {
                    if (player["rel"] === "guest") {
                        players.push(player["name"]);
                    } else {
                        players.push(player["names"]["international"]);
                    }
                });

                message += `${run["category"]["data"]["name"]} run`;
                message += ` in ${run["times"]["primary"].substring(2)}`;
                message += ` by ${players.join(", ")}.\n`;
                message += `Submission from ${run["submitted"]}\n`;
                message += `Link: <${run["weblink"]}>\n`;
                Discord.sendMessage(message, TARGET_CHANNEL);
            }

            runs.forEach((run) => {
                // Check if it has a twitch video.
                if (!("videos" in run && "links" in run["videos"])) {
                    return;
                }

                run["videos"]["links"].forEach((link) => {
                    let match = link["uri"].match(/^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/videos\/(\d+)/);
                    if (match != null && match.length === 2) {
                        // Check if it is archived.
                        twitchClient.apiRequest({
                            endpoint: `/videos`,
                            payload: {
                                id: match[1]
                            }
                        }).then((data) => {
                            if (data === 404) {
                                // The video is offline.
                                let prefix = "Found offline video proof (Twitch returned 404).\n";
                                sendMessageWithRunInformation(run, prefix);
                                return;
                            }

                            if (data == null || !("data" in data)) {
                                log.error("Got invalid answer for " + match[1]);
                                return;
                            }

                            data = data["data"];

                            if (data.length !== 1) {
                                log.error("Twitch API didn't return a single result for a video ID.");
                                log.error(data);
                                return;
                            }

                            if (data[0]["type"] === "archive") {
                                let prefix = "Found run that has an auto-archived twitch VOD as proof.\n";
                                sendMessageWithRunInformation(run, prefix);
                            }
                        });
                    }

                    // Check if the run is from a new speedrunner (first game submission)
                    run["players"]["data"].forEach((player) => {
                        let playerName = player["rel"] === "guest" ? player["name"] : player["names"]["international"];

                        player["links"].forEach((link) => {
                            if (link["rel"] !== "runs") {
                                return;
                            }

                            fetch(link["uri"]).then((response) => {
                                return response.json();
                            }).then((data) => {
                                let runCount = 0;

                                data["data"].forEach(run => {
                                    if (run["game"] === GAME_ID) {
                                        runCount++;
                                    }
                                });

                                if (runCount === 1) {
                                    let message = `${playerName} submitted their first run.\n`;

                                    if (player["rel"] === "guest") {
                                        message += "User is a guest runner and therefore has no speedrun.com profile.\n";
                                        message += "Good luck finding them :upside_down:\n";
                                    } else {
                                        message += `Run link: <${run["weblink"]}>\n`
                                        message += `User link: <${player["weblink"]}>\n`;
                                    }
                                    Discord.sendMessage(message, TARGET_CHANNEL);
                                }
                            });
                        });
                    });
                })
            });

        });
    }).finally(() => {
        return Promise.delay(INTERVAL).then(() => checkSRC());
    });
}

app.listen(5001, () => {
    // Start polling cycle when server came up
    checkStreams();
    checkSRC();
});
