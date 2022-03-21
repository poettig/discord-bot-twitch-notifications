exports.up = function (knex, Promise) {
	const runnersSchema = (table) => {
		table.text('runner_id').unique().notNullable().primary();
		table.text('runner_name').notNullable();
	};

	return knex.schema.createTable('runners', runnersSchema);
};

exports.down = function (knex, Promise) {
	return knex.schema.dropTable('runners');
};
