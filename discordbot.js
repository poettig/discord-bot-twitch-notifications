import * as loglib from "./log.js"
import config from "./config.json" assert {type: "json"}
import Discord from "discord.js"

const client = new Discord.Client({
	intents: [
		Discord.GatewayIntentBits.Guilds,
		Discord.GatewayIntentBits.GuildMessages,
		Discord.GatewayIntentBits.MessageContent,
		Discord.GatewayIntentBits.GuildMembers
	]
});
const log = loglib.createLogger("discord", process.env.LEVEL_DISCORD);

let loggedIn = false;

client.on('ready', () => {
	log.info(`Logged in as ${client.user.tag}`);
	loggedIn = true;
});

client.login(config.discord.credentials.botToken).then(() => {
	log.debug("Login request to Discord completed, waiting for ready event...")
});

export function isLoggedIn() {
	return loggedIn;
}

let failedLogins = 0;

function reattemptLogin(error) {
	failedLogins += 1;

	if (failedLogins > 50) {
		log.error('Too many failed logins or disconnections, shutting down', error);
		throw error;
	}

	client.once('error', (err) => {
		log.error('Unexpected discord sourced error:', err);
		client.once('error', reattemptLogin);
		client.login(config.discord.credentials.botToken).catch(log.error);
	});
}

client.once('error', reattemptLogin);

/**
 * @param {Discord.Collection<string, Discord.Channel>} channelManager
 * @param filterValue
 * @returns {Array<Discord.TextChannel>}
 */
function getAllTextChannels(channelManager, filterValue = "general") {
	let channels = Array.from(channelManager.cache.values());
	let textChannels = channels.filter(channel => channel.type === Discord.ChannelType.GuildText);
	return textChannels.filter(channel => channel.name === filterValue);
}

function escapeMarkdown(string) {
	return string.replace(/[<>*_~|`]/gi, "\\$&");
}

export function sendMessage(payload, allowMentions, filterValue = "general") {
	if (!loggedIn) {
		log.error("Cannot send message, not logged in to discord!");
		return false;
	}

	let messageOptions = { content: allowMentions ? payload : payload.replace(/@/g, "\\$&")	}
	if (!allowMentions) {
		messageOptions.allowedMentions = { parse: [] };
	}

	log.debug(payload.replace(/\n/g, "\\n"));

	// allows for filtering to a specific configured discord guild, that can be used to "test" when NODE_ENV=test
	if (process.env.NODE_ENV === 'test') {
		const [testChannel] = getAllTextChannels(client.channels, filterValue).filter(channel => channel.guild.name === config.discord.testGuildName);
		return testChannel.send(messageOptions);
	} else {
		return Promise.all(getAllTextChannels(client.channels, filterValue).map(channel => {
			return channel.send(messageOptions);
		}));
	}

}

export function newStreamAnnouncement(data) {
	// Parse username from thumbnail_url as "data.user_name" is the display name, not the login name necessary for a twitch URL
	let username;
	let match = data.thumbnail_url.match(/^.*live_user_(.*)-.*$/);
	if (match) {
		username = match[1];
	} else {
		username = data.user_name;
	}

	// Replace markdown formatters in title and display_name
	let title = escapeMarkdown(data.title).replace(/[\n\r]/g, "");
	let display_name = escapeMarkdown(data.user_name);
	let allowMentions = false;

	let welcomeMessage = '';
	if (data.user_id === '72692222') {
		welcomeMessage = '@here ';
		allowMentions = true;
	}

	welcomeMessage += `${display_name} is live!`;

	let url = `https://www.twitch.tv/${username}`;
	if (!config.twitch.allowlist.userIds.includes(data.user_id)) {
		url = `<${url}>`;
	}

	let payload = `> ${welcomeMessage} - "${title}"\n> ${url}`;
	return sendMessage(payload, allowMentions);
}