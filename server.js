const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = 'bsc-store-v2-secret';
const DB = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  }
});

const readDB = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
const writeDB = d => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function adminAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(h.replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── MIGRATE: convert old priceTiers products to variant format ─────────────
function migrateProduct(p) {
  if (p.variants) return p; // already new format
  // Wrap old format into single variant
  const variant = {
    id: 'v1',
    label: p.unit || '1 unit',
    imageUrl: p.imageUrl || '',
    mrp: p.mrp || null,
    inStock: p.inStock !== false,
    priceTiers: p.priceTiers || [{ minQty: 1, price: 0 }]
  };
  return {
    id: p.id,
    name: p.name,
    catId: p.catId || 0,
    imageUrl: p.imageUrl || '',
    featured: p.featured || false,
    isNew: p.isNew || false,
    variants: [variant]
  };
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
app.get('/api/store', (req, res) => {
  const db = readDB();
  const fg = db.settings.freeGift || {};
  res.json({
    categories: db.categories,
    products: (db.products || []).map(migrateProduct),
    banners: db.banners,
    settings: {
      storeName: db.settings.storeName,
      minOrder: db.settings.minOrder,
      upiId: db.settings.upiId,
      whatsapp: db.settings.whatsapp,
      freeDeliveryMin: db.settings.freeDeliveryMin || db.settings.minOrder || 99,
      freeGiftMin: fg.threshold || db.settings.freeGiftMin || 0,
      freeGiftLabel: fg.label || db.settings.freeGiftLabel || '',
      upsellProductIds: db.settings.upsellProductIds || [],
      freeGift: {
        threshold:     fg.threshold || db.settings.freeGiftMin || 0,
        productId:     fg.productId || null,
        variantId:     fg.variantId || null,
        qty:           fg.qty || 1,
        autoAdd:       fg.autoAdd !== false,
        label:         fg.label || db.settings.freeGiftLabel || 'Free Gift',
        discountPrice: typeof fg.discountPrice === 'number' ? fg.discountPrice : 0,
      },
    }
  });
});

// ── ADMIN AUTH ────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const db = readDB();
  if (sha256(password) !== db.settings.adminPassword)
    return res.status(401).json({ error: 'Wrong password' });
  const token = jwt.sign({ admin: true }, SECRET, { expiresIn: '30d' });
  res.json({ token });
});
app.get('/api/admin/verify', adminAuth, (req, res) => res.json({ ok: true }));

// ── UPLOAD ────────────────────────────────────────────────────────────────────
app.post('/api/admin/upload', adminAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// ── CATEGORIES ────────────────────────────────────────────────────────────────
app.get('/api/admin/categories', adminAuth, (req, res) => res.json(readDB().categories));

app.post('/api/admin/categories', adminAuth, (req, res) => {
  const db = readDB();
  const cat = { id: db.nextCategoryId++, name: req.body.name || 'New Category', imageUrl: req.body.imageUrl || '' };
  db.categories.push(cat); writeDB(db); res.json(cat);
});
app.put('/api/admin/categories/:id', adminAuth, (req, res) => {
  const db = readDB();
  const idx = db.categories.findIndex(c => c.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.categories[idx] = { ...db.categories[idx], ...req.body }; writeDB(db); res.json(db.categories[idx]);
});
app.delete('/api/admin/categories/:id', adminAuth, (req, res) => {
  const db = readDB(); db.categories = db.categories.filter(c => c.id != req.params.id); writeDB(db); res.json({ ok: true });
});

// ── PRODUCTS (variant-aware) ───────────────────────────────────────────────────
app.get('/api/admin/products', adminAuth, (req, res) => {
  res.json((readDB().products || []).map(migrateProduct));
});

app.post('/api/admin/products', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.products) db.products = [];
  const p = {
    id: db.nextProductId++,
    name: req.body.name || 'New Product',
    catId: parseInt(req.body.catId) || 0,
    imageUrl: req.body.imageUrl || '',
    featured: req.body.featured || false,
    isNew: req.body.isNew || false,
    variants: req.body.variants || [{
      id: 'v1', label: '1 unit', imageUrl: '', mrp: null, inStock: true,
      priceTiers: [{ minQty: 1, price: 0 }]
    }]
  };
  db.products.push(p); writeDB(db); res.json(p);
});

