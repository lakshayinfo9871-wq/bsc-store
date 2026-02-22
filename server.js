const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'bsc-store-secret-2024';
const DB_FILE = path.join(__dirname, 'db.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    const defaults = {
      settings: {
        storeName: 'BSC Store',
        whatsapp: '',
        qrUrl: '',
        adminPassword: hashPass('admin123'),
        minOrder: 99,
        deliveryRadiusKm: 1,
        storeLat: 28.6139,
        storeLng: 77.2090,
        bulkDiscounts: [
          { minItems: 3, discountPct: 5, label: '5% off on 3+ items' },
          { minItems: 5, discountPct: 10, label: '10% off on 5+ items' },
          { minItems: 10, discountPct: 15, label: '15% off on 10+ items' },
        ]
      },
      categories: [
        { id: 'grocery', name: 'Groceries', emoji: '🧂', order: 1 },
        { id: 'vegetables', name: 'Vegetables', emoji: '🥦', order: 2 },
        { id: 'fruits', name: 'Fruits', emoji: '🍎', order: 3 },
        { id: 'dairy', name: 'Dairy', emoji: '🥛', order: 4 },
        { id: 'drinks', name: 'Cold Drinks', emoji: '🥤', order: 5 },
        { id: 'snacks', name: 'Snacks', emoji: '🍿', order: 6 },
        { id: 'cleaning', name: 'Cleaning', emoji: '🧹', order: 7 },
      ],
      products: [
        // bulkTiers: array of {minQty, pricePerUnit} — admin sets per-product bulk pricing
        // e.g. [{minQty:1,pricePerUnit:10},{minQty:5,pricePerUnit:9},{minQty:10,pricePerUnit:8}]
        { id: 1, name: 'Basmati Rice', emoji: '🍚', price: 80, discountPrice: null, unit: '1 kg', cat: 'grocery', inStock: true, stock: 50, featured: true, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:80},{minQty:3,pricePerUnit:75},{minQty:5,pricePerUnit:70}] },
        { id: 2, name: 'Wheat Flour (Atta)', emoji: '🌾', price: 55, discountPrice: null, unit: '1 kg', cat: 'grocery', inStock: true, stock: 30, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 3, name: 'Toor Dal', emoji: '🫘', price: 120, discountPrice: null, unit: '500 g', cat: 'grocery', inStock: true, stock: 20, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 4, name: 'Mustard Oil', emoji: '🫙', price: 150, discountPrice: null, unit: '1 L', cat: 'grocery', inStock: true, stock: 15, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 5, name: 'Sugar', emoji: '🍬', price: 45, discountPrice: null, unit: '1 kg', cat: 'grocery', inStock: true, stock: 40, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 6, name: 'Salt', emoji: '🧂', price: 20, discountPrice: null, unit: '1 kg', cat: 'grocery', inStock: true, stock: 60, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 7, name: 'Tomatoes', emoji: '🍅', price: 30, discountPrice: null, unit: '500 g', cat: 'vegetables', inStock: true, stock: 25, featured: true, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:30},{minQty:4,pricePerUnit:27}] },
        { id: 8, name: 'Onions', emoji: '🧅', price: 25, discountPrice: null, unit: '500 g', cat: 'vegetables', inStock: true, stock: 35, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 9, name: 'Potatoes', emoji: '🥔', price: 30, discountPrice: null, unit: '1 kg', cat: 'vegetables', inStock: true, stock: 40, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 10, name: 'Spinach', emoji: '🥬', price: 20, discountPrice: null, unit: '1 bunch', cat: 'vegetables', inStock: true, stock: 15, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 11, name: 'Capsicum', emoji: '🫑', price: 40, discountPrice: null, unit: '250 g', cat: 'vegetables', inStock: true, stock: 10, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 12, name: 'Cauliflower', emoji: '🥦', price: 35, discountPrice: null, unit: '1 pc', cat: 'vegetables', inStock: true, stock: 8, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 13, name: 'Bananas', emoji: '🍌', price: 40, discountPrice: null, unit: '1 dozen', cat: 'fruits', inStock: true, stock: 20, featured: true, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:40},{minQty:3,pricePerUnit:35},{minQty:6,pricePerUnit:30}] },
        { id: 14, name: 'Apples', emoji: '🍎', price: 120, discountPrice: null, unit: '1 kg', cat: 'fruits', inStock: true, stock: 18, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 15, name: 'Oranges', emoji: '🍊', price: 80, discountPrice: null, unit: '1 kg', cat: 'fruits', inStock: true, stock: 22, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 16, name: 'Grapes', emoji: '🍇', price: 90, discountPrice: null, unit: '500 g', cat: 'fruits', inStock: true, stock: 12, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 17, name: 'Full Cream Milk', emoji: '🥛', price: 60, discountPrice: null, unit: '1 L', cat: 'dairy', inStock: true, stock: 30, featured: true, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:60},{minQty:5,pricePerUnit:55},{minQty:10,pricePerUnit:50}] },
        { id: 18, name: 'Paneer', emoji: '🧀', price: 80, discountPrice: null, unit: '200 g', cat: 'dairy', inStock: true, stock: 15, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 19, name: 'Curd (Dahi)', emoji: '🥣', price: 40, discountPrice: null, unit: '400 g', cat: 'dairy', inStock: true, stock: 20, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 20, name: 'Butter', emoji: '🧈', price: 55, discountPrice: null, unit: '100 g', cat: 'dairy', inStock: true, stock: 10, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 21, name: 'Coca-Cola', emoji: '🥤', price: 40, discountPrice: null, unit: '750 ml', cat: 'drinks', inStock: true, stock: 24, featured: false, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:40},{minQty:4,pricePerUnit:36}] },
        { id: 22, name: 'Pepsi', emoji: '🥤', price: 40, discountPrice: null, unit: '750 ml', cat: 'drinks', inStock: true, stock: 24, featured: false, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:40},{minQty:4,pricePerUnit:36}] },
        { id: 23, name: 'Sprite', emoji: '🥤', price: 40, discountPrice: null, unit: '750 ml', cat: 'drinks', inStock: true, stock: 18, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 24, name: 'Mineral Water', emoji: '💧', price: 20, discountPrice: null, unit: '1 L', cat: 'drinks', inStock: true, stock: 50, featured: false, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:20},{minQty:6,pricePerUnit:18},{minQty:12,pricePerUnit:15}] },
        { id: 25, name: 'Frooti', emoji: '🧃', price: 15, discountPrice: null, unit: '200 ml', cat: 'drinks', inStock: true, stock: 36, featured: false, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:15},{minQty:6,pricePerUnit:13}] },
        { id: 26, name: 'Lays Chips', emoji: '🍟', price: 20, discountPrice: null, unit: '1 pack', cat: 'snacks', inStock: true, stock: 30, featured: false, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:20},{minQty:5,pricePerUnit:18}] },
        { id: 27, name: 'Kurkure', emoji: '🍿', price: 20, discountPrice: null, unit: '1 pack', cat: 'snacks', inStock: true, stock: 28, featured: false, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:20},{minQty:5,pricePerUnit:18}] },
        { id: 28, name: 'Parle-G Biscuits', emoji: '🍪', price: 10, discountPrice: null, unit: '100 g', cat: 'snacks', inStock: true, stock: 40, featured: false, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:10},{minQty:5,pricePerUnit:9},{minQty:10,pricePerUnit:8}] },
        { id: 29, name: 'Maggi Noodles', emoji: '🍜', price: 14, discountPrice: null, unit: '1 pack', cat: 'snacks', inStock: true, stock: 35, featured: false, imageUrl: '', bulkTiers: [{minQty:1,pricePerUnit:14},{minQty:5,pricePerUnit:12}] },
        { id: 30, name: 'Surf Excel', emoji: '🧺', price: 60, discountPrice: null, unit: '500 g', cat: 'cleaning', inStock: true, stock: 12, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 31, name: 'Vim Dish Soap', emoji: '🧴', price: 35, discountPrice: null, unit: '200 g', cat: 'cleaning', inStock: true, stock: 15, featured: false, imageUrl: '', bulkTiers: [] },
        { id: 32, name: 'Phenyl', emoji: '🪣', price: 80, discountPrice: null, unit: '1 L', cat: 'cleaning', inStock: true, stock: 8, featured: false, imageUrl: '', bulkTiers: [] },
      ],
      customers: [],
      orders: [],
      nextId: 33,
      nextCustomerId: 1
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(defaults, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function hashPass(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function customerAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.customerId) return res.status(401).json({ error: 'Not a customer token' });
    req.customerId = decoded.customerId;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── Public API ───────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const db = readDB();
  const { search, cat, featured } = req.query;
  let products = db.products;
  if (search) products = products.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  if (cat && cat !== 'all') products = products.filter(p => p.cat === cat);
  if (featured === '1') products = products.filter(p => p.featured);
  res.json({
    products, categories: db.categories,
    settings: {
      storeName: db.settings.storeName, qrUrl: db.settings.qrUrl,
      whatsapp: db.settings.whatsapp, minOrder: db.settings.minOrder || 99,
      bulkDiscounts: db.settings.bulkDiscounts || [],
      deliveryRadiusKm: db.settings.deliveryRadiusKm || 1
    }
  });
});

