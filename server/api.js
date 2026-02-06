const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const db = require('../discord-crypto-task-payroll-bot/utils/db');

module.exports = function startApi(client) {
  const app = express();
  const session = require('express-session');
  app.use(cors());
  app.use(bodyParser.json());

  // Session (in-memory for now; replace with a persistent store in production)
  app.use(session({
    secret: process.env.SESSION_SECRET || 'replace-me',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true }
  }));

  // Auth helpers
  const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.access_token) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  };

  const isGuildAdmin = async (req, res, next) => {
    // expects session access token and guild id param or body
    try {
      const token = req.session.access_token;
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      const guildId = req.params.id || req.body.guild_id || req.query.guild_id;
      if (!guildId) return res.status(400).json({ error: 'Missing guild id' });

      const gRes = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${token}` } });
      const guilds = await gRes.json();
      const userGuild = guilds.find(g => String(g.id) === String(guildId));
      if (!userGuild) return res.status(403).json({ error: 'You are not a member of this guild' });

      // owner or has 'MANAGE_GUILD' permission bit
      const isOwner = !!userGuild.owner;
      const perms = parseInt(userGuild.permissions || '0', 10);
      const MANAGE_GUILD = 1 << 5; // bit 5 per Discord docs
      const hasManageGuild = (perms & MANAGE_GUILD) === MANAGE_GUILD;

      if (isOwner || hasManageGuild) return next();
      return res.status(403).json({ error: 'Insufficient permissions' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  };

  // OAuth callback helper: exchange code and set session
  const exchangeCodeForToken = async (code) => {
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: process.env.DISCORD_OAUTH_REDIRECT || 'http://localhost:3000/auth/discord/callback'
    });

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    return await tokenRes.json();
  };

  // Endpoint to fetch session user info
  app.get('/api/me', async (req, res) => {
    try {
      const token = req.session.access_token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      const uRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token}` } });
      const user = await uRes.json();
      const gRes = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${token}` } });
      const guilds = await gRes.json();
      // store minimal info in session for convenience
      if (req.session) req.session.user = { id: user.id, username: user.username };
      return res.json({ user, guilds });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Proofs: pending/approve/reject endpoints for web UI (admin)
  app.get('/api/proofs/pending', isAuthenticated, isGuildAdmin, async (req, res) => {
    try {
      const guildId = req.query.guild_id;
      const proofs = await db.getPendingProofs(guildId);
      res.json(proofs);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/proofs/:id/approve', isAuthenticated, isGuildAdmin, async (req, res) => {
    try {
      const proofId = parseInt(req.params.id, 10);
      const { pay } = req.body;
      const proof = await db.getProofSubmission(proofId);
      if (!proof) return res.status(404).json({ error: 'Proof not found' });
      await db.approveProof(proofId, req.session.user?.id || 'web');

      if (pay) {
        // replicate payment flow from approve-proof command
        const userData = await db.getUser(proof.user_id);
        if (!userData || !userData.solana_address) return res.status(400).json({ error: 'User wallet missing' });
        const crypto = require('../discord-crypto-task-payroll-bot/utils/crypto');
        const botWallet = crypto.getWallet();
        if (!botWallet) return res.status(500).json({ error: 'Bot wallet not configured' });

        let solAmount = proof.payout_amount;
        if (proof.payout_currency === 'USD') {
          const solPrice = await crypto.getSolanaPrice();
          solAmount = proof.payout_amount / solPrice;
        }

        const connection = new (require('@solana/web3.js').Connection)(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
        const recipient = new (require('@solana/web3.js').PublicKey)(userData.solana_address);
        const lamports = Math.floor(solAmount * 1e9);

        const { SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
        const instruction = SystemProgram.transfer({ fromPubkey: botWallet.publicKey, toPubkey: recipient, lamports });
        const transaction = new Transaction().add(instruction);
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = botWallet.publicKey;
        const signature = await sendAndConfirmTransaction(connection, transaction, [botWallet], { commitment: 'confirmed', maxRetries: 3 });
        await db.recordTransaction(proof.guild_id, botWallet.publicKey.toString(), userData.solana_address, solAmount, signature);
        return res.json({ success: true, signature });
      }

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/proofs/:id/reject', isAuthenticated, isGuildAdmin, async (req, res) => {
    try {
      const proofId = parseInt(req.params.id, 10);
      const { reason } = req.body;
      await db.rejectProof(proofId, reason || 'Rejected by admin', req.session.user?.id || 'web');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Health
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  // List contests (global)
  app.get('/api/contests', async (req, res) => {
    try {
      const contests = await db.getAllContests();
      res.json(contests);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Create contest
  app.post('/api/contests', async (req, res) => {
    try {
      const { guild_id, channel_id, title, description, prize_amount, currency = 'USD', num_winners = 1, max_entries = 100, duration_hours = 24, reference_url = '', created_by = 'web' } = req.body;
      const id = await db.createContest(guild_id, channel_id, title, description, prize_amount, currency, num_winners, max_entries, duration_hours, reference_url, created_by);

      // Optionally publish immediately
      if (req.body.publish) {
        try {
          const channel = await client.channels.fetch(channel_id);
          if (channel) {
            const msg = await channel.send(`🎉 **${title}** has started! Prize: ${prize_amount} ${currency} — Enter now!`);
            await db.updateContestMessageId(id, msg.id);
          }
        } catch (e) {
          console.error('[API] Publish error', e.message);
        }
      }

      const contest = await db.getContest(id);
      res.json(contest);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Trigger contest processing immediately (admin use)
  app.post('/api/contests/:id/process', isAuthenticated, isGuildAdmin, async (req, res) => {
    try {
      const contest = await db.getContest(req.params.id);
      if (!contest) return res.status(404).json({ error: 'Contest not found' });
      const { processContest } = require('./contestProcessor');
      const result = await processContest(contest, client);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // TASKS: list and create simple tasks
  app.get('/api/tasks', async (req, res) => {
    try {
      const tasks = await db.getPendingTasks();
      res.json(tasks);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // VOTE EVENTS
  app.get('/api/vote-events', async (req, res) => {
    try {
      const events = await db.getActiveVoteEvents();
      res.json(events);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/vote-events', async (req, res) => {
    try {
      const { guild_id, channel_id, title, description, prize_amount = 0, currency = 'USD', min_participants = 2, max_participants = 10, duration_minutes = 60, created_by = 'web' } = req.body;
      const id = await db.createVoteEvent(guild_id, channel_id, title, description, prize_amount, currency, min_participants, max_participants, duration_minutes, '', created_by);
      const ev = await db.getVoteEvent(id);
      res.json(ev);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/vote-events/:id/join', async (req, res) => {
    try {
      const { user_id } = req.body;
      await db.joinVoteEvent(parseInt(req.params.id, 10), req.body.guild_id || 'web', user_id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/tasks', async (req, res) => {
    try {
      const { guild_id, creator_id = 'web', recipient_address, amount, description = '' } = req.body;
      const id = await db.createTask(guild_id, creator_id, recipient_address, amount, description);
      const task = await db.getTask(id);
      res.json(task);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Execute a task immediately (attempt to pay)
  app.post('/api/tasks/:id/execute', async (req, res) => {
    try {
      const task = await db.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Basic payment flow using bot wallet
      const botWallet = require('../discord-crypto-task-payroll-bot/utils/crypto').getWallet();
      if (!botWallet) return res.status(500).json({ error: 'Bot wallet not configured' });

      const connection = new (require('@solana/web3.js').Connection)(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
      const recipient = new (require('@solana/web3.js').PublicKey)(task.recipient_address);
      const lamports = Math.floor(task.amount * 1e9);

      const { SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
      const instruction = SystemProgram.transfer({ fromPubkey: botWallet.publicKey, toPubkey: recipient, lamports });
      const transaction = new Transaction().add(instruction);
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = botWallet.publicKey;

      const signature = await sendAndConfirmTransaction(connection, transaction, [botWallet], { commitment: 'confirmed', maxRetries: 3 });

      await db.recordTransaction(task.guild_id, botWallet.publicKey.toString(), task.recipient_address, task.amount, signature);
      await db.updateTaskStatus(task.id, 'executed');

      res.json({ success: true, signature });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // List channels for a guild (requires bot to be in guild)
  app.get('/api/guilds/:id/channels', async (req, res) => {
    try {
      const guild = await client.guilds.fetch(req.params.id);
      if (!guild) return res.status(404).json({ error: 'Guild not found' });
      const channels = await guild.channels.fetch();
      const simple = channels.map(c => ({ id: c.id, name: c.name, type: c.type }));
      res.json(simple);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Publish arbitrary message to channel (requires bot to have access)
  app.post('/api/publish', isAuthenticated, isGuildAdmin, async (req, res) => {
    try {
      const { guild_id, channel_id, content } = req.body;
      const channel = await client.channels.fetch(channel_id);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });
      const msg = await channel.send({ content });
      res.json({ message_id: msg.id, channel_id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Scheduled posts endpoints
  app.post('/api/scheduled-posts', isAuthenticated, isGuildAdmin, async (req, res) => {
    try {
      const { guild_id, channel_id, content, scheduled_at } = req.body;
      const id = await db.createScheduledPost(guild_id, channel_id, content, scheduled_at, req.session.user?.id || 'web');
      const post = await db.getScheduledPostsForGuild(guild_id);
      res.json({ id, posts: post });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/scheduled-posts', isAuthenticated, async (req, res) => {
    try {
      const guildId = req.query.guild_id;
      if (!guildId) return res.status(400).json({ error: 'Missing guild_id' });
      const posts = await db.getScheduledPostsForGuild(guildId);
      res.json(posts);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Discord OAuth (basic) ---
  app.get('/auth/discord', (req, res) => {
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_OAUTH_REDIRECT || 'http://localhost:3000/auth/discord/callback',
      response_type: 'code',
      scope: 'identify guilds'
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
  });

  app.get('/auth/discord/callback', async (req, res) => {
    try {
      const code = req.query.code;
      if (!code) return res.status(400).send('Missing code');

      const tokenData = await exchangeCodeForToken(code);
      if (tokenData.error) {
        return res.status(400).send('OAuth error');
      }

      // Store access token in session
      req.session.access_token = tokenData.access_token;
      req.session.refresh_token = tokenData.refresh_token;

      // Redirect to web UI root (session cookie present)
      res.redirect(process.env.WEB_APP_URL || '/');
    } catch (e) {
      console.error('[OAuth] Error', e.message);
      res.status(500).send('OAuth error');
    }
  });

  app.get('/api/me', async (req, res) => {
    try {
      const auth = req.headers.authorization;
      if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });
      const token = auth.split(' ')[1];
      const uRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token}` } });
      const user = await uRes.json();
      const gRes = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${token}` } });
      const guilds = await gRes.json();
      res.json({ user, guilds });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const port = process.env.WEB_PORT || 3000;
  app.listen(port, () => console.log(`[API] Server listening on port ${port}`));
};
