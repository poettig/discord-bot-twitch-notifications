discord-bot-twitch-notifications
================================
A somewhat-almost use-agnostic starting point for getting a discord bot up and running that notifies you of streams going live based on an unnecessarily complex set of filterable attributes.

### Installation
Not currently packaged and/or published to npm. To install, please clone this repo locally and initialize:

```sh
git clone https://github.com/poettig/discord-bot-twitch-notifications
npm install
```

### Setup
For basic usage, you just need to initialize the local `sqlite` database.
This can be done by invoking `knex --esm --knexfile knexfile.cjs migrate:latest`.

Then, copy `config.example.json` to `config.json` and fill in the missing properties (or alter the existing ones).

### Running
To run with somewhat verbose but also readable output:
```
DEBUG=speedbot:* node app.js
```

### Adding the bot to Discord
https://discord.com/api/oauth2/authorize?client_id=690964462269628418&permissions=3072&scope=bot

## Attributions
Thanks to [jkantr](https://github.com/jkantr) for the [first implementations and support](https://github.com/jkantr/discord-bot-twitch-notifications)! This started as a fork as they had no time to maintain it anymore but has since became incompatible with upstream caused by making the implementation more specific to Factorio speedrunning and migration to ES modules.
