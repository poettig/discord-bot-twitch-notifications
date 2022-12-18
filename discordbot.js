import * as loglib from "./log.js"
import BluebirdPromise from "bluebird"
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
	client.on("messageCreate", message => {
		if (message.member == null) {
			return;
		}

		if (!message.member.roles.cache.some(role => ["moderator", "administrator"].includes(role.name.toLowerCase()))) {
			return;
		}

		if (!message.guild) {
			return;
		}
		let guild = message.guild;

		if (message.content.startsWith("!count")) {
			let matchRole = null;
			let args = message.content.split(" ");
			if (args.length > 1) {
				matchRole = args.slice(1).join(" ");
				if (matchRole === "everyone") {
					matchRole = "@" + matchRole;
				}
			}

			log.info(`${message.member.displayName} asked for member count of ${matchRole == null ? "all roles" : "role " + matchRole}.`);
			guild.members.fetch().then(() => {
				let info = {};
				let longestName = 0;
				let longestCount = 0;

				guild.roles.cache.forEach((role) => {
					if (matchRole != null && role.name !== matchRole) {
						return;
					}

					let name = role.name.replace(/^@/g, "");
					info[name] = role.members.size;
					longestName = Math.max(longestName, name.length);
					longestCount = Math.max(longestCount, Math.log(role.members.size) * Math.LOG10E + 1 | 0);
				});

				let length = Object.keys(info).length;
				if (length === 0) {
					if (matchRole == null) {
						message.reply(`No roles found on server *${guild.name}*.`).catch(log.error);
					} else {
						message.reply(`There is no role *${matchRole}* on server *${guild.name}*.`).catch(log.error);
					}
				} else if (length > 1) {
					let result = "";
					// Sort from most to least role members and iterate
					for (const [roleName, memberCount] of Object.entries(info).sort((a, b) => b[1] - a[1])) {
						let name = `${roleName} `
						result += `${name.padEnd(longestName + 2, " ")}${memberCount.toString().padStart(longestCount, " ")}\n`;
					}

					message.reply(`Role member counts for server *${guild.name}:*\n\`\`\`${result}\`\`\``).catch(log.error);
				} else {
					for (const [roleName, memberCount] of Object.entries(info)) {
						message.reply(`The role '${roleName}' has ${memberCount} member${memberCount !== 1 ? "s" : ""}.`).catch(log.error);
					}
				}
			}).catch(log.error);
		} else if (message.content.startsWith("!roles")) {
			log.info(`${message.member.displayName} asked for role count.`);
			guild.roles.fetch().then(() => {
				let roles = guild.roles.cache.map(role => role.name.replace(/^@/g, ""));
				message.reply("Roles on this server: ```" + roles.join(", ") + "```").catch(log.error);
			}).catch(log.error);
		}

	});
});

client.login(config.discord.credentials.botToken).then(() => {
	loggedIn = true;
});

export function logout() {
	client.destroy();
}

export function isLoggedIn() {
	return loggedIn;
}

let failedLogins = 0;

function reattemptLogin(err) {
	failedLogins += 1;

	if (failedLogins > 50) {
		log.error('Too many failed logins or disconnections, shutting down', err);
		throw err;
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
		return BluebirdPromise.map(getAllTextChannels(client.channels, filterValue), (channel) => {
			return channel.send(messageOptions);
		});
	}

}

export function newStreamAlert(data) {
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

	let welcomeMessage;
	if (data.user_id === '72692222') {
		welcomeMessage = '@here We are Live!';
		allowMentions = true;
	} else {
		welcomeMessage = `${display_name} is live!`;
	}

	let url = `https://www.twitch.tv/${username}`;
	if (!config.twitch.allowlist.userIds.includes(data.user_id)) {
		url = `<${url}>`;
	}

	let payload = `> ${welcomeMessage} - "${title}"\n> ${url}`;
	return sendMessage(payload, allowMentions);
}