app.put('/api/admin/products/:id', adminAuth, (req, res) => {
  const db = readDB();
  const idx = db.products.findIndex(p => p.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.products[idx] = { ...db.products[idx], ...req.body }; writeDB(db); res.json(db.products[idx]);
});

app.delete('/api/admin/products/:id', adminAuth, (req, res) => {
  const db = readDB(); db.products = db.products.filter(p => p.id != req.params.id); writeDB(db); res.json({ ok: true });
});

// ── BANNERS ───────────────────────────────────────────────────────────────────
app.get('/api/admin/banners', adminAuth, (req, res) => res.json(readDB().banners));

app.post('/api/admin/banners', adminAuth, (req, res) => {
  const db = readDB();
  const b = { id: db.nextBannerId++, imageUrl: req.body.imageUrl||'', title: req.body.title||'', subtitle: req.body.subtitle||'', bgColor: req.body.bgColor||'#1a1a2e', action: req.body.action||null };
  db.banners.push(b); writeDB(db); res.json(b);
});
app.put('/api/admin/banners/:id', adminAuth, (req, res) => {
  const db = readDB();
  const idx = db.banners.findIndex(b => b.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.banners[idx] = { ...db.banners[idx], ...req.body }; writeDB(db); res.json(db.banners[idx]);
});
app.delete('/api/admin/banners/:id', adminAuth, (req, res) => {
  const db = readDB(); db.banners = db.banners.filter(b => b.id != req.params.id); writeDB(db); res.json({ ok: true });
});

// ── ORDERS ────────────────────────────────────────────────────────────────────
app.get('/api/admin/orders', adminAuth, (req, res) => {
  const db = readDB();
  res.json((db.orders||[]).slice().sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)));
});
app.put('/api/admin/orders/:id', adminAuth, (req, res) => {
  const db = readDB();
  const idx = (db.orders||[]).findIndex(o => o.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.orders[idx] = { ...db.orders[idx], ...req.body }; writeDB(db); res.json(db.orders[idx]);
});

app.post('/api/orders', (req, res) => {
  const db = readDB();
  if (!db.orders) db.orders = [];
  if (!db.nextOrderId) db.nextOrderId = 1;
  const { customerName, phone, block, villa, note, items, total, freeGift, paymentMethod } = req.body;
  if (!customerName || !phone || !items?.length) return res.status(400).json({ error: 'Missing fields' });
  const order = {
    id: db.nextOrderId++, customerName, phone, block, villa: villa||'', note: note||'',
    items, total, freeGift: freeGift||null, paymentMethod: paymentMethod||'cod',
    status: 'pending', createdAt: new Date().toISOString()
  };
  db.orders.push(order); writeDB(db); res.json({ ok: true, order });
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/api/admin/settings', adminAuth, (req, res) => res.json(readDB().settings));

app.put('/api/admin/settings', adminAuth, (req, res) => {
  const db = readDB();
  const { newPassword, ...rest } = req.body;
  db.settings = { ...db.settings, ...rest };
  if (newPassword) db.settings.adminPassword = sha256(newPassword);
  writeDB(db); res.json({ ok: true });
});

// ── MILK ──────────────────────────────────────────────────────────────────────
app.get('/api/admin/milk/customers', adminAuth, (req, res) => res.json(readDB().milkCustomers||[]));
app.get('/api/admin/milk/logs', adminAuth, (req, res) => {
  const db = readDB(); const month = req.query.month || new Date().toISOString().slice(0,7);
  res.json({ logs: (db.milkLogs||[]).filter(l => l.month===month), settings: { milkPrice: db.settings.milkPrice||60 } });
});
app.get('/api/admin/milk/payments', adminAuth, (req, res) => {
  const db = readDB(); const month = req.query.month || new Date().toISOString().slice(0,7);
  res.json((db.milkPayments||[]).filter(p => p.month===month));
});
app.post('/api/admin/milk/logs', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.milkLogs) db.milkLogs = [];
  if (!db.nextMilkLogId) db.nextMilkLogId = 1;
  const { customerId, date, qty, price } = req.body;
  const month = date.slice(0,7);
  const existIdx = db.milkLogs.findIndex(l => l.customerId===parseInt(customerId) && l.date===date);
  if (existIdx >= 0) {
    if (!qty || parseFloat(qty)===0) { db.milkLogs.splice(existIdx,1); }
    else { db.milkLogs[existIdx] = { ...db.milkLogs[existIdx], qty: parseFloat(qty), price: parseFloat(price)||db.settings.milkPrice||60, markedAt: new Date().toISOString() }; }
  } else if (qty && parseFloat(qty) > 0) {
    db.milkLogs.push({ id: db.nextMilkLogId++, customerId: parseInt(customerId), date, month, qty: parseFloat(qty), price: parseFloat(price)||db.settings.milkPrice||60, markedAt: new Date().toISOString() });
  }
  writeDB(db); res.json({ ok: true });
});
app.post('/api/admin/milk/payment', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.milkPayments) db.milkPayments = [];
  const { customerId, month, amount, note } = req.body;
  db.milkPayments.push({ customerId: parseInt(customerId), month, amount: parseFloat(amount), note: note||'Manual', paidAt: new Date().toISOString() });
  writeDB(db); res.json({ ok: true });
});
app.put('/api/admin/milk/settings', adminAuth, (req, res) => {
  const db = readDB(); if (req.body.milkPrice) db.settings.milkPrice = parseFloat(req.body.milkPrice);
  writeDB(db); res.json({ ok: true });
});
app.post('/api/milk/register', (req, res) => {
  const db = readDB();
  if (!db.milkCustomers) db.milkCustomers = [];
  if (!db.nextMilkId) db.nextMilkId = 1;
  const { name, phone, address, defaultQty, password } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  if (db.milkCustomers.find(c => c.phone===phone)) return res.status(409).json({ error: 'Phone already registered' });
  const plainPwd = password || Math.floor(1000+Math.random()*9000).toString();
  const c = { id: db.nextMilkId++, name, phone, address: address||'', defaultQty: parseFloat(defaultQty)||0.5, password: sha256(plainPwd), plainPassword: plainPwd, active: true, joinedAt: new Date().toISOString() };
  db.milkCustomers.push(c); writeDB(db); res.json({ ok: true, password: plainPwd });
});
app.post('/api/milk/login', (req, res) => {
  const db = readDB();
  const { phone, password } = req.body;
  const c = (db.milkCustomers||[]).find(x => x.phone===phone);
  if (!c || sha256(password) !== c.password) return res.status(401).json({ error: 'Wrong credentials' });
  const token = jwt.sign({ cid: c.id, phone: c.phone }, SECRET, { expiresIn: '90d' });
  res.json({ token, customer: { id: c.id, name: c.name, phone: c.phone, address: c.address, defaultQty: c.defaultQty } });
});

function customerAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(h.replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

app.get('/api/customer/dashboard', customerAuth, (req, res) => {
  const db = readDB();
  const c = (db.milkCustomers||[]).find(x => x.id===req.user.cid);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const key = new Date().toISOString().slice(0,7);
  const log = (db.milkLogs||[]).filter(l => l.customerId===c.id && l.month===key);
  const pricePerLitre = db.settings.milkPrice||60;
  const totalLitres = log.reduce((s,l) => s+l.qty, 0);
  const milkAmt = log.reduce((s,l) => s+l.qty*(l.price||pricePerLitre), 0);
  const milkPaid = (db.milkPayments||[]).filter(p => p.customerId===c.id && p.month===key).reduce((s,p) => s+p.amount, 0);
  const orders = (db.orders||[]).filter(o => o.phone===c.phone).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).slice(0,30);
  const udharEntries = (db.udharEntries||[]).filter(e => e.customerId===c.id).sort((a,b) => b.date.localeCompare(a.date));
  const udharPayments = (db.udharPayments||[]).filter(p => p.customerId===c.id).sort((a,b) => b.paidAt.localeCompare(a.paidAt));
  const totalUdhar = udharEntries.reduce((s,e) => s+(e.amount||0), 0);
  const totalUdharPaid = udharPayments.reduce((s,p) => s+(p.amount||0), 0);
  const { password, plainPassword, ...safeCustomer } = c;
  res.json({ customer: safeCustomer, log, totalLitres, milkAmt, milkPaid, pricePerLitre, month: key, orders, udharEntries, udharPayments, totalUdhar, totalUdharPaid, udharBalance: totalUdhar-totalUdharPaid });
});

