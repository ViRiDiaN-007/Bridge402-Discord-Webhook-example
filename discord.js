// discord.js
// Bridge402 Discord Webhook Forwarder - Solana version
// Requires: node >=18
// npm i undici ws dotenv @solana/web3.js @solana/spl-token
// ENV: BASE_URL, SOLANA_RPC, KEYPAIR_PATH or KEYPAIR_JSON, DISCORD_WEBHOOK_URL
// Optional: SOL_USDC_MINT, SOL_FEE_PAYER (auto-fetched if not set)

import 'dotenv/config';
import { request } from 'undici';
import WebSocket from 'ws';
import fs from 'fs';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferCheckedInstruction, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

// Helper function to build exact payment transaction
async function buildExactPaymentTx({
  connection,
  payerPublicKey,
  feePayerPublicKey,
  recipientPublicKey,
  mintPublicKey,
  amountAtomic,
  createRecipientATAIfMissing = true,
}) {
  // Ensure PublicKey objects
  const payerPubkey = payerPublicKey instanceof PublicKey ? payerPublicKey : new PublicKey(payerPublicKey);
  const feePayerPubkey = feePayerPublicKey instanceof PublicKey ? feePayerPublicKey : new PublicKey(feePayerPublicKey);
  const recipientPubkey = recipientPublicKey instanceof PublicKey ? recipientPublicKey : new PublicKey(recipientPublicKey);
  const mintPubkey = mintPublicKey instanceof PublicKey ? mintPublicKey : new PublicKey(mintPublicKey);

  const instructions = [];

  // The facilitator REQUIRES ComputeBudget instructions in positions 0 and 1
  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 })
  );
  instructions.push(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })
  );

  // Determine program (token vs token-2022) by reading mint owner
  const mintInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
  const programId =
    mintInfo?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

  // Fetch mint to get decimals
  const mint = await getMint(connection, mintPubkey, undefined, programId);

  // Derive source and destination ATAs
  const sourceAta = await getAssociatedTokenAddress(mintPubkey, payerPubkey, false, programId);
  const destinationAta = await getAssociatedTokenAddress(mintPubkey, recipientPubkey, false, programId);

  // Check if source ATA exists
  const sourceAtaInfo = await connection.getAccountInfo(sourceAta, 'confirmed');
  if (!sourceAtaInfo) {
    throw new Error(`Payer does not have an Associated Token Account for ${mintPubkey.toBase58()}`);
  }

  // Create ATA for destination if missing
  if (createRecipientATAIfMissing) {
    const destAtaInfo = await connection.getAccountInfo(destinationAta, 'confirmed');
    if (!destAtaInfo) {
      const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
      instructions.push(
        new TransactionInstruction({
          keys: [
            { pubkey: feePayerPubkey, isSigner: true, isWritable: true },
            { pubkey: destinationAta, isSigner: false, isWritable: true },
            { pubkey: recipientPubkey, isSigner: false, isWritable: false },
            { pubkey: mintPubkey, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: programId, isSigner: false, isWritable: false },
          ],
          programId: ASSOCIATED_TOKEN_PROGRAM_ID,
          data: Buffer.from([0]),
        })
      );
    }
  }

  // TransferChecked instruction
  instructions.push(
    createTransferCheckedInstruction(
      sourceAta,
      mintPubkey,
      destinationAta,
      payerPubkey,
      amountAtomic,
      mint.decimals,
      [],
      programId
    )
  );

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const message = new TransactionMessage({
    payerKey: feePayerPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  // Create transaction (not signed yet - caller will sign)
  return new VersionedTransaction(message);
}

const BASE_URL    = process.env.BASE_URL    || 'http://localhost:8081';
const SOLANA_RPC  = process.env.SOLANA_RPC  || 'https://api.mainnet-beta.solana.com';
const KEYPAIR_PATH= process.env.KEYPAIR_PATH || null;
const KEYPAIR_JSON= process.env.KEYPAIR_JSON || null;
const SOL_USDC_MINT = process.env.SOL_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

function loadKeypair() {
  if (KEYPAIR_JSON) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(KEYPAIR_JSON)));
  if (KEYPAIR_PATH) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH,'utf8'))));
    } catch (err) {
      throw new Error(`Failed to load keypair from ${KEYPAIR_PATH}: ${err.message}`);
    }
  }
  console.error('\n❌ Error: Solana keypair required to sign transactions');
  console.error('\nSet one of these environment variables:');
  console.error('  KEYPAIR_PATH    - Path to JSON file with keypair secret key');
  console.error('  KEYPAIR_JSON    - JSON array string of secret key');
  console.error('\nGenerate a test keypair:');
  console.error('  node generate-test-keypair.js');
  console.error('\nThen set the environment variable:');
  console.error('  Windows:        set KEYPAIR_PATH=test-keypair.json');
  console.error('  PowerShell:     $env:KEYPAIR_PATH="test-keypair.json"');
  console.error('  Linux/Mac:      export KEYPAIR_PATH=test-keypair.json');
  console.error('');
  throw new Error('Set KEYPAIR_PATH or KEYPAIR_JSON');
}

