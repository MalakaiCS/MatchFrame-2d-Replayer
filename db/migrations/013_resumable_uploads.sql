-- Resumable (multipart) uploads: large files go up in parts and can be resumed after a drop.
alter table uploads add column multipart_id text;
alter table uploads add column part_size bigint;
