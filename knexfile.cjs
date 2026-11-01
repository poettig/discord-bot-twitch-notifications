'use strict';

const config = require("./config.cjs")()
module.exports = {
  development: {
    client: 'better-sqlite3',
    connection: {
      filename: config.store.connection
    },
    useNullAsDefault: true,
  },
};
