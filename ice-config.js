/**
 * ice-config.js — Add this route to your Express server
 *
 * In your server.js add:
 *   const iceConfig = require('./ice-config');
 *   app.use('/api/ice-config', iceConfig);
 */

const express = require('express');
const router = express.Router();

// Cache for 5 minutes — TURN credentials expire in 24h
let cachedConfig = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

router.get('/', async (req, res) => {
  try {
    if (cachedConfig && Date.now() - cacheTime < CACHE_TTL) {
      return res.json(cachedConfig);
    }
    const config = await getICEConfig();
    cachedConfig = config;
    cacheTime = Date.now();
    res.json(config);
  } catch (err) {
    console.error('[ICE] Error:', err.message);
    res.json(getSTUNOnlyFallback());
  }
});

async function getICEConfig() {
  // Your Metered credentials from environment variables
  const apiKey = process.env.METERED_API_KEY;
  const appName = process.env.METERED_APP_NAME || 'this';

  if (!apiKey) {
    console.warn('[ICE] No METERED_API_KEY env var set — using fallback');
    return getSTUNOnlyFallback();
  }

  try {
    const response = await fetch(
      `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`
    );
    if (response.ok) {
      const iceServers = await response.json();
      console.log('[ICE] Fetched', iceServers.length, 'TURN servers from Metered');
      return { iceServers };
    }
    console.warn('[ICE] Metered API returned', response.status, '— using fallback');
  } catch (err) {
    console.warn('[ICE] Metered fetch failed:', err.message, '— using fallback');
  }

  return getSTUNOnlyFallback();
}

function getSTUNOnlyFallback() {
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  };
}

module.exports = router;
