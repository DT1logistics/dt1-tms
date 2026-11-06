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

## Logan load review

Logan (the operations assistant) reviews new loads for missing information. Drivers do not submit review requests and do not see this workflow.

When a load is created in the app or through the API below, and both `LOGAN_WEBHOOK_URL` and `LOGAN_WEBHOOK_KEY` are set, the app POSTs a JSON body to that URL:

```json
{
  "event": "load.created",
  "load_id": 42,
  "load_number": "T-100",
  "created_by": "Kammy",
  "created_via": "ui",
  "pickup": "Richmond Yard",
  "delivery": "Norfolk Pier",
  "pickup_delivery_summary": "Pickup: Richmond Yard; Delivery: Norfolk Pier",
  "link": "https://dt1-tms.onrender.com/loads/42"
}
```

`created_via` is `ui` or `api`. API-created loads notify Logan too, so the routine can tell its own creates from ones entered in the app.

The webhook key is sent as a Bearer token, which is what a Cursor/Grok Bot routine expects (`Authorization: Bearer <LOGAN_WEBHOOK_KEY>`). The POST runs in the background with a short timeout and two retries. A webhook failure is logged (the key is not logged) and does not fail load creation. If either env var is unset, nothing is sent.

Review status on a load is `none`, `needs_review`, `flagged_missing_info`, or `cleared`, with notes, who set it, and when. New loads start as `needs_review`. Admins see a flag on the load list and the load page, and can filter with `/loads?review=flagged`. An admin can edit the notes or clear the flag. Only an admin can accept a load or reject it with a reason; that decision is stored with who/when and written to the audit log. Logan's API token cannot accept or reject.

### Bot API

`LOGAN_API_TOKEN` (at least 32 characters, same rule as `BACKUP_TOKEN`) authenticates `Authorization: Bearer <token>`. The token is compared in constant time. If it is unset, these routes are 404. A missing or wrong token is 401. Requests are rate limited per IP. The actor on audit rows is `Logan (API)`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/logan/loads/:idOrNumber` | One load by id, or by ticket number when the id does not match |
| GET | `/api/logan/loads?flagged=1&limit=50` | Recent loads; `flagged=1` (or `review=flagged`) keeps flagged loads |
| GET | `/api/logan/drivers` | Driver id, name, email, and status, for assignment |
| POST | `/api/logan/loads` | Create a load. Same checks as the admin form: a driver is required, and a project is required unless `action` is `draft` |
| POST or PATCH | `/api/logan/loads/:id/review` | Set `review_status` and notes. Cannot accept or reject |

```bash
curl -s -H "Authorization: Bearer $LOGAN_API_TOKEN" \
  https://dt1-tms.onrender.com/api/logan/loads?flagged=1

curl -s -H "Authorization: Bearer $LOGAN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"review_status":"flagged_missing_info","review_notes":["Ticket #","BOL file"]}' \
  https://dt1-tms.onrender.com/api/logan/loads/42/review

curl -s -H "Authorization: Bearer $LOGAN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"submit","driver_id":3,"project_id":5,"ticket_number":"T-100","load_date":"2026-11-03","origin":"Richmond Yard","destination":"Norfolk Pier","weight_quantity":18,"rate":12.5}' \
  https://dt1-tms.onrender.com/api/logan/loads
```

Reject and accept stay on the admin load page (`POST /loads/:id/review-decision`). The API returns 403 for reject, accept, approve, delete, user, password, and equipment changes.

On Render, set `LOGAN_WEBHOOK_URL`, `LOGAN_WEBHOOK_KEY`, and `LOGAN_API_TOKEN` in the service dashboard. They are listed in `render.yaml` with `sync: false`, so a Blueprint sync does not fill them in and preview environments do not receive them.

## Quo inbound texts

Quo (formerly OpenPhone) can notify this app when a text arrives on the DT1 line. The app checks Quo's signature, then forwards a short summary to Logan's Grok Bot routine. The message text is not written to the database.

`POST /webhooks/quo/message-received`

No login is required. Quo signs the raw body, so the app reads those exact bytes before it parses the JSON.

Current Quo webhooks (API `2026-03-30`) send three headers: `webhook-id`, `webhook-timestamp`, and `webhook-signature`. The signature is a space-separated list of `v1,<base64 HMAC-SHA256>` values over `{webhook-id}.{webhook-timestamp}.{raw body}`. The signing secret looks like `whsec_<base64>`; the HMAC key is the base64-decoded part after `whsec_`. Older OpenPhone webhooks send one header, `openphone-signature`, formatted `hmac;1;<timestamp>;<base64 signature>`, over `{timestamp}.{raw body}` with the base64-decoded secret as the key. This endpoint accepts either scheme. A signature that does not match, or a timestamp more than 5 minutes from now, returns `401` and nothing is forwarded.

Only a `message.received` event is forwarded. Any other event type returns `200` and is ignored. When `QUO_DT1_PHONE_NUMBER` is set (for example `+18042592256`), only texts whose `to` number is that line are forwarded; other numbers return `200` and are ignored. Leave it unset to forward every inbound text. The same delivery is forwarded once; a retry with the same `webhook-id` or message id is ignored for about 10 minutes.

The JSON posted to Logan is:

```json
{
  "source": "quo",
  "line": "+18042592256",
  "from": "+15550001111",
  "to": "+18042592256",
  "body": "Need a truck at the yard",
  "receivedAt": "2026-04-13T12:00:00.000Z",
  "conversationId": "CN123",
  "messageId": "AC-message"
}
```

`LOGAN_QUO_WEBHOOK_KEY` is sent as `Authorization: Bearer <key>`, the same way the load webhook sends `LOGAN_WEBHOOK_KEY`. The app answers Quo with `200` without waiting for Logan. That forward uses one short attempt. The log line includes the message id and whether the forward succeeded or failed. It does not include the text, the signing secret, or the routine key.

If `QUO_WEBHOOK_SECRET`, `LOGAN_QUO_WEBHOOK_URL`, or `LOGAN_QUO_WEBHOOK_KEY` is missing, the endpoint returns `503`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `QUO_WEBHOOK_SECRET` | yes | Quo signing secret (`whsec_...`, or the legacy base64 secret) |
| `LOGAN_QUO_WEBHOOK_URL` | yes | Logan routine URL that receives the summary |
| `LOGAN_QUO_WEBHOOK_KEY` | yes | Bearer token for that routine |
| `QUO_DT1_PHONE_NUMBER` | no | Forward only texts to this line, such as `+18042592256` |

On Render, set them in the service dashboard. They are listed in `render.yaml` with `sync: false`, so a Blueprint sync does not fill them in and preview environments do not receive them.

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
