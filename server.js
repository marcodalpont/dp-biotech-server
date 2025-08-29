// server.js
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import 'dotenv/config';
import fs from 'fs';
import csvParser from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';

// =======================
// Inizializzazione
// =======================
const app = express();

// (opzionale ma consigliato) fissa una API version compatibile
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  // apiVersion: '2023-10-16', // scommenta se vuoi forzare la versione API
});

// =======================
// CORS (a prova di preflight)
// =======================
app.use(
  cors({
    origin: true, // riflette l'Origin chiamante
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  })
);
app.options('*', cors());

// Header di cortesia anche sugli errori
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// =======================
// Body parser: JSON per tutto tranne il webhook (raw)
// =======================
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe-webhook') {
    next(); // il webhook usa express.raw
  } else {
    express.json()(req, res, next);
  }
});

// =======================
// Database CSV (licenze)
// =======================
const DB_PATH = './database.csv';
let licenseDatabase = {};

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
        activation_date: row.activation_date || null,
        expires: row.expiration_date || null,
        activeFeatures: features,
      };
    })
    .on('end', () => {
      console.log('📁 Database CSV caricato in memoria.');
    });
} else {
  console.log('ℹ️ Nessun database.csv: verrà creato al primo salvataggio.');
}

const saveDatabase = async () => {
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
  console.log('✅ Database CSV aggiornato.');
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
// Rotte
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

app.post('/create-checkout-session', async (req, res) => {
  // Log ingresso (utile in debug)
  console.log('➡️  /create-checkout-session payload:', JSON.stringify(req.body, null, 2));

  const { cart, customerEmail, serialNumber } = req.body;

  // Validazioni base
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('❌ STRIPE_SECRET_KEY mancante');
    return res.status(500).json({ error: 'Stripe configuration missing (secret key).' });
  }
  if (!customerEmail || !Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: 'Dati mancanti: carrello e email sono obbligatori.' });
  }

  // Validazione ID carrello
  try {
    cart.forEach((item) => {
      if (!item?.id || PRICES[item.id] === undefined) {
        throw new Error(`ID Prodotto non valido: '${item?.id}'`);
      }
    });
  } catch (e) {
    console.error('❌ Cart validation error:', e.message);
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

    // Crea cliente (o riusa se stessa email già presente: Stripe gestisce)
    const customer = await stripe.customers.create({ email: customerEmail });

    // Metadati per il webhook
    const sessionMetadata = {};
    if (serialNumber) {
      sessionMetadata.serial_number = String(serialNumber).toUpperCase();
      sessionMetadata.features_purchased = cart
        .filter((i) => String(i.id).startsWith('feature-'))
        .map((i) => i.id)
        .join(',');
    }

    // *** Compatibile con API meno recenti: niente automatic_payment_methods ***
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'payment',
      payment_method_types: ['card'], // compatibile
      line_items: lineItems,
      metadata: sessionMetadata,
      success_url: `https://www.dpbiotech.com/success.html`,
      cancel_url: `https://www.dpbiotech.com/checkout.html`,
    });

    console.log('✅ Stripe session created:', session.id);
    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Stripe error:', {
      message: error.message,
      type: error.type,
      code: error.code,
      param: error.param,
      raw: error.raw,
    });
    const status = error?.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    res.status(status).json({ error: error.message || 'Errore interno del server.' });
  }
});

// =======================
// Webhook Stripe (raw body)
// =======================
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.log('⚠️ Webhook signature verification failed.', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const serial = (session.metadata?.serial_number || '').toUpperCase();
    const featuresPurchased = (session.metadata?.features_purchased || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((fid) => fid.replace(/^feature-/, ''));

    console.log(`💳 Pagamento completato per seriale: ${serial}`);

    if (serial) {
      if (!licenseDatabase[serial]) {
        licenseDatabase[serial] = {
          status: 'not-active',
          activation_date: null,
          expires: null,
          activeFeatures: [],
        };
      }

      licenseDatabase[serial].status = 'valid';
      const today = new Date();
      licenseDatabase[serial].activation_date = today.toISOString().split('T')[0];
      const nextYear = new Date(today);
      nextYear.setFullYear(today.getFullYear() + 1);
      licenseDatabase[serial].expires = nextYear.toISOString().split('T')[0];

      const setFeatures = new Set(licenseDatabase[serial].activeFeatures);
      featuresPurchased.forEach((f) => setFeatures.add(f));
      licenseDatabase[serial].activeFeatures = Array.from(setFeatures);

      await saveDatabase();
      console.log('🗄️  Licenza aggiornata e salvata su CSV.');
    }
  }

  res.json({ received: true });
});

// =======================
// Avvio server
// =======================
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 Server in ascolto sulla porta ${PORT}`));