async function httpPost(url, { headers = {}, body = undefined } = {}) {
  const res = await request(url, { method: 'POST', headers, body });
  const text = await res.body.text();
  try { return { status: res.statusCode, json: JSON.parse(text) }; } catch { return { status: res.statusCode, json: text }; }
}

async function httpGet(url, { headers = {} } = {}) {
  const res = await request(url, { method: 'GET', headers });
  const text = await res.body.text();
  try { return { status: res.statusCode, json: JSON.parse(text) }; } catch { return { status: res.statusCode, json: text }; }
}

async function fetchSupportedFeePayer() {
  try {
    const facilitatorUrl = process.env.FACILITATOR_URL?.replace(/\/$/,'') || 'https://facilitator.payai.network';
    console.log(`🔍 Fetching feePayer from facilitator: ${facilitatorUrl}/supported`);
    const { status, json } = await httpGet(`${facilitatorUrl}/supported`);
    if (status !== 200 || typeof json !== 'object') {
      console.error(`❌ Facilitator /supported returned ${status}:`, json);
      return null;
    }
    const sol = (json.kinds || []).find(k => k.network === 'solana');
    const feePayer = sol?.extra?.feePayer;
    if (feePayer) {
      console.log(`✅ Found feePayer: ${feePayer}`);
    } else {
      console.error('❌ feePayer not found in facilitator response:', JSON.stringify(json, null, 2));
    }
    return feePayer || null;
  } catch (err) {
    console.error('❌ Error fetching feePayer:', err.message);
    return null;
  }
}

async function getInvoice(minutes=5) {
  const { status, json } = await httpPost(`${BASE_URL}/connect?duration_min=${minutes}&network=sol`);
  if (status !== 402) throw new Error(`Expected 402 invoice, got ${status}: ${JSON.stringify(json)}`);
  const accepts = (json.accepts && json.accepts[0]) || json;
  return accepts;
}

async function payInvoice(accepts, payer, conn) {
  const feePayerStr = accepts?.extra?.feePayer || process.env.SOL_FEE_PAYER || await fetchSupportedFeePayer();
  if (!feePayerStr) throw new Error('Missing facilitator feePayer for Solana');
  const feePayer = new PublicKey(feePayerStr);

  const mint     = new PublicKey(accepts.asset || SOL_USDC_MINT);
  const payTo    = new PublicKey(accepts.payTo);
  const amount   = BigInt(accepts.maxAmountRequired); // atomic, 6dp

  // Build partial tx (payer signs; facilitator/fp completes & broadcasts)
  const tx = await buildExactPaymentTx({
    connection: conn,
    payerPublicKey: payer.publicKey,
    feePayerPublicKey: feePayer,
    recipientPublicKey: payTo,
    mintPublicKey: mint,
    amountAtomic: amount,
    // will auto-create recipient ATA only if missing
    createRecipientATAIfMissing: true,
    // safe defaults inside lib: compute budgets, recent blockhash, etc.
  });

  tx.sign([payer]);
  const b64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');

  const x402 = {
    x402Version: 1,
    scheme: 'exact',
    network: 'solana',
    payload: { transaction: b64 }
  };
  const XPAYMENT = Buffer.from(JSON.stringify(x402)).toString('base64');

  const { status, json } = await httpPost(`${BASE_URL}/connect?duration_min=${accepts.extra?.minutes || 5}&network=sol`, {
    headers: { 'X-PAYMENT': XPAYMENT }
  });
  if (status !== 200) {
    const errorMsg = typeof json === 'string' ? json : JSON.stringify(json);
    throw new Error(`Payment failed (${status}): ${errorMsg}`);
  }
  return json; // { access_token, expires_at, payment... }
}

