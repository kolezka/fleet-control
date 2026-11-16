# Host state retention and scheduled backups (proposal)

Status: proposal, 2026-11-16. Nothing here is implemented or scheduled. It answers open decision 7 in [implementation-status.md](implementation-status.md) and needs the owner's choice before any code that deletes rows or runs on a timer.

## What the host keeps today

The host service keeps one SQLite file (`state.db`, WAL mode). Nothing is ever deleted.

| Table | Grows with | On `.4` (copy read 2026-11-16) |
| --- | --- | --- |
| `sessions` | registered sessions | 0 rows |
| `model_observations` | each new model turn seen per session | 1 row |
| `commands`, `command_events` | each instruction and its delivery steps | 9 and 29 rows |
| `runs`, `requests`, `request_events` | each phased run, approval or question | 1, 2 and 7 rows |

The whole file on `.4` is 14 pages of 4 KiB plus a 600 KiB WAL. Measured locally: 10,000 model observations take about 0.97 MB, so about 97 bytes a row. A command row can hold up to `MAX_TEXT` (4,000 characters) of instruction text, so commands dominate when they are long.

At the test fleet's pace this file stays small for years. With a real fleet, a guess of 20 agents and a few hundred observations and commands a day gives tens of MB a year. That is a guess, not a measurement.

## Why deleting is not free

- Commands and requests are the audit record of who asked an agent to do what, and who approved it. Deleting them loses that.
- `command_events` and `request_events` are read by paged event tools (`afterSeq`). A client that remembered a sequence number must not silently miss events because older ones were removed. Deleting from the front is fine for that; deleting from the middle is not.
- Idempotency keys live on the command row. Deleting a command lets a late retry with the same key create a new command. That is a duplicate delivery to an agent.
- Model observations are only used for the latest model label. Older rows are history nobody reads.

## Proposal

1. **Model observations:** keep the newest 100 per session and delete older ones at service start. No audit value, and the page only reads the latest row. Low risk.
2. **Commands, requests and their events:** keep everything for now. Revisit when the file passes a size the owner picks (for example 100 MB). If deletion is wanted later, only remove items in a final state (commands `delivered`, `rejected`, `completed` or `failed`, never `queued`, `delivering` or `delivery_unknown`; requests `acknowledged`, `stale` or `withdrawn`) older than a chosen age, and keep their idempotency keys in a small table so a late retry is still answered with the original command, and keep an archive file written by `scripts/host-backup.ts` first.
3. **Scheduled backups:** a daily `scripts/host-backup.ts` run from a second LaunchAgent on `.4`, writing to a dated file. Copy that file to a second machine and check it there with `scripts/host-restore-check.ts` against its sha256. One copy on one machine is not a backup. Keep the newest 14.
4. **Restore drill:** once after the first scheduled backup, then after any schema change: restore a backup on a second machine with `scripts/host-restore-check.ts` and compare the counts with the live host. Never restore over the live file.

## Questions for the owner

1. Delete old model observations (keep 100 per session)? Recommended: yes.
2. Keep commands and requests forever for now, with a size threshold to revisit? Which threshold?
3. Where does the second backup copy live (MacBook, `.15`, other)? This decides whether the schedule needs SSH access, which needs its own approval.
4. Is a second LaunchAgent on `.4` for the daily backup acceptable? Installing it is a host change and needs approval.
