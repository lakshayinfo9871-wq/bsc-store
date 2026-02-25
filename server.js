const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const SECRET = 'bsc-store-v2-secret';
const DB = path.join(__dirname, 'data', 'db.json');

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── FILE UPLOAD ───────────────────────────────────────────────────────────────
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

// ── DB HELPERS ────────────────────────────────────────────────────────────────
const readDB = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
const writeDB = d => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try {
    jwt.verify(h.replace('Bearer ', ''), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC API (customer app reads these)
// ══════════════════════════════════════════════════════════════════════════════

// Everything the customer app needs in one call
app.get('/api/store', (req, res) => {
  const db = readDB();
  const fg = db.settings.freeGift || {};
  res.json({
    categories: db.categories,
    products: db.products,
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
        qty:           fg.qty || 1,
        autoAdd:       fg.autoAdd !== false,
        label:         fg.label || db.settings.freeGiftLabel || 'Free Gift',
        discountPrice: typeof fg.discountPrice === 'number' ? fg.discountPrice : 0,
      },
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN AUTH
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const db = readDB();
  if (sha256(password) !== db.settings.adminPassword) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = jwt.sign({ admin: true }, SECRET, { expiresIn: '30d' });
  res.json({ token });
});

// Verify token (used by admin panel on load)
app.get('/api/admin/verify', adminAuth, (req, res) => res.json({ ok: true }));

// ══════════════════════════════════════════════════════════════════════════════
// UPLOAD
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/upload', adminAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// ══════════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/categories', adminAuth, (req, res) => {
  res.json(readDB().categories);
});

app.post('/api/admin/categories', adminAuth, (req, res) => {
  const db = readDB();
  const cat = {
    id: db.nextCategoryId++,
    name: req.body.name || 'New Category',
    imageUrl: req.body.imageUrl || '',
  };
  db.categories.push(cat);
  writeDB(db);
  res.json(cat);
});

app.put('/api/admin/categories/:id', adminAuth, (req, res) => {
  const db = readDB();
  const idx = db.categories.findIndex(c => c.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.categories[idx] = { ...db.categories[idx], ...req.body };
  writeDB(db);
  res.json(db.categories[idx]);
});

app.delete('/api/admin/categories/:id', adminAuth, (req, res) => {
  const db = readDB();
  db.categories = db.categories.filter(c => c.id != req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCTS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/products', adminAuth, (req, res) => {
  res.json(readDB().products);
});

app.post('/api/admin/products', adminAuth, (req, res) => {
  const db = readDB();
  const p = {
    id: db.nextProductId++,
    name: req.body.name || 'New Product',
    unit: req.body.unit || '',
    catId: parseInt(req.body.catId) || 0,
    imageUrl: req.body.imageUrl || '',
    inStock: req.body.inStock !== false,
    featured: req.body.featured || false,
    isNew: req.body.isNew || false,
    // priceTiers: [{minQty, price}, ...]  sorted by minQty ascending
    priceTiers: req.body.priceTiers || [{ minQty: 1, price: 0 }],
  };
  db.products.push(p);
  writeDB(db);
  res.json(p);
});

app.put('/api/admin/products/:id', adminAuth, (req, res) => {
  const db = readDB();
  const idx = db.products.findIndex(p => p.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.products[idx] = { ...db.products[idx], ...req.body };
  writeDB(db);
  res.json(db.products[idx]);
});

app.delete('/api/admin/products/:id', adminAuth, (req, res) => {
  const db = readDB();
  db.products = db.products.filter(p => p.id != req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// BANNERS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/banners', adminAuth, (req, res) => {
  res.json(readDB().banners);
});

app.post('/api/admin/banners', adminAuth, (req, res) => {
  const db = readDB();
  const b = {
    id: db.nextBannerId++,
    imageUrl: req.body.imageUrl || '',
    title: req.body.title || '',
    subtitle: req.body.subtitle || '',
    bgColor: req.body.bgColor || '#1a1a2e',
    // Action: { type: 'category'|'products', catId, productIds: [] }
    action: req.body.action || null,
  };
  db.banners.push(b);
  writeDB(db);
  res.json(b);
});

app.put('/api/admin/banners/:id', adminAuth, (req, res) => {
  const db = readDB();
  const idx = db.banners.findIndex(b => b.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.banners[idx] = { ...db.banners[idx], ...req.body };
  writeDB(db);
  res.json(db.banners[idx]);
});

app.delete('/api/admin/banners/:id', adminAuth, (req, res) => {
  const db = readDB();
  db.banners = db.banners.filter(b => b.id != req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════
// ORDERS (ADMIN)
// ═════════════════════════════════════════════════════════════

// Get all orders
app.get('/api/admin/orders', adminAuth, (req, res) => {
  const db = readDB();
  res.json(db.orders || []);
});

// Update order status
app.put('/api/admin/orders/:id', adminAuth, (req, res) => {
  const db = readDB();
  const idx = db.orders.findIndex(o => o.id == req.params.id);

  if (idx === -1)
    return res.status(404).json({ error: 'Order not found' });

  db.orders[idx].status = req.body.status || db.orders[idx].status;

  writeDB(db);
  res.json(db.orders[idx]);
});

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/settings', adminAuth, (req, res) => {
  const s = readDB().settings;
  const fg = s.freeGift || {};
  res.json({
    storeName: s.storeName,
    whatsapp: s.whatsapp,
    upiId: s.upiId,
    minOrder: s.minOrder,
    freeDeliveryMin: s.freeDeliveryMin || s.minOrder || 99,
    freeGiftMin: fg.threshold || s.freeGiftMin || 0,
    freeGiftLabel: fg.label || s.freeGiftLabel || '',
    upsellProductIds: s.upsellProductIds || [],
    freeGift: {
      threshold:     fg.threshold || s.freeGiftMin || 0,
      productId:     fg.productId || null,
      qty:           fg.qty || 1,
      autoAdd:       fg.autoAdd !== false,
      label:         fg.label || s.freeGiftLabel || '',
      discountPrice: typeof fg.discountPrice === 'number' ? fg.discountPrice : 0,
    },
  });
});

app.put('/api/admin/settings', adminAuth, (req, res) => {
  const db = readDB();
  const { storeName, whatsapp, upiId, minOrder, newPassword,
          freeDeliveryMin, freeGiftMin, freeGiftLabel, upsellProductIds, freeGift } = req.body;
  if (storeName !== undefined) db.settings.storeName = storeName;
  if (whatsapp !== undefined) db.settings.whatsapp = whatsapp;
  if (upiId !== undefined) db.settings.upiId = upiId;
  if (minOrder !== undefined) db.settings.minOrder = parseInt(minOrder) || 99;
  if (freeDeliveryMin !== undefined) db.settings.freeDeliveryMin = parseInt(freeDeliveryMin) || 0;
  if (freeGiftMin !== undefined) db.settings.freeGiftMin = parseInt(freeGiftMin) || 0;
  if (freeGiftLabel !== undefined) db.settings.freeGiftLabel = freeGiftLabel;
  if (upsellProductIds !== undefined) db.settings.upsellProductIds = upsellProductIds;
  if (freeGift !== undefined) {
    db.settings.freeGift = {
      threshold:     parseInt(freeGift.threshold) || 0,
      productId:     freeGift.productId ? parseInt(freeGift.productId) : null,
      qty:           parseInt(freeGift.qty) || 1,
      autoAdd:       freeGift.autoAdd !== false,
      label:         freeGift.label || '',
      discountPrice: parseFloat(freeGift.discountPrice) || 0,
    };
    // keep legacy fields in sync
    db.settings.freeGiftMin   = db.settings.freeGift.threshold;
    db.settings.freeGiftLabel = db.settings.freeGift.label;
  }
  if (newPassword) db.settings.adminPassword = sha256(newPassword);
  writeDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// MILK SUBSCRIPTIONS
// ══════════════════════════════════════════════════════════════════════════════

// Admin: list all customers
app.get('/api/admin/milk/customers', adminAuth, (req, res) => {
  const db = readDB();
  res.json(db.milkCustomers || []);
});

// Admin: update customer
app.put('/api/admin/milk/customers/:id', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.milkCustomers) return res.status(404).json({ error: 'Not found' });
  const idx = db.milkCustomers.findIndex(c => c.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.milkCustomers[idx] = { ...db.milkCustomers[idx], ...req.body };
  writeDB(db);
  res.json(db.milkCustomers[idx]);
});

// Admin: delete customer
app.delete('/api/admin/milk/customers/:id', adminAuth, (req, res) => {
  const db = readDB();
  db.milkCustomers = (db.milkCustomers || []).filter(c => c.id != req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// Admin: get logs for a month (default current)
app.get('/api/admin/milk/logs', adminAuth, (req, res) => {
  const db = readDB();
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const logs = (db.milkLogs || []).filter(l => l.month === month);
  res.json({ logs, customers: db.milkCustomers || [], settings: { milkPrice: db.settings.milkPrice || 60 } });
});

// Admin: add/update a delivery entry for a day
app.post('/api/admin/milk/logs', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.milkLogs) db.milkLogs = [];
  if (!db.nextMilkLogId) db.nextMilkLogId = 1;
  const { customerId, date, qty, price } = req.body; // date = "YYYY-MM-DD"
  const month = date.slice(0, 7);
  // Upsert: if same customer+date exists, update it
  const existing = db.milkLogs.findIndex(l => l.customerId == customerId && l.date === date);
  if (existing >= 0) {
    if (qty <= 0) { db.milkLogs.splice(existing, 1); }
    else { db.milkLogs[existing] = { ...db.milkLogs[existing], qty, price }; }
  } else if (qty > 0) {
    db.milkLogs.push({ id: db.nextMilkLogId++, customerId: parseInt(customerId), date, month, qty: parseFloat(qty), price: parseFloat(price) || db.settings.milkPrice || 60, markedAt: new Date().toISOString() });
  }
  writeDB(db);
  res.json({ ok: true });
});

// Admin: mark all active customers for a day (bulk)
app.post('/api/admin/milk/bulk-mark', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.milkLogs) db.milkLogs = [];
  if (!db.nextMilkLogId) db.nextMilkLogId = 1;
  const { date } = req.body;
  const month = date.slice(0, 7);
  const price = db.settings.milkPrice || 60;
  const customers = (db.milkCustomers || []).filter(c => c.active && c.defaultQty > 0);
  customers.forEach(c => {
    const exists = db.milkLogs.findIndex(l => l.customerId === c.id && l.date === date);
    if (exists < 0) {
      db.milkLogs.push({ id: db.nextMilkLogId++, customerId: c.id, date, month, qty: c.defaultQty, price, markedAt: new Date().toISOString() });
    }
  });
  writeDB(db);
  res.json({ ok: true, marked: customers.length });
});

// Admin: milk settings (price per litre)
app.put('/api/admin/milk/settings', adminAuth, (req, res) => {
  const db = readDB();
  if (req.body.milkPrice) db.settings.milkPrice = parseFloat(req.body.milkPrice);
  writeDB(db);
  res.json({ ok: true });
});

// Admin: mark payment received
app.post('/api/admin/milk/payment', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.milkPayments) db.milkPayments = [];
  const { customerId, month, amount, note } = req.body;
  db.milkPayments.push({ customerId: parseInt(customerId), month, amount: parseFloat(amount), note: note || '', paidAt: new Date().toISOString() });
  writeDB(db);
  res.json({ ok: true });
});

// Admin: get payments
app.get('/api/admin/milk/payments', adminAuth, (req, res) => {
  const db = readDB();
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  res.json((db.milkPayments || []).filter(p => p.month === month));
});

// ══════════════════════════════════════════════════════════════════════════════
// ORDERS (basic — Phase 3 will expand this)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/orders', (req, res) => {
  const db = readDB();
  const order = {
    id: db.nextOrderId++,
    ...req.body,
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  db.orders.push(order);
  writeDB(db);
  res.json({ ok: true, orderId: order.id });
});


// Register milk customer WITH PASSWORD
app.post('/api/customer/register', (req, res) => {
  const db = readDB();
  if (!db.milkCustomers) db.milkCustomers = [];
  if (!db.nextMilkId) db.nextMilkId = 1;

  const { name, phone, address, defaultQty, password } = req.body;

  if (!name || !phone || !password)
    return res.status(400).json({ error: 'Name, phone and password required' });

  if (db.milkCustomers.find(x => x.phone === phone))
    return res.status(409).json({ error: 'Phone already registered' });

  const c = {
    id: db.nextMilkId++,
    name,
    phone,
    address: address || '',
    defaultQty: parseFloat(defaultQty) || 0,   // 0 = no milk subscription
    password: sha256(password),
    plainPassword: password,   // admin can see this
    active: true,
    joinedAt: new Date().toISOString()
  };

  db.milkCustomers.push(c);
  writeDB(db);
  res.json({ ok: true });
});

// Customer login
app.post('/api/customer/login', (req, res) => {
  const { phone, password } = req.body;
  const db = readDB();

  const c = (db.milkCustomers || []).find(x => x.phone === phone);

  if (!c || c.password !== sha256(password))
    return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ cid: c.id }, SECRET, { expiresIn: '30d' });

  res.json({
    token,
    customer: { id: c.id, name: c.name, phone: c.phone }
  });
});

function customerAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });

  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/api/customer/dashboard', customerAuth, (req, res) => {
  const db = readDB();
  const c = (db.milkCustomers || []).find(x => x.id === req.user.cid);
  if (!c) return res.status(404).json({ error: 'Not found' });

  const key = new Date().toISOString().slice(0, 7);
  const log = (db.milkLogs || []).filter(l => l.customerId === c.id && l.month === key);
  const pricePerLitre = db.settings.milkPrice || 60;
  const totalLitres = log.reduce((s, l) => s + l.qty, 0);
  const milkAmt = log.reduce((s, l) => s + l.qty * (l.price || pricePerLitre), 0);

  // Milk payments this month
  const milkPaid = (db.milkPayments || [])
    .filter(p => p.customerId === c.id && p.month === key)
    .reduce((s, p) => s + p.amount, 0);

  // App orders matching phone
  const orders = (db.orders || []).filter(o => o.phone === c.phone)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 30);

  // Udhar (credit) system
  const udharEntries = (db.udharEntries || [])
    .filter(e => e.customerId === c.id)
    .sort((a, b) => b.date.localeCompare(a.date));
  const udharPayments = (db.udharPayments || [])
    .filter(p => p.customerId === c.id)
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const totalUdhar = udharEntries.reduce((s, e) => s + (e.amount || 0), 0);
  const totalUdharPaid = udharPayments.reduce((s, p) => s + (p.amount || 0), 0);
  const udharBalance = totalUdhar - totalUdharPaid;

  const { password, plainPassword, ...safeCustomer } = c;
  res.json({
    customer: safeCustomer,
    // Milk
    log, totalLitres, milkAmt, milkPaid, pricePerLitre, month: key,
    // App orders
    orders,
    // Udhar
    udharEntries, udharPayments, totalUdhar, totalUdharPaid, udharBalance
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// UDHAR (CREDIT) SYSTEM
// ══════════════════════════════════════════════════════════════════════════════

// Helper: compute udhar summary for a customer
function getUdharSummary(db, customerId) {
  const entries = (db.udharEntries || []).filter(e => e.customerId === customerId);
  const payments = (db.udharPayments || []).filter(p => p.customerId === customerId);
  const totalUdhar = entries.reduce((s, e) => s + (e.amount || 0), 0);
  const totalPaid  = payments.reduce((s, p) => s + (p.amount || 0), 0);
  return { totalUdhar, totalPaid, balance: totalUdhar - totalPaid, entries, payments };
}

// Admin: get all udhar entries (optionally filter by customer)
app.get('/api/admin/udhar', adminAuth, (req, res) => {
  const db = readDB();
  const cid = req.query.customerId ? parseInt(req.query.customerId) : null;
  const entries = (db.udharEntries || []).filter(e => !cid || e.customerId === cid);
  res.json(entries);
});

// Admin: add udhar entry (offline purchase / manual credit)
app.post('/api/admin/udhar', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.udharEntries) db.udharEntries = [];
  if (!db.nextUdharId) db.nextUdharId = 1;
  const { customerId, items, amount, date, note, type } = req.body;
  if (!customerId || !amount) return res.status(400).json({ error: 'customerId and amount required' });
  const entry = {
    id: db.nextUdharId++,
    customerId: parseInt(customerId),
    items: items || [],          // [{name, qty, price}]
    amount: parseFloat(amount),
    date: date || new Date().toISOString().slice(0, 10),
    note: note || '',
    type: type || 'purchase',    // 'purchase' | 'adjustment'
    createdAt: new Date().toISOString()
  };
  db.udharEntries.push(entry);
  writeDB(db);
  res.json({ ok: true, entry });
});

