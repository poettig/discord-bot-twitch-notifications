'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = function loadConfig() {
  const configPath = process.env.CONFIG_PATH
    ? path.resolve(process.cwd(), process.env.CONFIG_PATH)
    : path.join(__dirname, 'config.json');

  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
};