// ── UDHAR ─────────────────────────────────────────────────────────────────────
function getUdharSummary(db, customerId) {
  const entries = (db.udharEntries||[]).filter(e => e.customerId===customerId);
  const payments = (db.udharPayments||[]).filter(p => p.customerId===customerId);
  return { totalUdhar: entries.reduce((s,e)=>s+(e.amount||0),0), totalPaid: payments.reduce((s,p)=>s+(p.amount||0),0), balance: entries.reduce((s,e)=>s+(e.amount||0),0)-payments.reduce((s,p)=>s+(p.amount||0),0), entries, payments };
}
app.get('/api/admin/udhar', adminAuth, (req, res) => {
  const db = readDB(); const cid = req.query.customerId ? parseInt(req.query.customerId) : null;
  res.json((db.udharEntries||[]).filter(e => !cid||e.customerId===cid));
});
app.post('/api/admin/udhar', adminAuth, (req, res) => {
  const db = readDB(); if (!db.udharEntries) db.udharEntries=[]; if (!db.nextUdharId) db.nextUdharId=1;
  const { customerId, items, amount, date, note, type } = req.body;
  if (!customerId||!amount) return res.status(400).json({ error: 'customerId and amount required' });
  const entry = { id: db.nextUdharId++, customerId: parseInt(customerId), items: items||[], amount: parseFloat(amount), date: date||new Date().toISOString().slice(0,10), note: note||'', type: type||'purchase', createdAt: new Date().toISOString() };
  db.udharEntries.push(entry); writeDB(db); res.json({ ok:true, entry });
});
app.put('/api/admin/udhar/:id', adminAuth, (req, res) => {
  const db = readDB(); const idx = (db.udharEntries||[]).findIndex(e=>e.id==req.params.id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  db.udharEntries[idx]={...db.udharEntries[idx],...req.body,customerId:db.udharEntries[idx].customerId}; writeDB(db); res.json({ok:true});
});
app.delete('/api/admin/udhar/:id', adminAuth, (req, res) => {
  const db = readDB(); db.udharEntries=(db.udharEntries||[]).filter(e=>e.id!=req.params.id); writeDB(db); res.json({ok:true});
});
app.get('/api/admin/udhar-payments', adminAuth, (req, res) => {
  const db = readDB(); const cid = req.query.customerId ? parseInt(req.query.customerId) : null;
  res.json((db.udharPayments||[]).filter(p=>!cid||p.customerId===cid));
});
app.post('/api/admin/udhar-payments', adminAuth, (req, res) => {
  const db = readDB(); if (!db.udharPayments) db.udharPayments=[]; if (!db.nextUdharPayId) db.nextUdharPayId=1;
  const { customerId, amount, method, note } = req.body;
  if (!customerId||!amount) return res.status(400).json({ error:'customerId and amount required' });
  const pay = { id: db.nextUdharPayId++, customerId: parseInt(customerId), amount: parseFloat(amount), method: method||'cash', note: note||'', paidAt: new Date().toISOString(), date: new Date().toISOString().slice(0,10) };
  db.udharPayments.push(pay); writeDB(db); res.json({ok:true,pay});
});
app.delete('/api/admin/udhar-payments/:id', adminAuth, (req, res) => {
  const db = readDB(); db.udharPayments=(db.udharPayments||[]).filter(p=>p.id!=req.params.id); writeDB(db); res.json({ok:true});
});
app.get('/api/admin/udhar-summary', adminAuth, (req, res) => {
  const db = readDB();
  res.json((db.milkCustomers||[]).map(c => ({ customer:{id:c.id,name:c.name,phone:c.phone,address:c.address}, ...getUdharSummary(db,c.id) })));
});

// ── LEDGER / CALENDAR API ─────────────────────────────────────────────────────
// Returns unified ledger entries for a customer across a given month
// Each entry: { date, type:'milk'|'order'|'udhar'|'payment'|'udhar_payment', source, description, amount, debit, credit, time, note, id }
app.get('/api/customer/ledger', customerAuth, (req, res) => {
  const db = readDB();
  const cid = req.user.cid;
  const c = (db.milkCustomers || []).find(x => x.id === cid);
  if (!c) return res.status(404).json({ error: 'Not found' });

  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const entries = [];

  // Milk deliveries
  (db.milkLogs || []).filter(l => l.customerId === cid && l.month === month).forEach(l => {
    entries.push({
      id: 'milk_' + l.id,
      date: l.date,
      type: 'milk',
      source: 'SUBSCRIPTION',
      description: `Milk delivery — ${l.qty}L`,
      amount: parseFloat((l.qty * (l.price || db.settings.milkPrice || 60)).toFixed(2)),
      debit: true,
      time: l.markedAt,
      note: ''
    });
  });

  // Milk payments
  (db.milkPayments || []).filter(p => p.customerId === cid && p.month === month).forEach(p => {
    const dateStr = p.paidAt ? p.paidAt.slice(0, 10) : month + '-01';
    entries.push({
      id: 'milkpay_' + dateStr + '_' + p.amount,
      date: dateStr,
      type: 'payment',
      source: 'PAYMENT',
      description: `Milk payment — ${p.note || 'Cash'}`,
      amount: parseFloat(p.amount),
      debit: false,
      time: p.paidAt,
      note: p.note || ''
    });
  });

  // App orders
  (db.orders || []).filter(o => o.phone === c.phone && o.createdAt && o.createdAt.slice(0, 7) === month && o.status !== 'cancelled').forEach(o => {
    entries.push({
      id: 'order_' + o.id,
      date: o.createdAt.slice(0, 10),
      type: 'order',
      source: 'APP',
      description: `App order #${o.id} — ${(o.items || []).slice(0, 2).map(i => i.name).join(', ')}${(o.items || []).length > 2 ? ` +${o.items.length - 2} more` : ''}`,
      amount: parseFloat(o.total),
      debit: true,
      time: o.createdAt,
      note: o.note || '',
      orderId: o.id,
      orderStatus: o.status
    });
  });

  // Udhar entries
  (db.udharEntries || []).filter(e => e.customerId === cid && e.date && e.date.slice(0, 7) === month).forEach(e => {
    entries.push({
      id: 'udhar_' + e.id,
      date: e.date,
      type: 'udhar',
      source: 'STORE',
      description: (e.items || []).length ? (e.items.slice(0, 2).map(i => i.name).join(', ') + ((e.items.length > 2) ? ` +${e.items.length - 2} more` : '')) : (e.note || 'Store purchase'),
      amount: parseFloat(e.amount),
      debit: true,
      time: e.createdAt,
      note: e.note || ''
    });
  });

  // Udhar payments
  (db.udharPayments || []).filter(p => p.customerId === cid && p.date && p.date.slice(0, 7) === month).forEach(p => {
    entries.push({
      id: 'udpay_' + p.id,
      date: p.date,
      type: 'udhar_payment',
      source: 'PAYMENT',
      description: `Payment received — ${p.method || 'Cash'}`,
      amount: parseFloat(p.amount),
      debit: false,
      time: p.paidAt,
      note: p.note || ''
    });
  });

  // Sort by date then time
  entries.sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    return (a.time || '').localeCompare(b.time || '');
  });

  // Monthly summary
  const milkTotal = entries.filter(e => e.type === 'milk').reduce((s, e) => s + e.amount, 0);
  const orderTotal = entries.filter(e => e.type === 'order').reduce((s, e) => s + e.amount, 0);
  const udharTotal = entries.filter(e => e.type === 'udhar').reduce((s, e) => s + e.amount, 0);
  const paymentsTotal = entries.filter(e => e.type === 'payment' || e.type === 'udhar_payment').reduce((s, e) => s + e.amount, 0);
  const totalDebits = milkTotal + orderTotal + udharTotal;
  const outstanding = totalDebits - paymentsTotal;

  res.json({
    month,
    entries,
    summary: { milkTotal, orderTotal, udharTotal, paymentsTotal, totalDebits, outstanding }
  });
});

