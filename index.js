import yahooFinance2 from 'yahoo-finance2';
import fetch from 'node-fetch';
import 'dotenv/config';

const yahooFinance = new yahooFinance2();

// ==========================================
// CONFIGURATION
// ==========================================
const TICKERS = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'META', 'AMZN'];
const POLLING_INTERVAL_MS = 5 * 60 * 1000; // Poll every 5 minutes
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// ==========================================
// MATH ENGINE
// ==========================================
function cumulativeNormalDistribution(x) {
    const p = 0.2316419, b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
    const absX = Math.abs(x), t = 1.0 / (1.0 + p * absX);
    const sigma = 1.0 - (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-absX * absX / 2.0) * (b1 * t + b2 * Math.pow(t, 2) + b3 * Math.pow(t, 3) + b4 * Math.pow(t, 4) + b5 * Math.pow(t, 5));
    return (x < 0) ? 1.0 - sigma : sigma;
}

function calculateOptionsPremium(S, K, t, r, v, type = 'call') {
    if (t <= 0) t = 0.00001; if (v <= 0) v = 0.00001;
    const d1 = (Math.log(S / K) + (r + (v * v) / 2.0) * t) / (v * Math.sqrt(t));
    const d2 = d1 - v * Math.sqrt(t);
    return type === 'call' 
        ? S * cumulativeNormalDistribution(d1) - K * Math.exp(-r * t) * cumulativeNormalDistribution(d2)
        : K * Math.exp(-r * t) * cumulativeNormalDistribution(-d2) - S * cumulativeNormalDistribution(-d1);
}

function calculateVega(S, K, t, r, v) {
    if (t <= 0) t = 0.00001; if (v <= 0) v = 0.00001;
    const d1 = (Math.log(S / K) + (r + (v * v) / 2.0) * t) / (v * Math.sqrt(t));
    return S * Math.sqrt(t) * (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-d1 * d1 / 2.0);
}

function findImpliedVolatility(marketPrice, S, K, t, r, type = 'call') {
    let v = 0.50; 
    for (let i = 0; i < 100; i++) {
        const calcPrice = calculateOptionsPremium(S, K, t, r, v, type);
        const diff = calcPrice - marketPrice;
        if (Math.abs(diff) < 0.0001) return v;
        const vega = calculateVega(S, K, t, r, v);
        if (Math.abs(vega) < 0.0001) break; 
        v = Math.max(0.00001, Math.min(5.0, v - (diff / vega)));
    }
    return v; 
}

// ==========================================
// NOTIFICATION HANDLER
// ==========================================
async function sendDiscordAlert(data) {
    if (!DISCORD_WEBHOOK_URL) return;
    const edgePercentage = ((data.trueIV - data.reportedIV) * 100).toFixed(2);
    
    const payload = {
        embeds: [{
            title: `🚨 ALPHA EDGE: ${data.ticker} @ $${data.stockPrice.toFixed(2)}`,
            color: 5763719,
            description: `**+${edgePercentage}% Volatility Edge Detected**`,
            fields: [
                { name: 'Target', value: `\`${data.ticker} $${data.strike}C\``, inline: true },
                { name: 'Expires', value: `${data.expiry} (\`${data.dte.toFixed(1)} Days\`)`, inline: true },
                { name: 'Midpoint', value: `$${data.marketMidpoint.toFixed(2)}`, inline: true },
                { name: 'Broker IV', value: `~~${(data.reportedIV * 100).toFixed(2)}%~~`, inline: true },
                { name: 'True IV', value: `**${(data.trueIV * 100).toFixed(2)}%**`, inline: true }
            ],
            footer: { text: 'Render Worker • Continuous Polling' },
            timestamp: new Date().toISOString()
        }]
    };

    try { 
        await fetch(DISCORD_WEBHOOK_URL, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        }); 
    } catch (e) { console.error('Discord error:', e); }
}

// ==========================================
// CONTINUOUS POLLING LOOP
// ==========================================
async function scanMarkets() {
    console.log(`[${new Date().toISOString()}] Initiating market scan...`);
    const now = new Date();

    for (const ticker of TICKERS) {
        try {
            const quote = await yahooFinance.quote(ticker);
            const S = quote.regularMarketPrice;
            
            if (!quote.earningsTimestamp) continue;
            const earningsDate = new Date(quote.earningsTimestamp * 1000);
            const daysToEarnings = (earningsDate - now) / (1000 * 60 * 60 * 24);
            if (daysToEarnings < 0 || daysToEarnings > 14) continue;

            const chain = await yahooFinance.options(ticker);
            if (!chain || !chain.expirationDates.length) continue;

            const nearestChain = await yahooFinance.options(ticker, { date: chain.expirationDates[0] });
            const targetOption = nearestChain.options[0].calls.find(opt => opt.strike > S);
            if (!targetOption) continue;
            
            const expiryDate = new Date(targetOption.expiration); 
            const dte = Math.max(0.5, (expiryDate - now) / (1000 * 60 * 60 * 24)); 
            const marketMidpoint = (targetOption.bid + targetOption.ask) / 2;
            const reportedIV = targetOption.impliedVolatility;
            const trueIV = findImpliedVolatility(marketMidpoint, S, targetOption.strike, dte / 365, 0.052, 'call');
            
            const edge = trueIV - reportedIV;
            const requiredEdge = dte <= 7 ? 0.10 : 0.05;

            if (edge >= requiredEdge) {
                const data = { ticker, stockPrice: S, strike: targetOption.strike, expiry: expiryDate.toISOString().split('T')[0], dte, marketMidpoint, reportedIV, trueIV };
                await sendDiscordAlert(data);
                console.log(`Alert fired for ${ticker}`);
            }
        } catch (error) {
            console.error(`Error scanning ${ticker}:`, error.message);
        }
        await new Promise(resolve => setTimeout(resolve, 2000)); // Respect API limits between tickers
    }
    console.log(`Scan complete. Sleeping for ${POLLING_INTERVAL_MS / 60000} minutes.`);
}

// Initialize the continuous loop
console.log("Starting IV Crush Background Worker...");
scanMarkets(); 
setInterval(scanMarkets, POLLING_INTERVAL_MS);