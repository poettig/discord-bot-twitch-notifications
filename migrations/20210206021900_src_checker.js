'use strict';

/**
 * @typedef {import('knex')} Knex
 * @typedef {import('knex').TableBuilder} Table
 * @typedef {import('bluebird')} Promise
 */
exports.up = function (/** @type {Knex} */knex, /** @type {Promise} */Promise) {
    /**
     * 
     * @param {Table} table 
     */
    const srcSchema = (table) => {
        table.increments('internal_id').primary();
        table.integer('latest').unique().notNullable();
    };

    return knex.schema.createTable('src', srcSchema);
};

exports.down = function (knex, Promise) {

};
