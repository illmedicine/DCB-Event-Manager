const { Connection, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const crypto = require('../discord-crypto-task-payroll-bot/utils/crypto');
const db = require('../discord-crypto-task-payroll-bot/utils/db');
const { EmbedBuilder } = require('discord.js');

async function processContest(contest, client) {
  try {
    console.log(`[ContestProcessor] Processing contest #${contest.id}: ${contest.title}`);

    // Mark as ended early
    await db.updateContestStatus(contest.id, 'ended');

    // Get entries
    const entries = await db.getContestEntries(contest.id);
    if (!entries || entries.length === 0) {
      // Announce no winners
      try {
        const channel = await client.channels.fetch(contest.channel_id);
        if (channel) {
          const noWinnersEmbed = new EmbedBuilder()
            .setColor('#FF6600')
            .setTitle(`🎉 Contest #${contest.id} Ended - No Winners`)
            .setDescription(`**${contest.title}** has ended, but no one entered.`)
            .addFields(
              { name: '🎁 Prize', value: `${contest.prize_amount} ${contest.currency}` },
              { name: '📊 Entries', value: '0' }
            )
            .setTimestamp();

          await channel.send({ embeds: [noWinnersEmbed] });
        }
      } catch (e) {
        console.log(`[ContestProcessor] Could not announce no-winner result for contest #${contest.id}`);
      }
      await db.updateContestStatus(contest.id, 'completed');
      return { result: 'no_entries' };
    }

    // Select winners
    const numWinners = Math.min(contest.num_winners, entries.length);
    const shuffled = [...entries].sort(() => Math.random() - 0.5);
    const winners = shuffled.slice(0, numWinners);
    const winnerIds = winners.map(w => w.user_id);

    await db.setContestWinners(contest.id, winnerIds);

    const prizePerWinner = contest.prize_amount / numWinners;

    const guildWallet = await db.getGuildWallet(contest.guild_id);

    if (!guildWallet) {
      // Announce winners but note payment issue
      try {
        const channel = await client.channels.fetch(contest.channel_id);
        if (channel) {
          const winnerMentions = winnerIds.map(id => `<@${id}>`).join(', ');
          const noTreasuryEmbed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle(`🎉🏆 Contest #${contest.id} Winners! 🏆🎉`)
            .setDescription(`**${contest.title}** has ended!\n\n⚠️ **Payment Issue:** No treasury wallet configured for this server. Winners have been selected but prizes could not be distributed automatically.`)
            .addFields(
              { name: '🎊 Winners', value: winnerMentions || 'None' },
              { name: '🎁 Prize Owed', value: `${prizePerWinner.toFixed(4)} ${contest.currency} each` },
              { name: '⚠️ Action Required', value: 'Server admin must configure treasury with `/wallet connect` and manually pay winners.' }
            )
            .setTimestamp();

          await channel.send({ content: `🎉 **CONTEST WINNERS!** 🎉\n\nCongratulations ${winnerMentions}!`, embeds: [noTreasuryEmbed] });
        }
      } catch (e) {
        console.error('[ContestProcessor] Could not announce winners:', e.message);
      }
      await db.updateContestStatus(contest.id, 'completed');
      return { result: 'no_treasury' };
    }

    // Check bot wallet and distribute prizes
    const botWallet = crypto.getWallet();
    if (!botWallet) {
      console.error('[ContestProcessor] Bot wallet not configured');
      return { result: 'no_bot_wallet' };
    }

    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

    const paymentResults = [];

    for (const winner of winners) {
      try {
        const userData = await db.getUser(winner.user_id);
        if (userData && userData.solana_address) {
          const currentBotBalance = await crypto.getBalance(botWallet.publicKey.toString());
          if (currentBotBalance < prizePerWinner) {
            paymentResults.push({ userId: winner.user_id, success: false, reason: 'Insufficient bot wallet balance' });
            continue;
          }

          const recipientPubkey = new PublicKey(userData.solana_address);
          const lamports = Math.floor(prizePerWinner * 1e9);

          const instruction = SystemProgram.transfer({ fromPubkey: botWallet.publicKey, toPubkey: recipientPubkey, lamports });
          const transaction = new Transaction().add(instruction);

          const { blockhash } = await connection.getLatestBlockhash('confirmed');
          transaction.recentBlockhash = blockhash;
          transaction.feePayer = botWallet.publicKey;

          const signature = await sendAndConfirmTransaction(connection, transaction, [botWallet], { commitment: 'confirmed', maxRetries: 3 });

          await db.recordTransaction(contest.guild_id, botWallet.publicKey.toString(), userData.solana_address, prizePerWinner, signature);

          paymentResults.push({ userId: winner.user_id, address: userData.solana_address, amount: prizePerWinner, success: true, signature });
        } else {
          paymentResults.push({ userId: winner.user_id, success: false, reason: 'No wallet connected' });
        }
      } catch (err) {
        console.error('[ContestProcessor] Payment error for', winner.user_id, err.message);
        paymentResults.push({ userId: winner.user_id, success: false, reason: err.message });
      }
    }

    // Announce results
    try {
      const channel = await client.channels.fetch(contest.channel_id);
      if (channel) {
        const winnerMentions = winnerIds.map(id => `<@${id}>`).join(', ');
        let paymentSummary = '';
        for (const result of paymentResults) {
          if (result.success) paymentSummary += `✅ <@${result.userId}>: ${prizePerWinner.toFixed(4)} ${contest.currency} - [View TX](https://solscan.io/tx/${result.signature})\n`;
          else paymentSummary += `❌ <@${result.userId}>: Payment failed - ${result.reason}\n`;
        }

        const winnersEmbed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle(`🎉🏆 Contest #${contest.id} Winners Announced! 🏆🎉`)
          .setDescription(`**${contest.title}** has ended!`)
          .addFields(
            { name: '🎁 Total Prize', value: `${contest.prize_amount} ${contest.currency}`, inline: true },
            { name: '🏆 Winners', value: `${numWinners}`, inline: true },
            { name: '💰 Per Winner', value: `${prizePerWinner.toFixed(4)} ${contest.currency}`, inline: true },
            { name: '📊 Total Entries', value: `${entries.length}`, inline: true },
            { name: '🏦 Paid From', value: `Guild Treasury\n\`${guildWallet.wallet_address.slice(0, 8)}...${guildWallet.wallet_address.slice(-6)}\``, inline: true },
            { name: '🎊 Winners', value: winnerMentions || 'None' },
            { name: '💸 Prize Distribution', value: paymentSummary || 'Processing...' }
          )
          .setTimestamp();

        await channel.send({ content: `🎉 **CONTEST WINNERS!** 🎉\n\nCongratulations ${winnerMentions}!`, embeds: [winnersEmbed] });
      }
    } catch (e) {
      console.error('[ContestProcessor] Could not announce winners:', e.message);
    }

    await db.updateContestStatus(contest.id, 'completed');

    return { result: 'processed', payments: paymentResults };
  } catch (e) {
    console.error('[ContestProcessor] Error processing contest:', e.message);
    return { result: 'error', error: e.message };
  }
}

module.exports = { processContest };
