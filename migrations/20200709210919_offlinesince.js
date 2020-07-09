
exports.up = function(knex, Promise) {
  return knex.schema.table("streams", (table) => {
	table.dateTime('offline_since');
  });
};

exports.down = function(knex, Promise) {
  return knex.schema.table("streams", (table) => {
  	table.dropColumn("offline_since");
  });
};