// Get all months with activity for a customer
app.get('/api/customer/ledger/months', customerAuth, (req, res) => {
  const db = readDB();
  const cid = req.user.cid;
  const c = (db.milkCustomers || []).find(x => x.id === cid);
  if (!c) return res.status(404).json({ error: 'Not found' });

  const monthSet = new Set();
  (db.milkLogs || []).filter(l => l.customerId === cid).forEach(l => monthSet.add(l.month));
  (db.milkPayments || []).filter(p => p.customerId === cid && p.paidAt).forEach(p => monthSet.add(p.paidAt.slice(0, 7)));
  (db.orders || []).filter(o => o.phone === c.phone && o.createdAt).forEach(o => monthSet.add(o.createdAt.slice(0, 7)));
  (db.udharEntries || []).filter(e => e.customerId === cid && e.date).forEach(e => monthSet.add(e.date.slice(0, 7)));
  (db.udharPayments || []).filter(p => p.customerId === cid && p.date).forEach(p => monthSet.add(p.date.slice(0, 7)));

  // Always include current month
  monthSet.add(new Date().toISOString().slice(0, 7));

  const months = [...monthSet].sort().reverse();
  res.json({ months });
});

// ── SERVE PAGES ───────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ BSC Store running at http://localhost:${PORT}`);
  console.log(`🔧 Admin panel: http://localhost:${PORT}/admin`);
});