async function getExtendInvoice(minutes, token) {
  const { status, json } = await httpPost(`${BASE_URL}/extend?duration_min=${minutes}&network=sol`, {
    headers: { 'X-SESSION': token }
  });
  if (status !== 402) throw new Error(`Expected 402 for extend invoice, got ${status}: ${JSON.stringify(json)}`);
  const accepts = (json.accepts && json.accepts[0]) || json;
  return accepts;
}

async function extendSession(accepts, token, payer, conn) {
  // Try multiple sources for feePayer
  let feePayerStr = accepts?.extra?.feePayer || process.env.SOL_FEE_PAYER;
  
  if (!feePayerStr) {
    console.log('⚠️  feePayer not in invoice, fetching from facilitator...');
    feePayerStr = await fetchSupportedFeePayer();
  }
  
  if (!feePayerStr) {
    console.error('❌ Invoice response:', JSON.stringify(accepts, null, 2));
    throw new Error('Missing facilitator feePayer for Solana. Set SOL_FEE_PAYER env var or ensure facilitator /supported endpoint returns feePayer.');
  }
  
  console.log(`💸 Using feePayer: ${feePayerStr}`);
  const feePayer = new PublicKey(feePayerStr);

  const mint     = new PublicKey(accepts.asset || SOL_USDC_MINT);
  const payTo    = new PublicKey(accepts.payTo);
  const amount   = BigInt(accepts.maxAmountRequired);

  const tx = await buildExactPaymentTx({
    connection: conn,
    payerPublicKey: payer.publicKey,
    feePayerPublicKey: feePayer,
    recipientPublicKey: payTo,
    mintPublicKey: mint,
    amountAtomic: amount,
    createRecipientATAIfMissing: true,
  });

  tx.sign([payer]);
  const b64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');
  const x402 = {
    x402Version: 1,
    scheme: 'exact',
    network: 'solana',
    payload: { transaction: b64 }
  };
  const XPAYMENT = Buffer.from(JSON.stringify(x402)).toString('base64');

  const { status, json } = await httpPost(`${BASE_URL}/extend?duration_min=${accepts.extra?.minutes || 5}&network=sol`, {
    headers: { 'X-SESSION': token, 'X-PAYMENT': XPAYMENT }
  });
  if (status !== 200) {
    const errorMsg = typeof json === 'string' ? json : JSON.stringify(json);
    throw new Error(`Extend failed (${status}): ${errorMsg}`);
  }
  return json; // { access_token, expires_at, ... }
}

