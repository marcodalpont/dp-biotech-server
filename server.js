import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import 'dotenv/config';
import fs from 'fs';
import csvParser from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';

// --- Inizializzazione ---
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --- Middleware ---
app.use(cors());
// Il webhook di Stripe ha bisogno del body "raw", quindi gestiamo il parsing JSON in modo condizionale.
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe-webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// --- Database CSV ---
const DB_PATH = './database.csv';
let licenseDatabase = {};

fs.createReadStream(DB_PATH)
  .pipe(csvParser())
  .on('data', (row) => {
    const serial = row.serial;
    const features = [];
    if (row.feature_3d_models === 'True') features.push('3d-models');
    if (row.feature_parallax === 'True') features.push('parallax');
    if (row.feature_image_addition === 'True') features.push('image-addition');
    if (row.feature_ndi === 'True') features.push('ndi');
    
    licenseDatabase[serial] = {
      status: row.status,
      activation_date: row.activation_date,
      expires: row.expiration_date,
      activeFeatures: features,
    };
  })
  .on('end', () => {
    console.log('Database CSV caricato con successo in memoria.');
  });

// Funzione per salvare le modifiche sul file CSV
const saveDatabase = async () => {
  const csvWriter = createObjectCsvWriter({
    path: DB_PATH,
    header: [
      {id: 'serial', title: 'serial'},
      {id: 'status', title: 'status'},
      {id: 'activation_date', title: 'activation_date'},
      {id: 'expiration_date', title: 'expiration_date'},
      {id: 'feature_3d_models', title: 'feature_3d_models'},
      {id: 'feature_parallax', title: 'feature_parallax'},
      {id: 'feature_image_addition', title: 'feature_image_addition'},
      {id: 'feature_ndi', title: 'feature_ndi'},
    ]
  });

  const records = Object.entries(licenseDatabase).map(([serial, data]) => ({
    serial: serial,
    status: data.status,
    activation_date: data.activation_date,
    expiration_date: data.expires,
    feature_3d_models: data.activeFeatures.includes('3d-models') ? 'True' : 'False',
    feature_parallax: data.activeFeatures.includes('parallax') ? 'True' : 'False',
    feature_image_addition: data.activeFeatures.includes('image-addition') ? 'True' : 'False',
    feature_ndi: data.activeFeatures.includes('ndi') ? 'True' : 'False',
  }));

  await csvWriter.writeRecords(records);
  console.log('Database CSV aggiornato con successo.');
};

// --- Prezzi Prodotti (Fisici e Licenze) ---
// Manteniamo i prezzi qui per facilità di gestione
const PRICES = {
  'dp-mini-base': 299000,
  'dp-pro-base': 899000,
  'license-base': 60000,
  'feature-3d-models': 12900,
  'feature-parallax': 4900,
  'feature-image-addition': 4900,
  'feature-ndi': 22000,
};

const OPTIONS_PRICES = {
  objectives: { '50mm': 0, '60mm': 18000, '75mm': 35000 },
  eyepieces: { screen: 0, hd: 29000, '4k': 58000 },
  mounting: { handle: 0, arm: 22000 },
  stabilization: { '3axis': 0, enhanced: 45000 },
  care: { none: 0, basic: 29000, plus: 49000 },
};

function calculateItemPrice(item) {
  if (!item.id || PRICES[item.id] === undefined) {
    throw new Error(`ID Prodotto non valido: '${item.id}'`);
  }
  let total = PRICES[item.id];
  if (item.options) {
    for (const [category, selection] of Object.entries(item.options)) {
      total += OPTIONS_PRICES[category]?.[selection] || 0;
    }
  }
  return total;
}

// --- Rotte del Server ---

app.get('/', (req, res) => {
  res.send('DP Biotech Payment Server è attivo. ✅');
});

// NUOVO ENDPOINT per controllare lo stato di una licenza
app.get('/check-license/:serial', (req, res) => {
  const serial = req.params.serial.toUpperCase();
  const licenseInfo = licenseDatabase[serial];
  if (licenseInfo) {
    res.json(licenseInfo);
  } else {
    res.status(404).json({ error: 'License not found' });
  }
});

// Endpoint per creare la sessione di pagamento
app.post('/create-checkout-session', async (req, res) => {
  const { cart, customerEmail, serialNumber } = req.body; // Aggiunto serialNumber

  if (!customerEmail || !cart || cart.length === 0) {
    return res.status(400).json({ error: 'Dati mancanti: carrello e email sono obbligatori.' });
  }

  try {
    const lineItems = cart.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: { name: item.name },
        unit_amount: calculateItemPrice(item),
      },
      quantity: 1,
    }));

    const customer = await stripe.customers.create({ email: customerEmail });

    // Aggiungiamo il seriale ai metadati se si sta comprando una licenza
    const sessionMetadata = {};
    if (serialNumber) {
        sessionMetadata.serial_number = serialNumber;
        // Salva anche quali feature sono state comprate
        sessionMetadata.features_purchased = cart
            .filter(item => item.id.startsWith('feature-'))
            .map(item => item.id)
            .join(',');
    }
    
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'payment',
      payment_method_types: ['card', 'paypal', 'customer_balance'],
      line_items: lineItems,
      metadata: sessionMetadata, // IMPORTANTE: Passiamo i metadati a Stripe
      payment_method_options: {
        customer_balance: {
          funding_type: 'bank_transfer',
          bank_transfer: { type: 'eu_bank_transfer', eu_bank_transfer: { country: 'DE' } },
        },
      },
      shipping_address_collection: {
        allowed_countries: ['IT', 'FR', 'DE', 'ES', 'GB', 'US', 'CH', 'AT', 'BE', 'NL'],
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 4990, currency: 'eur' },
            display_name: 'Spedizione Internazionale Standard',
          },
        },
      ],
      success_url: `https://www.dpbiotech.com/success.html`,
      cancel_url: `https://www.dpbiotech.com/checkout.html`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Errore Stripe:', error.message);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

// NUOVO ENDPOINT per ricevere notifiche da Stripe (Webhook)
app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Imposta questa variabile nel tuo file .env!
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.log(`⚠️ Webhook signature verification failed.`, err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const serial = session.metadata.serial_number;
    const featuresPurchased = session.metadata.features_purchased?.split(',') || [];

    console.log(`Pagamento completato per il seriale: ${serial}`);

    if (licenseDatabase[serial]) {
      // 1. MODIFICA i dati in memoria
      licenseDatabase[serial].status = 'valid';
      const today = new Date();
      licenseDatabase[serial].activation_date = today.toISOString().split('T')[0];
      const nextYear = new Date(new Date().setFullYear(today.getFullYear() + 1));
      licenseDatabase[serial].expires = nextYear.toISOString().split('T')[0];
      
      // Aggiungi le nuove funzionalità, evitando duplicati
      const newFeatures = new Set([...licenseDatabase[serial].activeFeatures, ...featuresPurchased]);
      licenseDatabase[serial].activeFeatures = Array.from(newFeatures);

      // 2. SALVA l'intero database aggiornato su file
      await saveDatabase();
    }
  }

  res.json({received: true});
});

// --- Avvio del Server ---
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 Server in ascolto sulla porta ${PORT}`));
