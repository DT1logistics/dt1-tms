# DT1 Logistics TMS

Self-contained Transportation Operations Management App.

## Setup

1. `cd dt1-tms`
2. `npm install`
3. `npm start`
4. Open http://localhost:3000
5. Login: admin@dt1logistics.com / changeme123

## Deployment

Deploy to any Node.js host (Render, Railway, DigitalOcean, etc.) and set the PORT environment variable. The SQLite database file will be created automatically.

## Equipment import

Admins can bulk-import trucks and trailers from **Equipment → Import** (`/equipment/import`). Upload a CSV or `.xlsx` file, review the preview, then confirm. Rows are written only after that confirmation, in one database transaction with an `audit_log` entry. A CSV template is available on that page. Sheets named Reference or Notes are skipped.

## Data storage and backups

- `DATA_DIR` (Render: `/var/data`, a 1 GB persistent disk) holds `dt1.db` (SQLite) and `uploads/`.
  Unset, the app uses the repo folder as before (ephemeral on Render).
- First boot on an empty `DATA_DIR`: the database is restored from the Redis snapshot (if `REDIS_URL`
  is set) or copied from the old `./dt1.db`; old `./uploads` files are copied over. Nothing on the disk
  is ever overwritten.
- Login sessions are stored in SQLite (`sessions` table), so deploys/restarts don't sign users out.
- `GET /admin/backup` with header `X-Backup-Token: $BACKUP_TOKEN` (or `Authorization: Bearer ...`)
  returns `dt1-tms-backup-YYYY-MM-DD.zip`: a consistent SQLite snapshot (`dt1.db`, sessions removed),
  `uploads/`, and `manifest.json`. 404 if `BACKUP_TOKEN` (min 32 chars) isn't set, 401 on a bad token.
- Restore: stop the service, put `dt1.db` and `uploads/` from the zip into `DATA_DIR`, start it.
