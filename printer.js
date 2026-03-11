/**
 * BSC Store — Local Printer App
 * ───────────────────────────────────────────────────────────────────
 * Run this on your SHOP COMPUTER (not Render).
 * It polls your server every 5 seconds for new orders and auto-prints them.
 *
 * SETUP:
 *   1. Install Node.js on your shop PC (nodejs.org)
 *   2. Save this file anywhere on your PC, e.g. Desktop/printer.js
 *   3. Edit STORE_URL and ADMIN_PASSWORD below
 *   4. Open terminal/cmd in that folder and run:
 *        node printer.js
 *   5. Keep this window open — it will auto-print every new order
 *
 * REQUIREMENTS:
 *   - Node.js 18+ (has built-in fetch)
 *   - Your printer must be set as DEFAULT PRINTER on this PC
 *   - Windows: uses Notepad /p or Chrome headless to print
 *   - Printing opens a browser window briefly, then auto-closes
 * ───────────────────────────────────────────────────────────────────
 */

// ── CONFIG — edit these ───────────────────────────────────────────
const STORE_URL      = 'https://your-app.onrender.com'; // your Render URL
const ADMIN_PASSWORD = 'admin123';                       // your admin password
const POLL_INTERVAL  = 5000;   // check every 5 seconds
const AUTO_PRINT     = true;   // set false to just show orders without printing
const STORE_NAME     = 'BSC Store';
// ─────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { exec } = require('child_process');

let adminToken = null;
let printedOrders = new Set();
const PRINTED_FILE = path.join(os.homedir(), '.bsc_printed_orders.json');

// Load already-printed order IDs from disk (survives restarts)
function loadPrinted() {
  try {
    if (fs.existsSync(PRINTED_FILE)) {
      const data = JSON.parse(fs.readFileSync(PRINTED_FILE, 'utf8'));
      data.forEach(id => printedOrders.add(id));
      console.log(`📋 Loaded ${printedOrders.size} already-printed order IDs`);
    }
  } catch (e) { console.warn('Could not load printed orders file:', e.message); }
}

function savePrinted() {
  try {
    fs.writeFileSync(PRINTED_FILE, JSON.stringify([...printedOrders]), 'utf8');
  } catch (e) {}
}

