const debug = require('debug')('speedbot:discord');
const Promise = require('bluebird');
const discordConfig = require('./config.json').discord;

const Discord = require('discord.js');
const client = new Discord.Client();

client.on('ready', () => {
    debug(`Logged in as ${client.user.tag}`);
});

client.login(discordConfig.credentials.botToken);

let failedLogins = 0;

function reattemptLogin(err) {
    failedLogins += 1;

    if (failedLogins > 50) {
        debug('Too many failed logins or disconnections, shutting down', err);
        throw err;
    }

    client.once('error', (err) => {
        debug('Unexpected discord sourced error:', err);
        client.login(discordConfig.credentials.botToken);
        client.once('error', reattemptLogin);
    });
}

client.once('error', reattemptLogin);

/**
 * @param {Discord.Collection<string, Discord.Channel>} channels
 * @returns {Array<Discord.TextChannel>}
 */
function getAllTextChannels(channels) {
    return Array.from(channels.values()).filter(
        /** @returns {channel is Discord.TextChannel} */
        channel => channel.type === 'text'
    ).filter(channel => channel.name === 'general');
}

function escapeMarkdown(string) {
    return string.replace(/[*_~]/gi, "\\$&");
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
    let title = escapeMarkdown(data.title);
    let display_name = escapeMarkdown(data.user_name)

    let welcomeMessage;
    if (data.user_id === '72692222') {
        welcomeMessage = '@here We are Live!';
    } else {
        welcomeMessage = `${display_name} is live!`;
    }

    let url = `https://www.twitch.tv/${username}`;
    if (data.user_id !== '72692222') {
        url = `<${url}>`;
    }

    let payload = `> ${welcomeMessage} - "${title}"\n> ${url}`;

    // allows for filtering to a specific configured discord guild, that can be used to "test" when NODE_ENV=test
    if (process.env.NODE_ENV === 'test') {
        const [testChannel] = getAllTextChannels(client.channels).filter(channel => channel.guild.name === discordConfig.testGuildName);
        return testChannel.send(payload);
    }

    return Promise.map(getAllTextChannels(client.channels), (channel) => {
        debug(payload);
        return channel.send(payload);
    });
}

module.exports = { newStreamAlert };
