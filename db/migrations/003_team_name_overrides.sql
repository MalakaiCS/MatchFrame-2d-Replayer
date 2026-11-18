-- User-edited team names. Parser names (team_a_name/team_b_name) stay as recorded so a
-- reprocess never discards an edit; viewers see coalesce(override, parsed).
alter table replays add column team_a_override text check (team_a_override is null or length(team_a_override) between 1 and 60);
alter table replays add column team_b_override text check (team_b_override is null or length(team_b_override) between 1 and 60);
