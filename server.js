const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = 'bsc-store-v2-secret';
const MONGO_URI = process.env.MONGO_URI;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── MONGODB SETUP ─────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('bscstore');
  console.log('✅ Connected to MongoDB');

  // Seed default settings if not present
  const settings = await db.collection('settings').findOne({ _id: 'main' });
  if (!settings) {
    await db.collection('settings').insertOne({
      _id: 'main',
      adminPassword: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
      whatsapp: '',
      upiId: '',
      minOrder: 99,
      storeName: 'BSC Store',
      milkPrice: 60,
      freeDeliveryMin: 99,
      freeGiftMin: 100,
      freeGiftLabel: 'chips',
      upsellProductIds: [3, 2, 4],
      freeGift: {
        threshold: 100,
        productId: 3,
        qty: 1,
        autoAdd: false,
        label: 'chips',
        discountPrice: 5
      }
    });
    console.log('📦 Default settings seeded');
  }
}

// ── MULTER (image uploads) ────────────────────────────────────────────────────
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

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function getNextId(name) {
  const res = await db.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return res.seq;
}

function migrateProduct(p) {
  if (p.variants) return p;
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

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(h.replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function customerAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(h.replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
app.get('/api/store', async (req, res) => {
  try {
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const categories = await db.collection('categories').find().toArray();
    const products = await db.collection('products').find().toArray();
    const banners = await db.collection('banners').find().toArray();
    const fg = settings.freeGift || {};
    res.json({
      categories,
      products: products.map(migrateProduct),
      banners,
      settings: {
        storeName: settings.storeName,
        minOrder: settings.minOrder,
        upiId: settings.upiId,
        whatsapp: settings.whatsapp,
        freeDeliveryMin: settings.freeDeliveryMin || settings.minOrder || 99,
        freeGiftMin: fg.threshold || settings.freeGiftMin || 0,
        freeGiftLabel: fg.label || settings.freeGiftLabel || '',
        upsellProductIds: settings.upsellProductIds || [],
        freeGift: {
          threshold:     fg.threshold || settings.freeGiftMin || 0,
          productId:     fg.productId || null,
          variantId:     fg.variantId || null,
          qty:           fg.qty || 1,
          autoAdd:       fg.autoAdd !== false,
          label:         fg.label || settings.freeGiftLabel || 'Free Gift',
          discountPrice: typeof fg.discountPrice === 'number' ? fg.discountPrice : 0,
        },
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN AUTH ────────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    if (sha256(password) !== settings.adminPassword)
      return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ admin: true }, SECRET, { expiresIn: '30d' });
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/verify', adminAuth, (req, res) => res.json({ ok: true }));

// ── UPLOAD ────────────────────────────────────────────────────────────────────
app.post('/api/admin/upload', adminAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// ── CATEGORIES ────────────────────────────────────────────────────────────────
app.get('/api/admin/categories', adminAuth, async (req, res) => {
  try { res.json(await db.collection('categories').find().toArray()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/categories', adminAuth, async (req, res) => {
  try {
    const id = await getNextId('categoryId');
    const cat = { id, name: req.body.name || 'New Category', imageUrl: req.body.imageUrl || '' };
    await db.collection('categories').insertOne(cat);
    res.json(cat);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await db.collection('categories').findOneAndUpdate(
      { id }, { $set: req.body }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('categories').deleteOne({ id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────────
app.get('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const products = await db.collection('products').find().toArray();
    res.json(products.map(migrateProduct));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const id = await getNextId('productId');
    const p = {
      id,
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
    await db.collection('products').insertOne(p);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await db.collection('products').findOneAndUpdate(
      { id }, { $set: req.body }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('products').deleteOne({ id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BANNERS ───────────────────────────────────────────────────────────────────
app.get('/api/admin/banners', adminAuth, async (req, res) => {
  try { res.json(await db.collection('banners').find().toArray()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/banners', adminAuth, async (req, res) => {
  try {
    const id = await getNextId('bannerId');
    const b = { id, imageUrl: req.body.imageUrl||'', title: req.body.title||'', subtitle: req.body.subtitle||'', bgColor: req.body.bgColor||'#1a1a2e', action: req.body.action||null };
    await db.collection('banners').insertOne(b);
    res.json(b);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await db.collection('banners').findOneAndUpdate(
      { id }, { $set: req.body }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('banners').deleteOne({ id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ORDERS ────────────────────────────────────────────────────────────────────
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const orders = await db.collection('orders').find().sort({ createdAt: -1 }).toArray();
    res.json(orders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await db.collection('orders').findOneAndUpdate(
      { id }, { $set: req.body }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, phone, block, villa, note, items, total, freeGift, paymentMethod } = req.body;
    if (!customerName || !phone || !items?.length) return res.status(400).json({ error: 'Missing fields' });
    const id = await getNextId('orderId');
    const order = {
      id, customerName, phone, block, villa: villa||'', note: note||'',
      items, total, freeGift: freeGift||null, paymentMethod: paymentMethod||'cod',
      status: 'pending', createdAt: new Date().toISOString()
    };

    if (paymentMethod === 'account' && phone) {
      const customer = await db.collection('milkCustomers').findOne({ phone });
      if (customer) {
        const udharId = await getNextId('udharId');
        const udharItems = (items || []).filter(i => !i.isFreeGift).map(i => ({
          name: i.name + (i.variant ? ' (' + i.variant + ')' : ''),
          qty: i.qty,
          price: i.price
        }));
        await db.collection('udharEntries').insertOne({
          id: udharId,
          customerId: customer.id,
          items: udharItems,
          amount: parseFloat(total),
          date: new Date().toISOString().slice(0, 10),
          note: 'App Order #' + id,
          type: 'app_order',
          orderId: id,
          createdAt: new Date().toISOString()
        });
        order.addedToAccount = true;
        order.customerId = customer.id;
      }
    }

    await db.collection('orders').insertOne(order);
    res.json({ ok: true, order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try { res.json(await db.collection('settings').findOne({ _id: 'main' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const { newPassword, ...rest } = req.body;
    const update = { ...rest };
    if (newPassword) update.adminPassword = sha256(newPassword);
    await db.collection('settings').updateOne({ _id: 'main' }, { $set: update });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MILK ──────────────────────────────────────────────────────────────────────
app.get('/api/admin/milk/customers', adminAuth, async (req, res) => {
  try { res.json(await db.collection('milkCustomers').find().toArray()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/milk/logs', adminAuth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const logs = await db.collection('milkLogs').find({ month }).toArray();
    res.json({ logs, settings: { milkPrice: settings.milkPrice || 60 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/milk/payments', adminAuth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    res.json(await db.collection('milkPayments').find({ month }).toArray());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/milk/logs', adminAuth, async (req, res) => {
  try {
    const { customerId, date, qty, price } = req.body;
    const month = date.slice(0, 7);
    const cid = parseInt(customerId);
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const existing = await db.collection('milkLogs').findOne({ customerId: cid, date });

    if (existing) {
      if (!qty || parseFloat(qty) === 0) {
        await db.collection('milkLogs').deleteOne({ customerId: cid, date });
      } else {
        await db.collection('milkLogs').updateOne(
          { customerId: cid, date },
          { $set: { qty: parseFloat(qty), price: parseFloat(price) || settings.milkPrice || 60, markedAt: new Date().toISOString() } }
        );
      }
    } else if (qty && parseFloat(qty) > 0) {
      const id = await getNextId('milkLogId');
      await db.collection('milkLogs').insertOne({
        id, customerId: cid, date, month,
        qty: parseFloat(qty),
        price: parseFloat(price) || settings.milkPrice || 60,
        markedAt: new Date().toISOString()
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/milk/payment', adminAuth, async (req, res) => {
  try {
    const { customerId, month, amount, note } = req.body;
    await db.collection('milkPayments').insertOne({
      customerId: parseInt(customerId), month,
      amount: parseFloat(amount), note: note || 'Manual',
      paidAt: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/milk/settings', adminAuth, async (req, res) => {
  try {
    if (req.body.milkPrice)
      await db.collection('settings').updateOne({ _id: 'main' }, { $set: { milkPrice: parseFloat(req.body.milkPrice) } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/milk/register', async (req, res) => {
  try {
    const { name, phone, address, defaultQty, pin } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
    if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: '4-digit PIN required' });
    const exists = await db.collection('milkCustomers').findOne({ phone });
    if (exists) return res.status(409).json({ error: 'Phone already registered' });
    const id = await getNextId('milkCustomerId');
    const c = {
      id, name, phone, address: address || '',
      defaultQty: parseFloat(defaultQty) || 0,
      pin,
      password: sha256(pin),
      plainPassword: pin,
      active: true, joinedAt: new Date().toISOString()
    };
    await db.collection('milkCustomers').insertOne(c);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/milk/login', async (req, res) => {
  try {
    const { phone, password, pin } = req.body;
    const c = await db.collection('milkCustomers').findOne({ phone });
    const attempt = pin || password;
    if (!c || sha256(attempt) !== c.password) return res.status(401).json({ error: 'Wrong phone or PIN' });
    const token = jwt.sign({ cid: c.id, phone: c.phone }, SECRET, { expiresIn: '90d' });
    res.json({ token, customer: { id: c.id, name: c.name, phone: c.phone, address: c.address, defaultQty: c.defaultQty } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CUSTOMER DASHBOARD ────────────────────────────────────────────────────────
app.get('/api/customer/dashboard', customerAuth, async (req, res) => {
  try {
    const c = await db.collection('milkCustomers').findOne({ id: req.user.cid });
    if (!c) return res.status(404).json({ error: 'Not found' });
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const key = new Date().toISOString().slice(0, 7);
    const log = await db.collection('milkLogs').find({ customerId: c.id, month: key }).toArray();
    const pricePerLitre = settings.milkPrice || 60;
    const totalLitres = log.reduce((s, l) => s + l.qty, 0);
    const milkAmt = log.reduce((s, l) => s + l.qty * (l.price || pricePerLitre), 0);
    const milkPayments = await db.collection('milkPayments').find({ customerId: c.id, month: key }).toArray();
    const milkPaid = milkPayments.reduce((s, p) => s + p.amount, 0);
    const orders = await db.collection('orders').find({ phone: c.phone }).sort({ createdAt: -1 }).limit(30).toArray();
    const udharEntries = await db.collection('udharEntries').find({ customerId: c.id }).sort({ date: -1 }).toArray();
    const udharPayments = await db.collection('udharPayments').find({ customerId: c.id }).sort({ paidAt: -1 }).toArray();
    const totalUdhar = udharEntries.reduce((s, e) => s + (e.amount || 0), 0);
    const totalUdharPaid = udharPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const { password, plainPassword, ...safeCustomer } = c;
    res.json({ customer: safeCustomer, log, totalLitres, milkAmt, milkPaid, pricePerLitre, month: key, orders, udharEntries, udharPayments, totalUdhar, totalUdharPaid, udharBalance: totalUdhar - totalUdharPaid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UDHAR ─────────────────────────────────────────────────────────────────────
async function getUdharSummary(customerId) {
  const entries = await db.collection('udharEntries').find({ customerId }).toArray();
  const payments = await db.collection('udharPayments').find({ customerId }).toArray();
  const totalUdhar = entries.reduce((s, e) => s + (e.amount || 0), 0);
  const totalPaid = payments.reduce((s, p) => s + (p.amount || 0), 0);
  return { totalUdhar, totalPaid, balance: totalUdhar - totalPaid, entries, payments };
}

app.get('/api/admin/udhar', adminAuth, async (req, res) => {
  try {
    const cid = req.query.customerId ? parseInt(req.query.customerId) : null;
    const query = cid ? { customerId: cid } : {};
    res.json(await db.collection('udharEntries').find(query).toArray());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/udhar', adminAuth, async (req, res) => {
  try {
    const { customerId, items, amount, date, note, type } = req.body;
    if (!customerId || !amount) return res.status(400).json({ error: 'customerId and amount required' });
    const id = await getNextId('udharId');
    const entry = {
      id, customerId: parseInt(customerId), items: items || [],
      amount: parseFloat(amount), date: date || new Date().toISOString().slice(0, 10),
      note: note || '', type: type || 'purchase', createdAt: new Date().toISOString()
    };
    await db.collection('udharEntries').insertOne(entry);
    res.json({ ok: true, entry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/udhar/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await db.collection('udharEntries').findOne({ id });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { customerId, ...rest } = req.body; // don't allow changing customerId
    await db.collection('udharEntries').updateOne({ id }, { $set: rest });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/udhar/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('udharEntries').deleteOne({ id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/udhar-payments', adminAuth, async (req, res) => {
  try {
    const cid = req.query.customerId ? parseInt(req.query.customerId) : null;
    const query = cid ? { customerId: cid } : {};
    res.json(await db.collection('udharPayments').find(query).toArray());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/udhar-payments', adminAuth, async (req, res) => {
  try {
    const { customerId, amount, method, note } = req.body;
    if (!customerId || !amount) return res.status(400).json({ error: 'customerId and amount required' });
    const id = await getNextId('udharPayId');
    const pay = {
      id, customerId: parseInt(customerId), amount: parseFloat(amount),
      method: method || 'cash', note: note || '',
      paidAt: new Date().toISOString(), date: new Date().toISOString().slice(0, 10)
    };
    await db.collection('udharPayments').insertOne(pay);
    res.json({ ok: true, pay });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/udhar-payments/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('udharPayments').deleteOne({ id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/udhar-summary', adminAuth, async (req, res) => {
  try {
    const customers = await db.collection('milkCustomers').find().toArray();
    const summaries = await Promise.all(customers.map(async c => ({
      customer: { id: c.id, name: c.name, phone: c.phone, address: c.address },
      ...(await getUdharSummary(c.id))
    })));
    res.json(summaries);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LEDGER ────────────────────────────────────────────────────────────────────
app.get('/api/customer/ledger', customerAuth, async (req, res) => {
  try {
    const cid = req.user.cid;
    const c = await db.collection('milkCustomers').findOne({ id: cid });
    if (!c) return res.status(404).json({ error: 'Not found' });
    const settings = await db.collection('settings').findOne({ _id: 'main' });
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const entries = [];

    const milkLogs = await db.collection('milkLogs').find({ customerId: cid, month }).toArray();
    milkLogs.forEach(l => entries.push({
      id: 'milk_' + l.id, date: l.date, type: 'milk', source: 'SUBSCRIPTION',
      description: `Milk delivery — ${l.qty}L`,
      amount: parseFloat((l.qty * (l.price || settings.milkPrice || 60)).toFixed(2)),
      debit: true, time: l.markedAt, note: ''
    }));

    const milkPayments = await db.collection('milkPayments').find({ customerId: cid, month }).toArray();
    milkPayments.forEach(p => {
      const dateStr = p.paidAt ? p.paidAt.slice(0, 10) : month + '-01';
      entries.push({
        id: 'milkpay_' + dateStr + '_' + p.amount, date: dateStr, type: 'payment', source: 'PAYMENT',
        description: `Milk payment — ${p.note || 'Cash'}`,
        amount: parseFloat(p.amount), debit: false, time: p.paidAt, note: p.note || ''
      });
    });

    const orders = await db.collection('orders').find({ phone: c.phone, status: { $ne: 'cancelled' } }).toArray();
    orders.filter(o => o.createdAt && o.createdAt.slice(0, 7) === month).forEach(o => {
      entries.push({
        id: 'order_' + o.id, date: o.createdAt.slice(0, 10), type: 'order', source: 'APP',
        description: `App order #${o.id} — ${(o.items || []).slice(0, 2).map(i => i.name).join(', ')}${(o.items || []).length > 2 ? ` +${o.items.length - 2} more` : ''}`,
        amount: parseFloat(o.total), debit: true, time: o.createdAt, note: o.note || '',
        orderId: o.id, orderStatus: o.status
      });
    });

    const udharEntries = await db.collection('udharEntries').find({ customerId: cid }).toArray();
    udharEntries.filter(e => e.date && e.date.slice(0, 7) === month).forEach(e => {
      entries.push({
        id: 'udhar_' + e.id, date: e.date, type: 'udhar', source: 'STORE',
        description: (e.items || []).length ? (e.items.slice(0, 2).map(i => i.name).join(', ') + ((e.items.length > 2) ? ` +${e.items.length - 2} more` : '')) : (e.note || 'Store purchase'),
        amount: parseFloat(e.amount), debit: true, time: e.createdAt, note: e.note || ''
      });
    });

    const udharPayments = await db.collection('udharPayments').find({ customerId: cid }).toArray();
    udharPayments.filter(p => p.date && p.date.slice(0, 7) === month).forEach(p => {
      entries.push({
        id: 'udpay_' + p.id, date: p.date, type: 'udhar_payment', source: 'PAYMENT',
        description: `Payment received — ${p.method || 'Cash'}`,
        amount: parseFloat(p.amount), debit: false, time: p.paidAt, note: p.note || ''
      });
    });

    entries.sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      if (d !== 0) return d;
      return (a.time || '').localeCompare(b.time || '');
    });

    const milkTotal = entries.filter(e => e.type === 'milk').reduce((s, e) => s + e.amount, 0);
    const orderTotal = entries.filter(e => e.type === 'order').reduce((s, e) => s + e.amount, 0);
    const udharTotal = entries.filter(e => e.type === 'udhar').reduce((s, e) => s + e.amount, 0);
    const paymentsTotal = entries.filter(e => e.type === 'payment' || e.type === 'udhar_payment').reduce((s, e) => s + e.amount, 0);
    const totalDebits = milkTotal + orderTotal + udharTotal;
    const outstanding = totalDebits - paymentsTotal;

    res.json({ month, entries, summary: { milkTotal, orderTotal, udharTotal, paymentsTotal, totalDebits, outstanding } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customer/ledger/months', customerAuth, async (req, res) => {
  try {
    const cid = req.user.cid;
    const c = await db.collection('milkCustomers').findOne({ id: cid });
    if (!c) return res.status(404).json({ error: 'Not found' });

    const monthSet = new Set();
    monthSet.add(new Date().toISOString().slice(0, 7));

    const [milkLogs, milkPayments, orders, udharEntries, udharPayments] = await Promise.all([
      db.collection('milkLogs').find({ customerId: cid }).toArray(),
      db.collection('milkPayments').find({ customerId: cid }).toArray(),
      db.collection('orders').find({ phone: c.phone }).toArray(),
      db.collection('udharEntries').find({ customerId: cid }).toArray(),
      db.collection('udharPayments').find({ customerId: cid }).toArray(),
    ]);

    milkLogs.forEach(l => monthSet.add(l.month));
    milkPayments.filter(p => p.paidAt).forEach(p => monthSet.add(p.paidAt.slice(0, 7)));
    orders.filter(o => o.createdAt).forEach(o => monthSet.add(o.createdAt.slice(0, 7)));
    udharEntries.filter(e => e.date).forEach(e => monthSet.add(e.date.slice(0, 7)));
    udharPayments.filter(p => p.date).forEach(p => monthSet.add(p.date.slice(0, 7)));

    res.json({ months: [...monthSet].sort().reverse() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SERVE PAGES ───────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ BSC Store running at http://localhost:${PORT}`);
    console.log(`🔧 Admin panel: http://localhost:${PORT}/admin`);
  });
}).catch(err => {
  console.error('❌ Failed to connect to MongoDB:', err);
  process.exit(1);
});
