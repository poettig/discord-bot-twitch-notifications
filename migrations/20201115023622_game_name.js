
exports.up = function(knex, Promise) {
  return knex.schema.table("streams", (table) => {
	table.string('game_name');
  });
};

exports.down = function(knex, Promise) {
  return knex.schema.table("streams", (table) => {
  	table.dropColumn("game_name");
  });
};
