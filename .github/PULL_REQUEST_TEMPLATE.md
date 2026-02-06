## Summary

Adds a web-based UI and HTTP API for managing Contests, Tasks, and Vote Events for DisCryptoBank. The web UI (Vite + React) is at `/web/` and the API is integrated into the existing bot process (started via `server/api.js`).

## Features

- Frontend: `web/` Vite React app
  - Dashboard: list and create contests, publish to channels, process contest payouts
  - Tasks page: list, create, and execute tasks
  - Vote Events: list and create vote events
- Backend/API: `server/api.js`
  - `GET /api/contests`, `POST /api/contests` (publish optional)
  - `POST /api/contests/:id/process` (admin: force processing/payout)
  - `GET /api/guilds/:id/channels` - list channels from guild
  - `GET /api/tasks`, `POST /api/tasks`, `POST /api/tasks/:id/execute`
  - `GET /api/vote-events`, `POST /api/vote-events`, `POST /api/vote-events/:id/join`
  - Basic Discord OAuth endpoints (`/auth/discord`, `/auth/discord/callback`) and `/api/me` to return user/guilds
- Contest processor extracted to `server/contestProcessor.js` and reused by the bot and the API
- Dockerfile and `docker-compose.yml` for local dev; GitHub Action that builds `web` and deploys to `gh-pages` on push to `main`.

## Notes & Setup

- Install dependencies: `cd discord-crypto-task-payroll-bot && npm install` (Windows UNC paths can require elevated permissions)
- Run bot (starts API): `npm start` from `discord-crypto-task-payroll-bot`
- Run frontend dev server: `cd web && npm install && npm run dev`
- Provide `DISCORD_CLIENT_SECRET` in env for OAuth testing

## Testing

- Create a contest via the web UI; publish immediately or schedule (publish now). The bot will announce and, on end time or when processed via `Process Now`, winners will be selected and prizes distributed via existing payment flow.

## Security

- The API endpoints that execute payouts and process contests are powerful. We recommend adding proper OAuth-based admin checks before allowing any untrusted caller to process payouts. This scaffolding is present (OAuth flow) but requires `DISCORD_CLIENT_SECRET` and session handling to harden.

---

Please review and let me know if you'd like me to (1) complete OAuth session handling and role checks now, (2) add scheduled publish UI, (3) expand Tasks/Proof workflows in the web UI, or (4) open the PR as-is for review.
