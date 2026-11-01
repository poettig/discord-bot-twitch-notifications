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

First, copy `config.example.json` to `config.json` and fill in the required properties (or alter the existing ones). The default configuration file is `config.json` in the project directory.

To use a different configuration file, set `CONFIG_PATH`. Absolute paths are accepted; relative paths are resolved from the process working directory. The same setting is used by the application and database migrations:

```sh
CONFIG_PATH=/path/to/my-config.json npm run migrate-latest
CONFIG_PATH=/path/to/my-config.json node app.js
```

Then initialize the database (if using the default configuration):

```sh
npm run migrate-latest
```

The Docker image's working directory is `/src`, so relative `CONFIG_PATH` values inside the container resolve from there. For a host configuration file, mount it and use its absolute container path:

```sh
docker run --rm \
  -e CONFIG_PATH=/run/config/config.json \
  -v "$PWD/config.json:/run/config/config.json:ro" \
  your-image
```

The container command runs migrations and then starts the bot, and both use this configuration.

### Running
To run in debug mode:

```
npm run debug
```

### Adding the bot to Discord
https://discord.com/api/oauth2/authorize?client_id=690964462269628418&permissions=3072&scope=bot

## Attributions
Thanks to [jkantr](https://github.com/jkantr) for the [first implementations and support](https://github.com/jkantr/discord-bot-twitch-notifications)! This started as a fork as they had no time to maintain it anymore but has since became incompatible with upstream caused by making the implementation more specific to Factorio speedrunning and migration to ES modules.