// Admin: edit udhar entry
app.put('/api/admin/udhar/:id', adminAuth, (req, res) => {
  const db = readDB();
  const idx = (db.udharEntries || []).findIndex(e => e.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.udharEntries[idx] = { ...db.udharEntries[idx], ...req.body, customerId: db.udharEntries[idx].customerId };
  writeDB(db);
  res.json({ ok: true });
});

// Admin: delete udhar entry
app.delete('/api/admin/udhar/:id', adminAuth, (req, res) => {
  const db = readDB();
  db.udharEntries = (db.udharEntries || []).filter(e => e.id != req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// Admin: get all payments
app.get('/api/admin/udhar-payments', adminAuth, (req, res) => {
  const db = readDB();
  const cid = req.query.customerId ? parseInt(req.query.customerId) : null;
  res.json((db.udharPayments || []).filter(p => !cid || p.customerId === cid));
});

// Admin: record payment
app.post('/api/admin/udhar-payments', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.udharPayments) db.udharPayments = [];
  if (!db.nextUdharPayId) db.nextUdharPayId = 1;
  const { customerId, amount, method, note } = req.body;
  if (!customerId || !amount) return res.status(400).json({ error: 'customerId and amount required' });
  const pay = {
    id: db.nextUdharPayId++,
    customerId: parseInt(customerId),
    amount: parseFloat(amount),
    method: method || 'cash',
    note: note || '',
    paidAt: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10)
  };
  db.udharPayments.push(pay);
  writeDB(db);
  res.json({ ok: true, pay });
});

// Admin: delete payment (correction)
app.delete('/api/admin/udhar-payments/:id', adminAuth, (req, res) => {
  const db = readDB();
  db.udharPayments = (db.udharPayments || []).filter(p => p.id != req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// Admin: full summary for all customers (for overview page)
app.get('/api/admin/udhar-summary', adminAuth, (req, res) => {
  const db = readDB();
  const summaries = (db.milkCustomers || []).map(c => ({
    customer: { id: c.id, name: c.name, phone: c.phone, address: c.address },
    ...getUdharSummary(db, c.id)
  }));
  res.json(summaries);
});

// ── ADMIN: Legacy grocery entries (kept for backwards compat) ────────────────
app.get('/api/admin/grocery-entries', adminAuth, (req, res) => {
  const db = readDB();
  const customerId = req.query.customerId ? parseInt(req.query.customerId) : null;
  const entries = (db.groceryEntries || []).filter(g => !customerId || g.customerId === customerId);
  res.json(entries);
});

app.post('/api/admin/grocery-entries', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.groceryEntries) db.groceryEntries = [];
  if (!db.nextGroceryId) db.nextGroceryId = 1;
  const { customerId, name, qty, price, amount, date, note } = req.body;
  if (!customerId || !name) return res.status(400).json({ error: 'customerId and name required' });
  const entry = {
    id: db.nextGroceryId++,
    customerId: parseInt(customerId),
    name, qty: parseFloat(qty) || 1, price: parseFloat(price) || 0,
    amount: parseFloat(amount) || parseFloat(price) || 0,
    date: date || new Date().toISOString().slice(0, 10),
    note: note || '', createdAt: new Date().toISOString()
  };
  db.groceryEntries.push(entry);
  writeDB(db);
  res.json({ ok: true, entry });
});

app.put('/api/admin/grocery-entries/:id', adminAuth, (req, res) => {
  const db = readDB();
  const idx = (db.groceryEntries || []).findIndex(g => g.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.groceryEntries[idx] = { ...db.groceryEntries[idx], ...req.body };
  writeDB(db);
  res.json({ ok: true });
});

app.delete('/api/admin/grocery-entries/:id', adminAuth, (req, res) => {
  const db = readDB();
  db.groceryEntries = (db.groceryEntries || []).filter(g => g.id != req.params.id);
  writeDB(db);
  res.json({ ok: true });
});


// ══════════════════════════════════════════════════════════════════════════════
// SERVE PAGES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ BSC Store running at http://localhost:${PORT}`);
  console.log(`🔧 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`🔑 Default password: admin123\n`);
});


