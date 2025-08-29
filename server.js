// server.js
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import csvParser from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';

// =======================
// Config & Init
// =======================
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY /*, { apiVersion: '2023-10-16' } */);

// CORS solido (preflight incluso)
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature'],
  })
);
app.options('*', cors());

// Body parser: JSON per tutto tranne il webhook (raw)
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe-webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// =======================
// Database CSV (licenze)
// =======================
// Se stai su Render con Persistent Disk, monta a /data e userai /data/database.csv
const DB_PATH = process.env.DB_PATH || '/data/database.csv';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let licenseDatabase = {};

// Carica CSV (se esiste)
if (fs.existsSync(DB_PATH)) {
  fs.createReadStream(DB_PATH)
    .pipe(csvParser())
    .on('data', (row) => {
      const serial = (row.serial || '').toUpperCase();
      if (!serial) return;
      const features = [];
      if (row.feature_3d_models === 'True') features.push('3d-models');
      if (row.feature_parallax === 'True') features.push('parallax');
      if (row.feature_image_addition === 'True') features.push('image-addition');
      if (row.feature_ndi === 'True') features.push('ndi');
      licenseDatabase[serial] = {
        status: row.status || 'not-active',
        activation_date: row.activation_date || '',
        expires: row.expiration_date || '',
        activeFeatures: features,
      };
    })
    .on('end', () => console.log('📁 Database CSV caricato in memoria.'));
} else {
  console.log('ℹ️ Nessun CSV iniziale: verrà creato al primo salvataggio in', DB_PATH);
}

// Salva CSV
const saveDatabase = async () => {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const csvWriter = createObjectCsvWriter({
    path: DB_PATH,
    header: [
      { id: 'serial', title: 'serial' },
      { id: 'status', title: 'status' },
      { id: 'activation_date', title: 'activation_date' },
      { id: 'expiration_date', title: 'expiration_date' },
      { id: 'feature_3d_models', title: 'feature_3d_models' },
      { id: 'feature_parallax', title: 'feature_parallax' },
      { id: 'feature_image_addition', title: 'feature_image_addition' },
      { id: 'feature_ndi', title: 'feature_ndi' },
    ],
  });

  const records = Object.entries(licenseDatabase).map(([serial, data]) => ({
    serial,
    status: data.status,
    activation_date: data.activation_date || '',
    expiration_date: data.expires || '',
    feature_3d_models: data.activeFeatures.includes('3d-models') ? 'True' : 'False',
    feature_parallax: data.activeFeatures.includes('parallax') ? 'True' : 'False',
    feature_image_addition: data.activeFeatures.includes('image-addition') ? 'True' : 'False',
    feature_ndi: data.activeFeatures.includes('ndi') ? 'True' : 'False',
  }));

  await csvWriter.writeRecords(records);
  console.log('🗄️ CSV salvato su', DB_PATH);
};

// =======================
// Prezzi (in centesimi)
// =======================
const PRICES = {
  'dp-mini-base': 299000,
  'dp-pro-base': 899000,
  'license-base': 60000,            // €600
  'feature-3d-models': 12900,       // €129
  'feature-parallax': 4900,         // €49
  'feature-image-addition': 4900,   // €49
  'feature-ndi': 22000,             // €220
};

const OPTIONS_PRICES = {
  objectives: { '50mm': 0, '60mm': 18000, '75mm': 35000 },
  eyepieces: { screen: 0, hd: 29000, '4k': 58000 },
  mounting: { handle: 0, arm: 22000 },
  stabilization: { '3axis': 0, enhanced: 45000 },
  care: { none: 0, basic: 29000, plus: 49000 },
};

function calculateItemPrice(item) {
  if (!item?.id || PRICES[item.id] === undefined) {
    throw new Error(`ID Prodotto non valido: '${item?.id}'`);
  }
  let total = PRICES[item.id];
  if (item.options) {
    for (const [category, selection] of Object.entries(item.options)) {
      total += OPTIONS_PRICES[category]?.[selection] || 0;
    }
  }
  return total;
}

// =======================
// Rotte API
// =======================
app.get('/', (req, res) => {
  res.send('DP Biotech Payment Server è attivo. ✅');
});