app.post('/api/orders', (req, res) => {
  const db = readDB();
  const { name, phone, block, villa, items, total, discountAmt, finalTotal, customerId } = req.body;
  if (!name || !phone || !block || !villa || !items) return res.status(400).json({ error: 'Missing fields' });
  const minOrder = db.settings.minOrder || 99;
  if ((finalTotal || total) < minOrder) return res.status(400).json({ error: `Minimum order is ₹${minOrder}` });
  const order = {
    id: Date.now(), name, phone, block, villa,
    address: `Block ${block.toUpperCase()}, Villa No. ${villa}`,
    items, total, discountAmt: discountAmt || 0, finalTotal: finalTotal || total,
    customerId: customerId || null, status: 'new', createdAt: new Date().toISOString()
  };
  db.orders.unshift(order);
  items.forEach(item => {
    const prod = db.products.find(p => p.id == item.id);
    if (prod) { prod.stock = Math.max(0, (prod.stock || 0) - item.qty); if (prod.stock === 0) prod.inStock = false; }
  });
  if (customerId) {
    const cust = db.customers.find(c => c.id == customerId);
    if (cust) { if (!cust.orders) cust.orders = []; cust.orders.unshift({ orderId: order.id, total: order.finalTotal, date: order.createdAt }); }
  }
  writeDB(db);
  res.json({ success: true, order });
});

