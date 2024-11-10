exports.up = function(knex) {
	function addGameIdAndFixUnique() {
		return knex.schema.alterTable("src", (table) => {
			table.text("game_id").unique().notNullable().defaultTo("9d35xw1l");
			table.dropUnique(["latest"]);
		});
	}

	function removeDefault() {
		return knex.schema.alterTable("src", (table) => {
			table.text("game_id").alter().notNullable();
		});
	}

	return addGameIdAndFixUnique().then(removeDefault);
};

exports.down = function(knex) {
	return knex.schema.alterTable("src", (table) => {
		table.dropColumn("game_id");
		table.unique(["latest"]);
	});
};
