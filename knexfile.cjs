'use strict';

const config = require("./config.json")
module.exports = {
  development: {
    client: 'sqlite3',
    connection: {
      filename: config.store.connection
    },
    useNullAsDefault: true,
  },
};