// Customer Auth
app.post('/api/customer/register', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) return res.status(400).json({ error: 'All fields required' });
  const db = readDB();
  if (!db.customers) db.customers = [];
  if (db.customers.find(c => c.phone === phone)) return res.status(409).json({ error: 'Phone already registered' });
  const customer = { id: db.nextCustomerId++, name, phone, password: hashPass(password), createdAt: new Date().toISOString(), orders: [] };
  db.customers.push(customer);
  writeDB(db);
  const token = jwt.sign({ customerId: customer.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, customer: { id: customer.id, name: customer.name, phone: customer.phone } });
});

app.post('/api/customer/login', (req, res) => {
  const { phone, password } = req.body;
  const db = readDB();
  if (!db.customers) return res.status(401).json({ error: 'Invalid credentials' });
  const customer = db.customers.find(c => c.phone === phone && c.password === hashPass(password));
  if (!customer) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ customerId: customer.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, customer: { id: customer.id, name: customer.name, phone: customer.phone } });
});

app.get('/api/customer/orders', customerAuth, (req, res) => {
  const db = readDB();
  res.json(db.orders.filter(o => o.customerId == req.customerId));
});

// Admin Auth
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const db = readDB();
  if (hashPass(password) === db.settings.adminPassword) {
    res.json({ token: jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' }) });
  } else { res.status(401).json({ error: 'Wrong password' }); }
});

// Admin Products
app.get('/api/admin/products', auth, (req, res) => res.json(readDB().products));