// Login to admin and get token
async function login() {
  try {
    const r = await fetch(`${STORE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Login failed');
    adminToken = d.token;
    console.log('✅ Logged in to BSC Store admin');
    return true;
  } catch (e) {
    console.error('❌ Login error:', e.message);
    return false;
  }
}

// Fetch today's pending orders
async function fetchNewOrders() {
  try {
    const r = await fetch(`${STORE_URL}/api/admin/orders?date=today&status=pending`, {
      headers: { 'Authorization': 'Bearer ' + adminToken }
    });
    if (r.status === 401) { adminToken = null; return []; } // token expired
    if (!r.ok) return [];
    return await r.json();
  } catch (e) {
    return [];
  }
}

// Generate receipt HTML for an order
function buildReceiptHTML(o) {
  const time = new Date(o.createdAt).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });

  const itemsRows = (o.items || []).map(i => {
    const lineTotal = (i.price * i.qty).toFixed(0);
    const name = i.name + (i.variant ? ` (${i.variant})` : '') + (i.isFreeGift ? ' [FREE]' : '');
    return `<tr>
      <td style="padding:2px 0;max-width:150px;word-break:break-word">${name}</td>
      <td style="text-align:center;padding:2px 4px">${i.qty}</td>
      <td style="text-align:right;padding:2px 0">Rs.${lineTotal}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Order #${o.id}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  @page { margin: 4mm; size: 80mm auto; }
  body {
    font-family: 'Courier New', Courier, monospace;
    font-size: 12px;
    width: 72mm;
    padding: 4px;
    color: #000;
  }
  .center  { text-align: center; }
  .bold    { font-weight: bold; }
  .big     { font-size: 16px; font-weight: bold; letter-spacing: 1px; }
  .divider { border: none; border-top: 1px dashed #000; margin: 5px 0; }
  table    { width: 100%; border-collapse: collapse; }
  th       { border-bottom: 1px solid #000; font-size: 11px; padding: 2px; }
  .total td { font-weight: bold; font-size: 14px; border-top: 1px dashed #000; padding-top:3px; }
  .footer  { margin-top: 6px; font-size: 10px; text-align: center; }
  .tag     { display:inline-block; border:1px solid #000; padding:1px 5px; border-radius:3px; font-size:10px; }
</style>
</head>
<body>
  <div class="center big">${STORE_NAME}</div>
  <div class="center" style="font-size:10px;margin-top:1px">Your Neighbourhood Store</div>
  <hr class="divider">

  <div><span class="bold">Order #${o.id}</span> &nbsp; <span class="tag">${(o.status||'NEW').toUpperCase()}</span></div>
  <div style="font-size:10px;color:#333;margin-top:1px">${time}</div>

  <hr class="divider">

  <div class="bold" style="font-size:13px">${o.customerName || 'Customer'}</div>
  <div>${o.phone || ''}</div>
  ${o.block || o.villa ? `<div>Block ${o.block || ''}${o.villa ? ' · Villa ' + o.villa : ''}</div>` : ''}
  ${o.note ? `<div style="margin-top:2px;font-style:italic">Note: ${o.note}</div>` : ''}

  <hr class="divider">

  <table>
    <thead>
      <tr>
        <th style="text-align:left">Item</th>
        <th>Qty</th>
        <th style="text-align:right">Amt</th>
      </tr>
    </thead>
    <tbody>${itemsRows}</tbody>
    <tfoot>
      <tr class="total">
        <td colspan="2">TOTAL</td>
        <td style="text-align:right">Rs.${o.total}</td>
      </tr>
    </tfoot>
  </table>

  <hr class="divider">
  <div>Payment: <span class="bold">${(o.paymentMethod || 'COD').toUpperCase()}</span></div>
  <hr class="divider">
  <div class="footer">Thank you for your order! 🛒</div>
  <div style="margin-top:10px"></div>
</body>
</html>`;
}

// Print using system browser (works on Windows, Mac, Linux)
function printReceipt(orderId, html) {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `bsc_order_${orderId}.html`);
    fs.writeFileSync(tmpFile, html, 'utf8');

    let cmd;
    if (process.platform === 'win32') {
      // Windows: open in Chrome headless for silent printing, fallback to start
      const chrome = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ].find(p => fs.existsSync(p));

      if (chrome) {
        cmd = `"${chrome}" --headless --disable-gpu --print-to-pdf-no-header --print-to-default-printer "${tmpFile}"`;
      } else {
        // Fallback: open in default browser (user clicks Ctrl+P)
        cmd = `start "" "${tmpFile}"`;
        console.log(`  ⚠️  Chrome not found — opening in browser. Press Ctrl+P to print manually.`);
      }
    } else if (process.platform === 'darwin') {
      // macOS: lpr (CUPS)
      cmd = `lpr -o media=Custom.80x297mm "${tmpFile}"`;
    } else {
      // Linux: lpr
      cmd = `lpr "${tmpFile}"`;
    }

    exec(cmd, (err) => {
      if (err) console.warn('  Print error:', err.message);
      // Clean up temp file after 30s
      setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 30000);
      resolve();
    });
  });
}

// Main polling loop
async function poll() {
  if (!adminToken) {
    const ok = await login();
    if (!ok) return;
  }

  const orders = await fetchNewOrders();

  for (const order of orders) {
    if (printedOrders.has(order.id)) continue; // already printed

    const time = new Date(order.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    console.log(`\n🆕 NEW ORDER #${order.id} — Rs.${order.total} — ${order.customerName} — ${time}`);
    console.log(`   Items: ${(order.items||[]).map(i=>i.name+' x'+i.qty).join(', ')}`);

    if (AUTO_PRINT) {
      console.log(`   🖨️  Printing...`);
      const html = buildReceiptHTML(order);
      await printReceipt(order.id, html);
      console.log(`   ✅ Sent to printer`);
    } else {
      console.log(`   ℹ️  AUTO_PRINT is off — set AUTO_PRINT=true to enable`);
    }

    printedOrders.add(order.id);
    savePrinted();
  }
}

// ── STARTUP ───────────────────────────────────────────────────────
loadPrinted();
console.log('');
console.log('╔══════════════════════════════════════╗');
console.log('║   BSC Store — Local Printer App      ║');
console.log('╚══════════════════════════════════════╝');
console.log(`🌐 Server : ${STORE_URL}`);
console.log(`🖨️  Auto-print: ${AUTO_PRINT ? 'ON' : 'OFF'}`);
console.log(`⏱️  Polling every ${POLL_INTERVAL/1000}s for new pending orders`);
console.log('');

// Poll immediately, then on interval
poll();
setInterval(poll, POLL_INTERVAL);