app.get('/check-license/:serial', (req, res) => {
  const serial = (req.params.serial || '').toUpperCase();
  const licenseInfo = licenseDatabase[serial];
  if (licenseInfo) return res.json(licenseInfo);
  res.status(404).json({ error: 'License not found' });
});

app.get('/debug-licenses', (req, res) => {
  // endpoint di debug (rimuovi in produzione)
  res.json(licenseDatabase);
});

app.post('/create-checkout-session', async (req, res) => {
  console.log('➡️  /create-checkout-session', JSON.stringify(req.body, null, 2));
  const { cart, customerEmail, serialNumber } = req.body;

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('❌ STRIPE_SECRET_KEY mancante');
    return res.status(500).json({ error: 'Stripe configuration missing.' });
  }
  if (!customerEmail || !Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: 'Dati mancanti: carrello e email sono obbligatori.' });
  }

  // valida carrello
  try {
    cart.forEach((i) => {
      if (!i?.id || PRICES[i.id] === undefined) {
        throw new Error(`ID Prodotto non valido: '${i?.id}'`);
      }
    });
  } catch (e) {
    console.error('❌ Cart validation:', e.message);
    return res.status(400).json({ error: e.message });
  }

  try {
    const lineItems = cart.map((item) => ({
      price_data: {
        currency: 'eur',
        product_data: { name: item.name || item.id },
        unit_amount: calculateItemPrice(item),
      },
      quantity: 1,
    }));

    const customer = await stripe.customers.create({ email: customerEmail });

    const metadata = {};
    if (serialNumber) {
      metadata.serial_number = String(serialNumber).toUpperCase();
      metadata.features_purchased = cart
        .filter((i) => String(i.id).startsWith('feature-'))
        .map((i) => i.id)
        .join(',');
    }

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'payment',
      payment_method_types: ['card'], // compatibile con API meno recenti
      line_items: lineItems,
      metadata,
      success_url: 'https://www.dpbiotech.com/success.html',
      cancel_url: 'https://www.dpbiotech.com/checkout.html',
    });

    console.log('✅ Stripe session created:', session.id);
    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Stripe error:', {
      message: error.message,
      type: error.type,
      code: error.code,
      param: error.param,
    });
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    res.status(status).json({ error: error.message || 'Errore interno del server.' });
  }
});

// =======================
// Webhook Stripe (RAW body obbligatorio)
// =======================
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('➡️ Webhook hit');
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  console.log('Has signature header?', !!sig);
  console.log('STRIPE_WEBHOOK_SECRET present?', !!endpointSecret);

  if (!endpointSecret) {
    console.error('❌ STRIPE_WEBHOOK_SECRET mancante. Configura la env e redeploya.');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('✅ constructEvent OK. type:', event.type);
  } catch (err) {
    console.error('⚠️ Signature verification failed:', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    try {
      const session = event.data.object; // Checkout Session
      const serial = String(session.metadata?.serial_number || '').toUpperCase();
      const featuresPurchased = String(session.metadata?.features_purchased || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((fid) => fid.replace(/^feature-/, ''));

      console.log('ℹ️ serial:', serial, 'featuresPurchased:', featuresPurchased);

      if (!serial) {
        console.error('❌ Nessun serial nei metadata.');
        return res.json({ received: true });
      }

      if (!licenseDatabase[serial]) {
        licenseDatabase[serial] = {
          status: 'not-active',
          activation_date: '',
          expires: '',
          activeFeatures: [],
        };
      }

      // aggiorna in memoria
      const today = new Date();
      licenseDatabase[serial].status = 'valid';
      licenseDatabase[serial].activation_date = today.toISOString().split('T')[0];
      const nextYear = new Date(today);
      nextYear.setFullYear(today.getFullYear() + 1);
      licenseDatabase[serial].expires = nextYear.toISOString().split('T')[0];

      const set = new Set(licenseDatabase[serial].activeFeatures);
      featuresPurchased.forEach((f) => set.add(f));
      licenseDatabase[serial].activeFeatures = Array.from(set);

      await saveDatabase();
      console.log('🗄️ CSV aggiornato dopo pagamento.');
    } catch (e) {
      console.error('❌ Errore gestione checkout.session.completed:', e);
      return res.sendStatus(500);
    }
  }

  res.json({ received: true });
});

// =======================
// Avvio
// =======================
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 Server in ascolto sulla porta ${PORT}`));
