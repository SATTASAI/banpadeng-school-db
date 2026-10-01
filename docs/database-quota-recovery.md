# Production login outage: D1 daily read quota

On 2026-10-01, the production login query returned Cloudflare's provider error: the account exceeded D1's Free daily row read limit. Empty-result queries could still appear healthy, so `/api/auth/me` without a session did not establish that account rows could be read.

The Free allowance is five million rows read per account/day; reset occurs at 00:00 UTC (07:00 Asia/Bangkok). Immediate provider recovery requires the account owner to activate Workers Paid. The deployment credential does not grant billing access. No account password was changed during diagnosis.

`databaseQuotaResponse` recognizes nested D1 read/write quota errors, returns a clear Thai message, a UTC `reset_at`, and `Retry-After`. Login and general API failures use this response. Temporary diagnostic routes and workflows have been removed.

The shared API client records quota exhaustion in tab session storage and rejects background queries locally until reset. Explicit login retries remain available. Successful login, or an authenticated `auth/me` response, clears the pause. Expiry restores normal requests automatically. This stops repeated failed queries after detection; it does not increase the provider allowance or guarantee that the next day's workload fits the Free plan.

Validation: 78 automated tests passed, including successful login with a real fixture password, wrong-password rejection, nested quota failures, Thai reset time, browser polling pause and recovery after login. Worker dry build passed. Production recovery remains subject to the Cloudflare quota reset or account upgrade.

Provider documentation: https://developers.cloudflare.com/d1/platform/pricing/