app.post('/api/admin/products', auth, (req, res) => {
  const db = readDB();
  const p = { ...req.body, id: db.nextId++, inStock: req.body.inStock !== false, stock: req.body.stock || 0, discountPrice: req.body.discountPrice || null, featured: req.body.featured || false, imageUrl: req.body.imageUrl || '', bulkTiers: req.body.bulkTiers || [] };
  db.products.push(p); writeDB(db); res.json(p);
});

app.put('/api/admin/products/:id', auth, (req, res) => {
  const db = readDB();
  const idx = db.products.findIndex(p => p.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.products[idx] = { ...db.products[idx], ...req.body }; writeDB(db); res.json(db.products[idx]);
});

app.delete('/api/admin/products/:id', auth, (req, res) => {
  const db = readDB(); db.products = db.products.filter(p => p.id != req.params.id); writeDB(db); res.json({ success: true });
});

// Admin Categories
app.get('/api/admin/categories', auth, (req, res) => res.json(readDB().categories));
app.post('/api/admin/categories', auth, (req, res) => {
  const db = readDB();
  const cat = { ...req.body, id: req.body.name.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now() };
  db.categories.push(cat); writeDB(db); res.json(cat);
});
app.put('/api/admin/categories/:id', auth, (req, res) => {
  const db = readDB(); const idx = db.categories.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.categories[idx] = { ...db.categories[idx], ...req.body }; writeDB(db); res.json(db.categories[idx]);
});
app.delete('/api/admin/categories/:id', auth, (req, res) => {
  const db = readDB(); db.categories = db.categories.filter(c => c.id !== req.params.id); writeDB(db); res.json({ success: true });
});

// Admin Orders
app.get('/api/admin/orders', auth, (req, res) => res.json(readDB().orders));
app.put('/api/admin/orders/:id/status', auth, (req, res) => {
  const db = readDB(); const order = db.orders.find(o => o.id == req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  order.status = req.body.status; writeDB(db); res.json(order);
});

// Admin Customers
app.get('/api/admin/customers', auth, (req, res) => {
  const db = readDB();
  res.json((db.customers || []).map(c => ({ id: c.id, name: c.name, phone: c.phone, createdAt: c.createdAt, orderCount: (c.orders || []).length })));
});

// Admin Settings
app.get('/api/admin/settings', auth, (req, res) => {
  const db = readDB();
  res.json({ storeName: db.settings.storeName, whatsapp: db.settings.whatsapp, qrUrl: db.settings.qrUrl, minOrder: db.settings.minOrder || 99, deliveryRadiusKm: db.settings.deliveryRadiusKm || 1, storeLat: db.settings.storeLat || '', storeLng: db.settings.storeLng || '', bulkDiscounts: db.settings.bulkDiscounts || [] });
});

app.put('/api/admin/settings', auth, (req, res) => {
  const db = readDB();
  const { storeName, whatsapp, qrUrl, newPassword, minOrder, deliveryRadiusKm, storeLat, storeLng, bulkDiscounts } = req.body;
  if (storeName) db.settings.storeName = storeName;
  if (whatsapp !== undefined) db.settings.whatsapp = whatsapp;
  if (qrUrl !== undefined) db.settings.qrUrl = qrUrl;
  if (newPassword) db.settings.adminPassword = hashPass(newPassword);
  if (minOrder !== undefined) db.settings.minOrder = minOrder;
  if (deliveryRadiusKm !== undefined) db.settings.deliveryRadiusKm = deliveryRadiusKm;
  if (storeLat !== undefined) db.settings.storeLat = storeLat;
  if (storeLng !== undefined) db.settings.storeLng = storeLng;
  if (bulkDiscounts) db.settings.bulkDiscounts = bulkDiscounts;
  writeDB(db); res.json({ success: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n✅ BSC Store v3 running at http://localhost:${PORT}`);
  console.log(`🛍️  Customer store: http://localhost:${PORT}`);
  console.log(`⚙️  Admin panel:    http://localhost:${PORT}/admin`);
  console.log(`🔑  Default admin password: admin123\n`);
});
