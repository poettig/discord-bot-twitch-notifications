/**
 * by using a single connection entry point, we can rely on cjs require cache
 * to get only the single connection pool in any other file / module that needs it,
 * just by requiring this connection module
 */
import knex from "knex"
import loadConfig from "./config.cjs"

const config = loadConfig();
export default knex(config.store);