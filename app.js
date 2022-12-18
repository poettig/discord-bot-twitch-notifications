import * as loglib from "./log.js"
import BluebirdPromise from "bluebird";
import * as twitchClient from "./twitch.js"
import {ensureToken} from "./twitch.js"
import config from "./config.json" assert {type: "json"}
import * as Stream from "./Stream.js"
import * as Discord from "./discordbot.js"
import db from "./connection.js"
import fetch from "node-fetch"

const log = loglib.createLogger("app", process.env.LEVEL_APP);
const factorioGameID = "9d35xw1l";

function validateStreams(streams) {
	return BluebirdPromise.map(streams, async (twitchStream) => {
		const dbRow = await Stream.getOne(twitchStream.user_id);

		let updateRow = (shoutOutGiven) => {
			Stream.updateStreamInDB(
				twitchStream.user_id,
				twitchStream.user_name,
				true,
				shoutOutGiven ? new Date() : dbRow.lastShoutOut,
				null
			);
		}

		if (dbRow && !dbRow.isLive) {
			return Stream.streamGoneLive(twitchStream, dbRow).then(updateRow);
		} else if (!dbRow) {
			return Stream.announceNewStream(twitchStream).then((shoutOutGiven) => {
				Stream.createNewStreamInDB(twitchStream);
				updateRow(shoutOutGiven);
			});
		}
	});
}

function checkStreams() {
	function endStream(result) {
		log.info(`The stream of ${result.user_name} (${result.user_id}) ended, setting to offline.`);
		Stream.setEnded(result.user_id).then();
	}

	log.debug("Checking streams...");
	return ensureToken().then(() => {
		log.debug('Getting twitch streams by metadata...')
		return twitchClient.getStreamsByMetadata(config.twitch.allowlist.gameIds, {
			tagIds: config.twitch.allowlist.tagIds,
			keywords: config.twitch.allowlist.keywords
		});
	}).then((streams) => {
		if (!streams.length) {
			log.debug('no active streams found with your search configuration');

			// Set all still-marked-live streams as not live.
			Stream.getAllLiveStreams().then(results => {
				results.forEach(result => {
					endStream(result);
				});
			});

			return Promise.resolve();
		}

		log.debug(`${streams.length} active stream(s) found with your search configuration, validating for actions....`);
		return validateStreams(streams).then(() => {
			// Convert search results into array of user ids
			let ids = streams.map(value => parseInt(value.user_id));

			// Set all streams to offline that where not in the search results.
			Stream.getAllLiveStreams().then((results) => {
				results.forEach((result) => {
					if (!ids.includes(result.user_id)) {
						endStream(result);
					}
				});
			})
		});
	});
}

function sendSpeedrunAdministrationMessage(message) {
	Discord.sendMessage(message, false, "🏢speedrun-administration");
}

function sendMessageWithRunInformation(run, prefix) {
	let message = prefix;

	let runners = [];
	run["players"]["data"].forEach((runner) => {
		runners.push(getRunnerName(runner));
	});

	message += `${run["category"]["data"]["name"]} run`;
	message += ` in ${run["times"]["primary"].substring(2)}`;
	message += ` by ${runners.join(", ")}.\n`;
	message += `Submission from ${run["submitted"]}\n`;
	message += `Link: <${run["weblink"]}>\n`;
	sendSpeedrunAdministrationMessage(message);
}

function fetchSRCUrl(pageUrl) {
	log.debug(`Fetching ${pageUrl}...`)
	return fetch(pageUrl).then((response) => {
		return response.json();
	}).then((jsonData) => {
		if (!jsonData) {
			throw "Failed to fetch SRC json data";
		}

		// Maximum number of requests per minute reached, retry after a bit.
		if (jsonData.status === 420) {
			return BluebirdPromise.delay(10000).then(() => {
				fetchSRCUrl(pageUrl)
			});
		}

		return jsonData;
	}).catch((err) => {
		throw `Failed to fetch ${pageUrl}: ${err}`;
	});
}

function checkTwitchVideoProof(run, videoId) {
	// Check if it is archived.
	return twitchClient.apiRequest({
		endpoint: `/videos`,
		payload: {
			id: videoId
		}
	}).then((data) => {
		if (data === 404) {
			// The video is offline.
			let prefix = "Found offline video proof (Twitch returned 404).\n";
			sendMessageWithRunInformation(run, prefix);
			return Promise.resolve();
		}

		if (data == null || !("data" in data)) {
			throw `Got invalid answer for video with id ${videoId}`;
		}

		data = data["data"];

		if (data.length !== 1) {
			throw "Twitch API didn't return a single result for a video ID.";
		}

		if (data[0]["type"] === "archive") {
			let prefix = "Found run that has an auto-archived twitch VOD as proof.\n";
			sendMessageWithRunInformation(run, prefix);
			return Promise.resolve();
		}
	});
}

function checkVideoProof(run) {
	// Check if it has a video link. If not, send "no video proof" message.
	if (!("videos" in run && "links" in run["videos"])) {
		sendMessageWithRunInformation(run, "Run is missing video proof.")
		return Promise.resolve();
	}

	for (let link of run["videos"]["links"]) {
		let match = link["uri"].match(/^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/videos\/(\d+)/);
		if (match != null && match.length === 2) {
			return checkTwitchVideoProof(run, match[1]);
		}
	}

	return Promise.resolve();
}

