exports.up = function (knex, Promise) {
    const srcSchema = (table) => {
        table.increments('internal_id').primary();
        table.integer('latest').unique().notNullable();
    };

    return knex.schema.createTable('src', srcSchema);
};

exports.down = function (knex, Promise) {
    return knex.schema.dropTable('src');
};
