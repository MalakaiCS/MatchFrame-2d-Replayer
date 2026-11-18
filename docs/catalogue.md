# Public / competition catalogue

The catalogue lists replays from approved sources. Each entry records its provider, licence, provenance URL and entitlement:

- **public**: any signed-in user can open it.
- **entitled**: only users or teams listed in `catalogue_entitlements` for that provider can open it. Other users see the entry as locked, with no replay ID.

## Current coverage

**None.** At handoff, Matchframe has no licensed, project-owned or approved provider feed. The Skybox EDGE catalogue is a separate product and is not a source for Matchframe content. Catalogue access in the reference and Matchframe content availability are separate dependencies.

## Adding a source

1. Record the agreement or licence for the feed (who may view, attribution, retention).
2. Import each demo as a normal replay owned by a service account, with `visibility = 'catalogue'`.
3. Insert a `catalogue_entries` row:

```sql
insert into catalogue_entries (id, provider, provider_ref, event_name, match_name, series_id, map_index, map_id,
                               licence, provenance_url, entitlement, replay_id, played_at)
values ('cat_<id>', '<provider>', '<their match id>', '<event>', '<Team X vs Team Y>', '<series>', 1, 'de_mirage',
        '<licence summary>', '<url>', 'public', '<replay id>', '<timestamp>');
```

4. For entitled feeds, grant access:

```sql
insert into catalogue_entitlements (provider, team_id) values ('<provider>', '<team id>');
```

## Open questions (parity matrix LIB-03)

- Which competitions and date ranges does the reference catalogue cover?
- How does the reference distinguish entitled from inaccessible demos?
- What does the catalogue-to-viewer flow look like, including map selection for a series?
