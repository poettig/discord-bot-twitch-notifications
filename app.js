import * as loglib from "./log.js"
import * as twitchClient from "./twitch.js"
import config from "./config.json" assert {type: "json"}
import * as Stream from "./Stream.js"
import * as Discord from "./discordbot.js"
import db from "./connection.js"
import fetch from "node-fetch"
import {getRandomInt} from "./util.js";
import {escapeMarkdown} from "discord.js";

const log = loglib.createLogger("app", process.env.LEVEL_APP);

function validateStreams(streams) {
	return Promise.all(streams.map(async (twitchStream) => {
		const dbRow = await Stream.getOne(twitchStream.user_id);

		if (dbRow && !dbRow.isLive) {
			return Stream.streamGoneLive(twitchStream, dbRow).then((shoutOutGiven) => {
				Stream.updateStreamInDB(
					twitchStream.user_id,
					twitchStream.user_name,
					true,
					shoutOutGiven ? new Date() : dbRow.lastShoutOut,
					null
				);
			});
		} else if (!dbRow) {
			return Stream.announceNewStream(twitchStream).then((shoutOutGiven) => {
				Stream.createNewStreamInDB(twitchStream, shoutOutGiven ? new Date() : null);
			});
		}
	}));
}

function checkStreams() {
	function endStream(result) {
		log.info(`The stream of ${result.user_name} (${result.user_id}) ended, setting to offline.`);
		Stream.setEnded(result.user_id).then();
	}

	log.debug("Checking streams...");
	return twitchClient.getStreamsByMetadata(config.twitch.allowlist.gameIds, {
		tagIds: config.twitch.allowlist.tagIds,
		keywords: config.twitch.allowlist.keywords
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

		log.info(`${streams.length} active stream(s) found with your search configuration, checking for actions....`);
		log.debug(`Names of active streamers: ${streams.map((entry) => entry.user_name).join(', ')}`)
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
	Discord.sendMessage(message, false, "src-admin-run-administration");
}

function sendMessageWithRunInformation(run, prefix) {
	let message = prefix;

	let runners = [];
	run["players"]["data"].forEach((runner) => {
		runners.push(escapeMarkdown(getRunnerName(runner)));
	});

	message += `${escapeMarkdown(run["category"]["data"]["name"])} run`;
	message += ` in ${escapeMarkdown(run["times"]["primary"].substring(2))}`;
	message += ` by ${runners.join(", ")}.\n`;
	message += `Submission from ${run["submitted"]}\n`;
	message += `Link: <${run["weblink"]}>\n`;
	sendSpeedrunAdministrationMessage(message);
}

function fetchSRCUrl(pageUrl) {
	return new Promise((resolve, reject) => {
		log.debug(`Fetching ${pageUrl}...`)
		fetch(pageUrl).then((response) => {
			return response.json();
		}).then(
			(jsonData) => {
				if (!jsonData) {
					reject("Failed to fetch SRC json data");
				}

				// Maximum number of requests per minute reached, retry after a bit.
				if ([420, 429].includes(jsonData.status)) {
					setTimeout(() => fetchSRCUrl(pageUrl).then(resolve, reject), 10000);
				}

				resolve(jsonData);
			},
			(err) => {
				reject(`Failed to fetch ${pageUrl}: ${err}`);
			}
		);
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
		if (data == null || !("data" in data)) {
			throw new Error(`Got invalid answer for video with id ${videoId}`);
		}

		let data_inner = data["data"];

		if (data_inner.length === 0) {
			// The video is offline.
			let prefix = "Found offline video proof (Twitch returned 404).\n";
			sendMessageWithRunInformation(run, prefix);
			return Promise.resolve();
		}

		if (data_inner.length > 1) {
			throw new Error("Twitch API returned more than one result for a video ID.");
		}

		if (data_inner[0]["type"] === "archive") {
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
			log.debug(`[${run["game"]}] Runner ${runnerName} (${runner['id']}) is a guest, can't progress.`)
			continue;
		}

		if (await checkIfKnownRunner(runner)) {
			log.debug(`[${run["game"]}] ${runnerName} (${runner["id"]}) is already known, skipping...`);
			continue;
		}

		for (let link of runner["links"]) {
			if (link["rel"] !== "runs") {
				continue;
			}

			let promise = fetchEntriesFromSRC(link["uri"]).then((response) => {
				let runCount = 0;

				response.forEach(runOfRunner => {
					// Runners can run multiple games which are all returned when requesting the "runs" URL of a runner object
					if (runOfRunner["game"] === run["game"]) {
						runCount++;
					}
				});

				return db("runners").insert({
					runner_id: runner["id"],
					runner_name: runnerName
				}).then(async () => {
					const escapedRunnerName = escapeMarkdown(runnerName)
					const gameName = (await fetchSRCUrl(`https://www.speedrun.com/api/v1/games/${run["game"]}`))["data"]["names"]["international"];

					log.info(`[${run["game"]}] Unknown runner ${escapedRunnerName} (${runner["id"]}) submitted a run, announcing...`);
					let message = `Previously unknown runner **${escapedRunnerName}** submitted a run for **${gameName}**.\n`;
					if (runCount === 1) {
						message += "This is their first submission for this game.\n"
					} else {
						message += `They submitted ${runCount} runs for this game already.\n`
					}

					if (runner["rel"] === "guest") {
						message += "User is a guest runner and therefore has no speedrun.com profile.\n";
						message += "Good luck finding them :upside_down:\n";
					} else {
						message += `Run link: <${run["weblink"]}>\n`
						message += `User link: <${runner["weblink"]}>\n`;
					}

					return sendSpeedrunAdministrationMessage(message);
				}, (error) => {
					// Ignore unique contraint fails, that just means that the entry was created while fetching the runs
					if (error.errno === 19 && error.message.includes("UNIQUE constraint failed")) {
						return;
					}

					throw error;
				});
			});

			promises.push(promise);
		}
	}

	return Promise.all(promises);
}

async function processSpeedrun(run) {
	const runSubmitDateString = new Date(run["submitted"]).toLocaleString();

	let videoProofPromise = checkVideoProof(run);
	let newRunnerPromise = checkForNewRunners(run);

	return Promise.all([videoProofPromise, newRunnerPromise]).then(
		async () => {
			// Mark the run as processed.
			return await db("src").update({
				latest: new Date(run["submitted"]).getTime() / 1000
			}).then(
				() => {
					log.info(`[${run["game"]}] Processed run ${run["id"]} (${runSubmitDateString}).`);
					return true;
				},
				(error) => {
					log.info(`[${run["game"]}] Processed run ${run["id"]} (${runSubmitDateString}), but failed to update latest processed run marker: ${error}.`);
					return false;
				}
			);
		},
		(error) => {
			log.error(`[${run["game"]}] Failed to process run ${run["id"]} (${runSubmitDateString}): ${error}.`);
			return false;
		}
	);
}

async function fetchPageFromSRC(chunkUrl, stopCondition) {
	let jsonData = await fetchSRCUrl(chunkUrl);

	const entries = []
	const page = {
		entries,
		nextPage: null
	};

	// Ratelimited
	if (jsonData.status === 420) {
		// Got ratelimited, retry later
		const waitTime = getRandomInt(5, 10);
		log.warn(`Ratelimited by speedrun.com, waiting ${waitTime}s before retrying.`)
		await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
		return await fetchPageFromSRC(chunkUrl, stopCondition);
	}

	if (jsonData["data"] == null) {
		throw Error(`Got page without data: ${jsonData}`);
	}

	for (let run of jsonData["data"]) {
		if (typeof stopCondition === "function" && stopCondition(run)) {
			return page;
		}

		entries.push(run);
	}

	if (!("pagination" in jsonData)) {
		return page;
	}

	for (let link of jsonData["pagination"]["links"]) {
		if (link["rel"] === "next") {
			page.nextPage = link["uri"];
		}
	}

	return page;
}

async function fetchEntriesFromSRC(url, stopCondition) {
	let nextPage = url;
	const entries = [];

	while (nextPage) {
		await fetchPageFromSRC(nextPage, stopCondition).then((page) => {
			nextPage = page.nextPage;
			entries.push(...page.entries);
		});
	}

	return entries;
}

async function processSpeedruns(runs) {
	let successfullyProcessed = 0;
	let failedToProcess = 0;

	for (let [idx, run] of runs.entries()) {
		log.debug(`[${run["game"]}] Processing run ${idx + 1}/${runs.length}...`);
		if (await processSpeedrun(run)) {
			successfullyProcessed += 1;
		} else {
			failedToProcess += 1;
		}
	}

	let allRuns = successfullyProcessed + failedToProcess;
	log.info(`[${runs.length > 0 ? runs[0]["game"] : "how are there no runs?"}] Processed ${allRuns} new speedrun${allRuns === 1 ? "" : "s"}, ${successfullyProcessed} succeeded, ${failedToProcess} failed.`);
}

function checkSpeedruns(srcGameId) {
	log.debug(`[${srcGameId}] Checking runs on SRC...`);

	let dbPromise = db("src")
		.select()
		.where("game_id", srcGameId)
		.orderBy("internal_id", "desc")
		.first()
		.then(async (row) => {
			if (row == null) {
				await db("src").insert({"latest": 0, "game_id": srcGameId});
				return 0;
			}

			return row["latest"];
		});

	return dbPromise.then((lastProcessedRunTimestamp) => {
		log.info(`[${srcGameId}] Fetching all unprocessed runs...`);
		return fetchEntriesFromSRC(
			`https://www.speedrun.com/api/v1/runs?game=${srcGameId}&orderby=submitted&direction=desc&embed=category,players`,
			(run) => new Date(run["submitted"]).getTime() / 1000 <= lastProcessedRunTimestamp
		).then((runs) => {
			if (runs.length === 0) {
				return;
			}

			// Runs are fetched from newest to oldest, need to reverse the list
			log.info(`[${srcGameId}] Processing ${runs.length} unprocessed runs...`);
			return processSpeedruns(runs.toReversed());
		});
	});
}

function startMonitor(functionToMonitor, interval) {
	let running = false;

	let monitor = () => {
		if (running) {
			log.warn(`Monitor ${functionToMonitor.name} is already running, skipping...`);
			return;
		}

		running = true;
		functionToMonitor()
			.then(() => {
				running = false;
			})
			.catch((error) => {
				log.error(`Rejection caught in monitor ${functionToMonitor.name}, closing program with failure state...`)
				log.error(error);
				process.exit(1);
			});
	}

	log.info(`Starting monitor ${functionToMonitor.name} with interval ${interval}.`)
	setInterval(monitor, interval);
	monitor();
}

let checkLoginHandler = setInterval(() => {
	if (Discord.isLoggedIn()) {
		clearInterval(checkLoginHandler);

		// Check streams every 30 seconds
		startMonitor(checkStreams, 30000);

		// Check speedruns every 15 minutes
		config.speedrundotcom.gameIds.forEach((gameId) => {
			startMonitor(() => {
				return checkSpeedruns(gameId)
			}, 900000);
		});

	}
}, 100);
