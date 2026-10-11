# Rakazo on Railway

The template runs Rakazo, PostgreSQL and agent computers on Railway. No Docker host or separate sandbox provider is needed. Railway usage and any connected model provider are billed separately.

## Deploy

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/lugj-u)

1. Deploy the template. Enter your email in `OWNER_EMAIL` and a Railway workspace or account API token in `RAILWAY_API_TOKEN`.
2. Wait for Rakazo to become healthy. Open its generated HTTPS domain.
3. Sign in with your email and the generated `OWNER_PASSWORD` from the Rakazo service's Variables tab. Change the password in account settings.
4. Connect your model account in Rakazo and send Chief a message.

The token must be able to create environments and sandboxes in the project. Prefer a dedicated Railway workspace. Never place it in a bot's files or model connection settings.

## Defaults

- The owner account is created before the public web server starts. Public registration is closed on every start; this template is intended for a personal deployment.
- Every install gets separate random database, authentication, encryption, screen and initial owner secrets. Keep the encryption key and database password stable across redeploys.
- PostgreSQL has no public endpoint. Only the web port is published; the API binds to loopback.
- Computers run in a separate, empty Railway environment, so they cannot reach the application's private database network. Startup creates this environment automatically and reuses it on restart.
- App processes run as the unprivileged `node` user. The entrypoint briefly uses root to set the mounted volume's owner, then drops privileges.
- The API, worker and web share one service and `/data` volume. PostgreSQL has its own volume. Both volumes have daily backups enabled. Run one application replica; do not enable service sleeping.
- Any process failure restarts the application service. Database migrations finish before startup. Idle computers stop after ten minutes; each user can create up to three computers.

## Updates and backups

Redeploy the source branch to update. The owner bootstrap keeps existing accounts and passwords. Changing `OWNER_PASSWORD` later does not reset an account password.

Back up PostgreSQL, `/data`, and `ENCRYPTION_KEY` before upgrades. Railway volume persistence is not a backup. Keep backups private and test restoring them together. Do not delete volumes to fix a failed deploy.

The sandbox environment is separate from the app environment. Do not put trusted services or secrets there. If you delete the application project, check for and remove its remaining computers.

The template cannot generate a Railway API credential or a model account for you. These are the only outside account setup steps; no third-party sandbox service is required.
