# Gmail account setup

This guide sets up the local Desktop OAuth connection used by phase 03. It covers only
`gmail.readonly`; the connector never requests send, modify, or delete access. Credentials
and tokens stay local and are stored only as encrypted rows in `account_credentials`.

## 1. Google Cloud project and Gmail API

1. Create or select a Google Cloud project for this assistant.
2. Enable the **Gmail API** for that project.
3. Configure the OAuth consent screen. Choose the audience that matches the accounts you will
   connect:
   - **External** with the app in **Testing** while developing. Add each Gmail address as a
     test user; only those users can authorize the app.
   - **Internal** for a Google Workspace organization whose users are in the same Workspace.
4. Keep the only requested scope at `https://www.googleapis.com/auth/gmail.readonly`.

## 2. Desktop OAuth client

1. In **APIs & Services → Credentials**, create an OAuth client of type **Desktop app**.
2. Put its values in `.env` (or the process environment):
   ```sh
   GMAIL_CLIENT_ID=...
   GMAIL_CLIENT_SECRET=...
   ```
3. Configure the token encryption ring as described in the main README:
   ```sh
   openssl rand -base64 32
   # then set TOKEN_ENCRYPTION_KEYS=1:<output>
   TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION=1
   ```
4. Mail processing is opt-in. Set `MAIL_ENABLED=true` when the worker should sync and classify
   mail. The connect command itself works with it unset, so accounts can be prepared first.

The connect command uses a loopback callback on `127.0.0.1` with a random port and a bounded
five-minute flow. No public callback URL is registered or exposed. Desktop clients accept this
loopback form without a fixed redirect URI.

## 3. Connect each account

Run the command once per mailbox and sign in as the intended account. Use the primary Gmail
address Google shows in its profile (an alias or plus-address may not match):

```sh
pnpm gmail:connect --email you@example.com
```

The command:

- generates PKCE and a one-use state value;
- opens the authorization URL (or prints it; add `--no-browser` to only print it);
- requests offline access with an explicit consent prompt and only `gmail.readonly`;
- verifies the authorized Gmail profile matches `--email` and that the granted scope is exactly
  `gmail.readonly`;
- atomically stores the account, the first-connection notification boundary, and encrypted
  access/refresh envelopes.

If Google authorizes a different account, the command aborts without saving anything. If you
reconnect an existing account:

- the original `notification_boundary_at` is preserved, so backfill stays silent;
- a new access token/expiry is stored;
- a rotated refresh token replaces the old envelope;
- if Google omits a refresh token, the existing encrypted refresh token is preserved. On a
  first connection, a missing refresh token aborts without saving; retry the consent flow.

No command prints access or refresh tokens.

With `MAIL_ENABLED=true`, the worker runs a sync coordinator about every minute. The first sync
backfills the preceding seven days silently and replays arrivals from a checkpoint captured before
the backfill; later runs use paginated Gmail history and recover expired cursors from the last
success with overlap. One mailbox's failure/backoff does not stop the others. Gmail calls are paced
by `GMAIL_REQUEST_DELAY_MS` (default 350 ms, range 0–5000) to avoid per-minute project quota
bursts; raise it if Google returns `Quota exceeded`, or set it to `0` for fast local tests.
Classification and alerting consume the cleaned stored mail.

## 4. Local controls

```sh
pnpm mail:accounts list
pnpm mail:accounts pause you@example.com
pnpm mail:accounts resume you@example.com
```

`list` shows status, granted scopes, the notification boundary, last success/failure, and the
last bounded error. Paused accounts are skipped by sync. Revoked accounts must be reconnected
with `gmail:connect`; `resume` refuses them. A missing `gmail.readonly` grant also requires a
reconnect.

Company domains help classification distinguish work mail. Bank senders are stored in the
existing VIP sender list and apply across all inboxes:

```sh
pnpm mail:config company-domains add acme.example --label "Acme"
pnpm mail:config company-domains list
pnpm mail:config company-domains disable acme.example

pnpm mail:config bank-senders add alerts@example-bank.com --name "Example Bank"
pnpm mail:config bank-senders list
pnpm mail:config bank-senders disable alerts@example-bank.com
```

Add `--all` to either list command to include disabled entries. Values are normalized and
matched case-insensitively.

Classification backlog, failures, and today's model spend are visible without printing message
content:

```sh
pnpm mail:triage status
pnpm mail:triage retry-failed --all
pnpm mail:triage retry-failed --id <message-id>
```

`retry-failed` is the explicit recovery path for refusals, invalid model output, or a message that
exhausted its five classification attempts. At the daily model budget, queued mail resumes after
local midnight in `Asia/Kolkata`; mail sync and explicit rules continue.

## 5. Token lifecycle and Testing-mode expiry

The connector stores only encrypted refresh/access tokens. The lifecycle helper reuses a stored
access token until shortly before expiry, then refreshes it; rotated refresh tokens are
re-encrypted with the active key version. Access-token expiry is persisted so a worker restart
does not force an unnecessary refresh.

Google's refresh-token lifetime depends on the consent-screen publishing state:

- An **External** app in **Testing** issues refresh tokens that expire after about seven days.
  When that happens the account becomes `revoked` and `mail:accounts list` shows a reconnect
  instruction. Re-run `gmail:connect` for that address. Google's policy can change; check the
  current OAuth documentation.
- A published External app or an Internal Workspace app generally has longer-lived refresh
  tokens, subject to Google's policies, user revocation, password changes, and admin controls.
- Missing scopes and permanent authorization errors mark the account `error`; revoked grants mark
  it `revoked`. Neither condition stops other mailboxes because state and retries are per account.

## 6. Troubleshooting

| Symptom | Action |
| --- | --- |
| `access_denied` while signing in | Approve the requested `gmail.readonly` scope; add the account as a test user for an External Testing app |
| Authorized account does not match `--email` | Re-run with the exact Gmail address shown in Google's account chooser |
| Missing scope / unexpected scope | Ensure only `gmail.readonly` is configured, then reconnect; do not grant broader scopes |
| `invalid_grant` / account `revoked` | The refresh token expired or was revoked; reconnect that account |
| Account `error` after a temporary outage | Retry/resume after connectivity returns; permanent auth failures still require reconnect |
| `Quota exceeded` / `Total Query Cost` during sync | Keep or raise `GMAIL_REQUEST_DELAY_MS` (default 350 ms); wait for the per-minute quota window and let the per-account backoff retry |
| `GMAIL_CLIENT_ID` or key-ring error | Fill the Desktop client and encryption env values; never paste tokens or key material into docs |

## References

- [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [OAuth token lifecycle](https://developers.google.com/identity/protocols/oauth2)
- [Gmail read-only scope](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail API getting started](https://developers.google.com/workspace/gmail/api/quickstart)