async function sendToDiscord(webhookUrl, message) {
  /**Send a news message to Discord webhook - handles both Twitter posts and news articles*/
  // Extract common fields
  const title = message.title || 'Bridge402 News';
  const timeMs = message.time;
  const url = message.url || message.link || '';
  
  // Determine message type: Twitter post (has 'body') or news article (has 'source')
  const isTwitter = 'body' in message;
  const isArticle = 'source' in message;
  
  // Format timestamp if available
  let timestamp = null;
  if (timeMs) {
    timestamp = new Date(timeMs).toISOString();
  }
  
  // Build description based on message type
  let description = '';
  if (isTwitter) {
    // Twitter/X post
    const body = message.body || '';
    description = body.length > 2000 ? body.substring(0, 2000) : body;
  } else if (isArticle) {
    // News article
    const enText = message.en || title;
    description = enText.length > 2000 ? enText.substring(0, 2000) : enText;
  }
  
  // Add link to description
  if (url) {
    description = description ? `${description}\n\n🔗 [View Original](${url})` : `🔗 [View Original](${url})`;
  }
  
  // Create Discord embed
  const embed = {
    title: title,
    description: description || null,
    color: 0x5e35b1, // Deep purple
    footer: { text: 'Bridge402 News Stream' },
    timestamp: timestamp
  };
  
  // Build fields based on message type
  const fields = [];
  
  if (isTwitter) {
    // Twitter-specific fields
    const coin = message.coin || '';
    if (coin) {
      fields.push({ name: 'Coin', value: coin, inline: true });
    }
    
    // Trading actions
    const actions = message.actions || [];
    if (actions.length > 0) {
      let actionText = actions.slice(0, 3).map(a => `• ${a.title || a.action || ''}`).join('\n');
      if (actions.length > 3) {
        actionText += `\n*+${actions.length - 3} more*`;
      }
      fields.push({ name: 'Trading Actions', value: actionText, inline: false });
    }
    
    // Add thumbnail (icon) and image
    const iconUrl = message.icon || '';
    const imageUrl = message.image || '';
    if (iconUrl) {
      embed.thumbnail = { url: iconUrl };
    }
    if (imageUrl) {
      embed.image = { url: imageUrl };
    }
  } else if (isArticle) {
    // News article fields
    const source = message.source || '';
    if (source) {
      fields.push({ name: 'Source', value: source, inline: true });
    }
    
    const symbols = message.symbols || [];
    if (symbols.length > 0) {
      let symbolsText = symbols.slice(0, 5).join(', ');
      if (symbols.length > 5) {
        symbolsText += ` +${symbols.length - 5} more`;
      }
      fields.push({ name: 'Symbols', value: symbolsText, inline: false });
    }
  }
  
  if (fields.length > 0) {
    embed.fields = fields;
  }
  
  const payload = {
    embeds: [embed]
  };
  
  try {
    const { status, json } = await httpPost(webhookUrl, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (status >= 200 && status < 300) {
      const msgType = isTwitter ? '🐦 Twitter' : isArticle ? '📰 Article' : '📨 News';
      console.log(`📤 Forwarded to Discord (${msgType}): ${title.substring(0, 50)}...`);
    } else {
      console.error(`❌ Discord webhook returned ${status}:`, json);
    }
  } catch (err) {
    console.error(`❌ Failed to send to Discord:`, err.message);
  }
}

(async () => {
  if (!DISCORD_WEBHOOK_URL) {
    console.error('\n❌ Error: DISCORD_WEBHOOK_URL environment variable is required');
    console.error('\nSet the Discord webhook URL:');
    console.error('  Windows:        set DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...');
    console.error('  PowerShell:     $env:DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."');
    console.error('  Linux/Mac:      export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."');
    console.error('\nTo get a webhook URL:');
    console.error('  1. Go to your Discord server settings');
    console.error('  2. Navigate to Integrations → Webhooks');
    console.error('  3. Create a new webhook');
    console.error('  4. Copy the webhook URL');
    console.error('');
    process.exit(1);
  }

  console.log(`\n🔗 BASE_URL: ${BASE_URL}`);
  console.log(`🔗 RPC:      ${SOLANA_RPC}`);
  console.log(`📱 Discord Webhook: ${DISCORD_WEBHOOK_URL.substring(0, 50)}...`);

  const conn = new Connection(SOLANA_RPC, 'confirmed');
  const payer = loadKeypair();

  // 1) Get invoice & pay for initial session
  let start;
  try {
    const invoice = await getInvoice(5);
    console.log('🧾 Invoice (sol):', invoice);

    start = await payInvoice(invoice, payer, conn);
    console.log('✅ Paid, token:', start.access_token, 'expires_at:', start.expires_at);
  } catch (e) {
    console.error('\n❌ Failed to create session:', e.message || e);
    if (e.message?.includes('Payment failed')) {
      console.error('\n   Possible causes:');
      console.error('   - Insufficient USDC balance');
      console.error('   - Network/RPC issues');
      console.error('   - Facilitator service unavailable');
      console.error('\n   Try again in a few moments.');
    }
    process.exit(1);
  }

  // 2) Connect websocket
  const wsUrl = BASE_URL.replace(/^http/, 'ws') + `/stream?token=${encodeURIComponent(start.access_token)}`;
  console.log('🔌 WS:', wsUrl);
  let currentToken = start.access_token;

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => console.log('WS open'));
  ws.on('close', (code, reason) => {
    console.log(`WS closed (code: ${code})`);
    if (reason) console.log(`   Reason: ${reason.toString()}`);
    console.log('   To reconnect, run the script again.');
  });
  ws.on('error', err => {
    console.error('⚠️  WS error:', err.message || err);
    console.error('   Connection may have been lost. Check network and try again.');
  });

  ws.on('message', async (data) => {
    const text = data.toString();
    try {
      const msg = JSON.parse(text);
      if (msg.type === 'expiry_soon') {
        console.log('⏳ expiry_soon:', msg.seconds_remaining, 's — extending…');

        // Retry extension with exponential backoff
        let retries = 3;
        let retryDelay = 1000; // Start with 1 second
        let extended = false;

        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            // 3) Request extend invoice, pay, and swap token
            const extInvoice = await getExtendInvoice(5, currentToken);
            const extPaid = await extendSession(extInvoice, currentToken, payer, conn);
            currentToken = extPaid.access_token;
            console.log('🔁 Extended. New expiry:', extPaid.expires_at);
            extended = true;
            break; // Success - exit retry loop
          } catch (e) {
            const isLastAttempt = attempt === retries;
            const isFacilitatorError = e.message?.includes('Facilitator') || e.message?.includes('521') || e.message?.includes('verify failed');
            
            if (isLastAttempt) {
              console.error(`⚠️  Extend failed after ${retries} attempts:`, e.message || e);
              console.error('   Session will expire. To continue, reconnect manually.');
            } else {
              console.warn(`⚠️  Extend attempt ${attempt}/${retries} failed:`, e.message || e);
              if (isFacilitatorError) {
                console.warn(`   Facilitator issue detected. Retrying in ${retryDelay / 1000}s...`);
              } else {
                console.warn(`   Retrying in ${retryDelay / 1000}s...`);
              }
              // Exponential backoff: 1s, 2s, 4s
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              retryDelay *= 2;
            }
          }
        }

        if (!extended) {
          console.error('   All retry attempts exhausted. Session extension failed.');
        }
      } else if (msg.type === 'session_extended') {
        console.log('ℹ️ server ack:', msg);
      } else if (msg.status === 'connected') {
        console.log('ℹ️ stream connected');
      } else {
        // News message - forward to Discord
        try {
          await sendToDiscord(DISCORD_WEBHOOK_URL, msg);
        } catch (e) {
          console.error('⚠️  Failed to forward message to Discord:', e.message || e);
          // Continue processing - don't crash on Discord failures
        }
      }
    } catch (parseError) {
      // non-JSON relays - might be raw news messages
      try {
        const parsed = JSON.parse(text);
        try {
          await sendToDiscord(DISCORD_WEBHOOK_URL, parsed);
        } catch (e) {
          console.error('⚠️  Failed to forward message to Discord:', e.message || e);
        }
      } catch {
        // Handle session expiry messages
        if (text.includes('Session expired') || text.includes('Renew')) {
          console.warn('⚠️  Session expired. WebSocket will close.');
          console.warn('   Reconnect by running the script again.');
        } else {
          console.log('📨 Raw (non-JSON):', text);
        }
      }
    }
  });
})();

