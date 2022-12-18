exports.up = function(knex) {
	return knex.schema.table("streams", (table) => {
		table.dropColumns("stream_id", "community_ids", "viewer_count", "type", "language", "thumbnail_url", "tag_ids", "game_id", "title", "started_at");
	});
};

exports.down = function(knex) {
	return knex.schema.table("streams", (table) => {
		table.integer('stream_id').unique();
		table.json('community_ids');
		table.integer('viewer_count');
		table.text('type');
		table.text('language');
		table.text('thumbnail_url');
		table.json('tag_ids');
		table.text('game_id');
		table.text('title');
		table.dateTime('started_at');
	})
};
