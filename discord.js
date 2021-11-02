const log = require('./log.js').createLogger("discord", process.env.LEVEL_DISCORD);
const Promise = require('bluebird');
const discordConfig = require('./config.json').discord;
const whitelist = require('./config.json').twitch.whitelist;

const Discord = require('discord.js');
const client = new Discord.Client();

let loggedIn = false;

client.on('ready', () => {
	log.info(`Logged in as ${client.user.tag}`);
	client.on("message", message => {
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

			guild.members.fetch()
				.then(() => {
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
							message.reply(`No roles found on server *${guild.name}*.`);
						} else {
							message.reply(`There is no role *${matchRole}* on server *${guild.name}*.`);
						}
					} else if (length > 1) {
						let result = "";
						for (const [roleName, memberCount] of Object.entries(info)) {
							let name = `${roleName}: `
							result += `${name.padEnd(longestName + 2, " ")}${memberCount.toString().padStart(longestCount, " ")}\n`;
						}

						message.reply(`Role member counts for server *${guild.name}:*\n\`\`\`${result}\`\`\``);
					} else {
						for (const [roleName, memberCount] of Object.entries(info)) {
							message.reply(`The role '${roleName}' has ${memberCount} member${memberCount !== 1 ? "s" : ""}.`);
						}
					}
				})
				.catch(log.error);
		} else if (message.content.startsWith("!roles")) {
			guild.roles.fetch()
				.then(() => {
					let roles = guild.roles.cache.map(role => role.name.replace(/^@/g, ""));
					message.reply("Roles on this server: ```" + roles.join(", ") + "```");
				}).catch(log.error);
		}

	});
});

client.login(discordConfig.credentials.botToken).then(() => {
	loggedIn = true;
});

function isLoggedIn() {
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
		client.login(discordConfig.credentials.botToken);
		client.once('error', reattemptLogin);
	});
}

client.once('error', reattemptLogin);

/**
 * @param {Discord.Collection<string, Discord.Channel>} channels
 * @param filterValue
 * @returns {Array<Discord.TextChannel>}
 */
function getAllTextChannels(channels, filterValue = "general") {
	return Array.from(channels.cache.values()).filter(
		channel => channel.type === 'text'
	).filter(channel => channel.name === filterValue);
}

function escapeMarkdown(string) {
	return string.replace(/[<>*_~]/gi, "\\$&");
}

function sendMessage(payload, filterValue = "general") {
	if (!loggedIn) {
		log.error("Cannot send message, not logged in to discord!");
		return false;
	}

	// allows for filtering to a specific configured discord guild, that can be used to "test" when NODE_ENV=test
	if (process.env.NODE_ENV === 'test') {
		const [testChannel] = getAllTextChannels(client.channels, filterValue).filter(channel => channel.guild.name === discordConfig.testGuildName);
		return testChannel.send(payload);
	} else {
		return Promise.map(getAllTextChannels(client.channels, filterValue), (channel) => {
			log.debug(payload.replace(/\n/g, "\\n"));
			return channel.send(payload);
		});
	}

}

function newStreamAlert(data) {
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

	let welcomeMessage;
	if (data.user_id === '72692222') {
		welcomeMessage = '@here We are Live!';
	} else {
		welcomeMessage = `${display_name} is live!`;
	}

	let url = `https://www.twitch.tv/${username}`;
	if (!whitelist.userIds.includes(data.user_id)) {
		url = `<${url}>`;
	}

	let payload = `> ${welcomeMessage} - "${title}"\n> ${url}`;
	return sendMessage(payload);
}

module.exports = {
	newStreamAlert,
	sendMessage,
};
