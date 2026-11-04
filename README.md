# DT1 Logistics TMS

Self-contained Transportation Operations Management App.

## Setup

1. `cd dt1-tms`
2. `npm install`
3. `npm start`
4. Open http://localhost:3000

There is no default password in the source. Seeded admin accounts are created with an unknown random password until an admin or the one-time reset below sets one. Existing accounts keep the password they already have.

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

## Passwords

Forgot-password emails a one-hour, single-use link. The password does not change until that link is opened and a new password is saved. The page says the same thing whether or not the email matches an account. If the email cannot be sent, the account is left as it was.

`LOGAN_TMS_PASSWORD` is used only when Logan's account (`david.dt1@mail.grokbot.com`) does not already have a password. It is never printed in the logs.

### Get a locked-out admin back in

Use either method. Both force a new password at the next sign-in, before the rest of the app will open.

**Another admin, in the app**

1. Sign in as an admin who still has access.
2. Open **Users**.
3. On the locked-out account (an admin or a driver), leave the box blank and choose **Set temporary password**, or type one that is at least 6 characters.
4. Copy the password shown once on that page and give it to them outside the app. It is stored only as a hash.
5. They sign in with it and the change-password form is the only page they can use until they save a new password.

**One-time environment variables, when nobody can sign in**

1. Set `RESET_USER_EMAIL` to the account email. `logan.dt1@mail.grokbot.com` is accepted as an alias of `david.dt1@mail.grokbot.com`.
2. Set `RESET_USER_TEMP_PASSWORD` to a long random throwaway value.
3. Restart the service once. The log line is `One-time password reset applied`. The password itself is not logged.
4. Sign in with that throwaway. The app requires a new password immediately.
5. Remove `RESET_USER_EMAIL` and `RESET_USER_TEMP_PASSWORD` from the environment. Leaving the same pair in place does not reset the password again. Setting a different pair would apply that new value once. Do not leave the throwaway in the environment.
