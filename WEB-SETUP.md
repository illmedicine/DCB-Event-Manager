# DCB Event Manager - Web UI Integration

Overview

This repository now includes a `web/` React app (Vite + TypeScript) and an integrated HTTP API (`server/api.js`) added to the DiscryptoBank bot backend.

Local development

1. Install bot dependencies: `cd discord-crypto-task-payroll-bot && npm install` (may require elevated permissions on Windows network drives)
2. Start the bot (which now also starts the API): `npm start` (from `discord-crypto-task-payroll-bot`)
3. In a separate terminal, run the frontend dev server: `cd web && npm install && npm run dev`

Endpoints

- `GET /api/health` - health check
- `GET /api/contests` - list contests
- `POST /api/contests` - create contest (JSON body)
- `POST /api/publish` - publish a message to a channel (requires the bot to have channel access)

Notes

- OAuth: the backend will be extended to support Discord OAuth for authenticating server admins. Currently the web UI assumes the operator has an appropriate token and/or is a server admin.
- Payments: contest payouts are handled by the bot's existing contest scheduler and Solana payment logic. Creating contests with `ends_at` triggers the existing payout flow.