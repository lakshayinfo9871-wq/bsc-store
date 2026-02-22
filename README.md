# 🛒 BSC Grocery Store — Full Stack App

## How to Run

### Requirements
- Node.js installed (download from https://nodejs.org)

### Steps

1. **Extract this folder** anywhere on your computer (e.g. Desktop)

2. **Open Terminal / Command Prompt** in the `bsc-store` folder

3. **Install dependencies** (only once):
   ```
   npm install
   ```

4. **Start the server**:
   ```
   node server.js
   ```

5. **Open your browser:**
   - 🛍️ Customer Store → http://localhost:3000
   - ⚙️ Admin Panel  → http://localhost:3000/admin

---

## Admin Login

**Default password:** `admin123`

You can change it anytime from the Admin Panel → Settings.

---

## Admin Panel Features

| Feature | What you can do |
|---|---|
| 📦 Orders | View all orders, see details, update status (new → preparing → out for delivery → delivered) |
| 🛍️ Products | Add, edit, delete products. Change price, name, unit, emoji, stock status |
| 🏷️ Categories | Add, edit, delete categories |
| ⚙️ Settings | Set your store name, WhatsApp number, QR code, change password |

---

## First Time Setup

1. Go to Admin Panel → **Settings**
2. Set your **WhatsApp number** (e.g. `919876543210` for India)
3. Upload your QR code image to any free image host (like https://imgbb.com) and paste the link
4. Click **Save Settings**

That's it! Orders will come to your WhatsApp automatically.

---

## Data Storage

All data is saved in `db.json` file in the same folder. No external database needed!
