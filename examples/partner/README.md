# Runnable partner example

Requires Node 24. Save the public example download as `client.mts` (remove the `.txt` suffix). Run `npm ci` in the API repository, or copy `client.mts` into a new project and run `npm install openid-client@6.8.8`.

Set `MOH_ISSUER`, `CLIENT_ID`, `CLIENT_SECRET`, `CALLBACK_URL` and `WEBHOOK_SECRET` in your server environment, then run `node examples/partner/client.mts`. The callback must be the exact registered HTTPS URL, proxied to `127.0.0.1:8787` (or `PORT`). Point the registered webhook at `/webhook`. Open `/connect` to start. After consent, `/` shows `/me` and one public post. `POST /revoke` with an exact same-origin browser request revokes the token.

Use test credentials only. The example keeps session state and deduplication in memory for one process. Production must use an encrypted shared session store, durable event inbox, transactional version/tombstone updates, and a distributed lock per refresh grant. Store rotated tokens before releasing that lock. On 429, honor Retry-After and retry the identical request within the documented replay window; after a permanent refresh error ask the user to reconnect. Never log token responses or callback query strings.

`npm run check:partner-example` validates the TypeScript. `npm run test:partner-protocol` exercises the maintained OIDC client against the real provider with synthetic storage, including signed ID-token and nonce validation. The example never publishes content to either platform.
