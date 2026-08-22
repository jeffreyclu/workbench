# Workbench backup management

## What it does

Every 4 hours, launchd runs `scripts/backup.ts`:

1. Snapshots the live SQLite database (`data/workbench.db`) with `VACUUM INTO` into `data/backups/`.
2. Redacts `source_connections.settings_json` (Atlassian, GitHub, Slack, Figma tokens) to `{"redacted":true}`.
3. Pushes the redacted snapshot as `latest.db` to the private GitHub repo [`jeffreyclu/workbench-backups`](https://github.com/jeffreyclu/workbench-backups) — separate from the public `workbench` repo.

Local snapshots in `data/backups/` are kept for the last 20 runs (~3.3 days at 4h cadence) and pruned after that. The offsite copy keeps full history as git commits.

## Schedule

launchd agent `com.jeffrey.workbench.backup`, fires at 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 local time, plus once whenever the agent loads (e.g. after reboot).

Runs automatically as long as the Mac is on — no dependency on being logged into Claude Code.

## Trade-off

The offsite copy strips provider connection settings entirely (not just secrets — the whole config row). Restoring from this backup after losing local access means reconnecting Atlassian/GitHub/Slack/Figma manually. Everything else (work items, conversations, artifacts, history) restores intact.

## Commands

**Check status / logs**
```
launchctl list | grep com.jeffrey.workbench.backup
tail -f data/backups/backup.log
```

**Run it manually right now**
```
npm run backup:run
```

**Pause** (stops future runs, keeps the job installed)
```
launchctl unload ~/Library/LaunchAgents/com.jeffrey.workbench.backup.plist
```

**Resume**
```
launchctl load ~/Library/LaunchAgents/com.jeffrey.workbench.backup.plist
```

**Remove entirely**
```
launchctl unload ~/Library/LaunchAgents/com.jeffrey.workbench.backup.plist
rm ~/Library/LaunchAgents/com.jeffrey.workbench.backup.plist
```

**Change the schedule** — edit `scripts/workbench-backup.plist.template`, then rerun `npm run backup:install` (regenerates and reloads the plist).

**Inspect backups**
```
git clone https://github.com/jeffreyclu/workbench-backups /tmp/workbench-backups-check
ls /tmp/workbench-backups-check
```
or browse github.com/jeffreyclu/workbench-backups — each push is a commit, so history = restore points.