async function checkIfKnownRunner(runner) {
	if (runner["rel"] === "guest") {
		return false;
	}

	return await db("runners").where("runner_id", runner["id"]).then(rows => {
		return rows.length !== 0;
	});
}

function getRunnerName(runner) {
	return runner["rel"] === "guest" ? runner["name"] : runner["names"]["international"];
}

async function checkForNewRunners(run) {
	let promises = [];

	for (let runner of run["players"]["data"]) {
		let runnerName = getRunnerName(runner);

		if (runner["rel"] === "guest") {
			// Do not process guest runners as there is no way to contact them and they cannot submit runs themselves.
			// Therefore, there is no need to check if they got their first ever submission right - someone with an account has to submit it.
			log.debug(`Runner ${runnerName} (${runner['id']}) is a guest, can't progress.`)
			continue;
		}

		if (await checkIfKnownRunner(runner)) {
			log.debug(`${runnerName} (${runner["id"]}) is already known, skipping...`);
			continue;
		}

		for (let link of runner["links"]) {
			if (link["rel"] !== "runs") {
				continue;
			}

			let promise = fetchAllFromSrcUrl(link["uri"]).then((response) => {
				let runCount = 0;

				response.forEach(run => {
					if (run["game"] === factorioGameID) {
						runCount++;
					}
				});

				log.debug(`Unknown runner ${runnerName} (${runner["id"]}) submitted a run, announcing...`);
				let message = `Previously unknown runner ${runnerName} submitted a run.\n`;
				if (runCount === 1) {
					message += "This is their first submission.\n"
				} else {
					message += `They submitted ${runCount} runs already.\n`
				}

				if (runner["rel"] === "guest") {
					message += "User is a guest runner and therefore has no speedrun.com profile.\n";
					message += "Good luck finding them :upside_down:\n";
				} else {
					message += `Run link: <${run["weblink"]}>\n`
					message += `User link: <${runner["weblink"]}>\n`;
				}

				sendSpeedrunAdministrationMessage(message);

				return db("runners").insert({runner_id: runner["id"], runner_name: runnerName});
			});

			promises.push(promise);
		}
	}

	return BluebirdPromise.all(promises);
}

function processSpeedrun(run) {
	let videoProofPromise = checkVideoProof(run);
	let newRunnerPromise = checkForNewRunners(run);
	return BluebirdPromise.all([videoProofPromise, newRunnerPromise]).then(() => {
		// Mark the run as processed.
		return db("src").update({latest: new Date(run["submitted"]).getTime() / 1000}).then();
	});
}

async function processSpeedruns(runs) {
	if (runs.length === 0) {
		log.debug("No new speedruns to process.");
		return;
	}

	log.info(`Processing ${runs.length} new speedrun${runs.length === 1 ? "" : "s"}.`);

	// Process all runs in the fetched chunk.
	for (let run of runs.reverse()) {
		await processSpeedrun(run);
		log.info(`Processed run ${run["id"]} from ${new Date(run["submitted"])}.`);
	}
}

function fetchAllFromSrcUrl(url, filterFunction) {
	let runs = [];

	function fetchChunk(chunkUrl) {
		return fetchSRCUrl(chunkUrl).then((jsonData) => {
			for (let run of jsonData["data"]) {
				if (typeof filterFunction === "function" && filterFunction(run)) {
					// We reached an already processed run, stop fetching more runs.
					return runs;
				}

				runs.push(run);
			}

			if (!("pagination" in jsonData)) {
				// We are done, no more runs left. Resolve promise.
				return runs;
			}

			for (let link of jsonData["pagination"]["links"]) {
				if (link["rel"] === "next") {
					return fetchChunk(link["uri"]);
				}
			}

			// We are done, no more runs left. Resolve promise.
			return runs;
		});
	}

	return fetchChunk(url);
}

function fetchAllUnprocessedSpeedruns(lastProcessedRunTimestamp) {
	const URL = `https://www.speedrun.com/api/v1/runs?game=${factorioGameID}&orderby=date&direction=desc&embed=category,players`;
	return fetchAllFromSrcUrl(URL, (run) => new Date(run["submitted"]).getTime() / 1000 <= lastProcessedRunTimestamp);
}

function checkSpeedruns() {
	log.debug("Checking runs on SRC...");

	let dbPromise = db("src")
		.select()
		.orderBy("internal_id", "desc")
		.first()
		.then((row) => {
			if (row == null) {
				db("src").insert({latest: 0}).then();
				return 0;
			}

			return row["latest"];
		});

	let tokenPromise = twitchClient.ensureToken();

	return BluebirdPromise.all([dbPromise, tokenPromise]).then((results) => {
		return fetchAllUnprocessedSpeedruns(results[0]);
	}).then(processSpeedruns);
}

function startMonitor(functionToMonitor, interval) {
	let handler = null;

	let monitor = () => {
		functionToMonitor().catch((error) => {
			log.error("Rejection caught in monitor function, closing program with failure state...")
			log.error(error);
			process.exit(1);
		})
	}

	log.info(`Starting monitor ${functionToMonitor.name} with interval ${interval}.`)
	handler = setInterval(monitor, interval);
	monitor();
}

let checkLoginHandler = setInterval(() => {
	if (Discord.isLoggedIn()) {
		clearInterval(checkLoginHandler);

		// Check streams every 30 seconds
		startMonitor(checkStreams, 30000);

		// Check speedruns every 15 minutes
		startMonitor(checkSpeedruns, 900000);
	}
}, 100);
