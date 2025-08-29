// server.js
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import 'dotenv/config';

// ====== CONFIG ENV ======
const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  GITHUB_TOKEN,
  GITHUB_OWNER = 'marcodalpont',
  GITHUB_REPO = 'dp-biotech-server',
  GITHUB_BRANCH = 'main',
  GITHUB_FILE_PATH = 'database.csv',
  PORT = process.env.PORT || 4242,
} = process.env;

if (!STRIPE_SECRET_KEY) console.error('❗ Missing STRIPE_SECRET_KEY');
if (!STRIPE_WEBHOOK_SECRET) console.error('❗ Missing STRIPE_WEBHOOK_SECRET');
if (!GITHUB_TOKEN) console.error('❗ Missing GITHUB_TOKEN');

// ====== INIT ======
const app = express();
const stripe = new Stripe(STRIPE_SECRET_KEY);

// JSON body per tutte le rotte tranne il webhook (serve raw)
app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe-webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// ====== IN-MEMORY DB ======
/**
 * licenseDatabase = {
 *   [SERIAL]: {
 *     status: 'valid'|'expired'|'not-active',
 *     activation_date: 'YYYY-MM-DD' | null,
 *     expires: 'YYYY-MM-DD' | null,
 *     activeFeatures: ['3d-models','parallax','image-addition','ndi']
 *   }
 * }
 */
let licenseDatabase = {};

// ====== GITHUB HELPERS ======
const GH_API = 'https://api.github.com';

async function githubGetFile(owner, repo, path, branch, token) {
  const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
    },
  });
  if (resp.status === 404) return null; // file non esiste
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`GitHub GET failed ${resp.status}: ${t}`);
  }
  return await resp.json();
}

async function githubPutFile({ owner, repo, path, branch, token, contentBase64, sha, message }) {
  const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: contentBase64,
    branch,
    ...(sha ? { sha } : {})
  };
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`GitHub PUT failed ${resp.status}: ${t}`);
  }
  return await resp.json();
}

// ====== CSV HELPERS (senza I/O su disco) ======
const CSV_HEADERS = [
  'serial',
  'status',
  'activation_date',
  'expiration_date',
  'feature_3d_models',
  'feature_parallax',
  'feature_image_addition',
  'feature_ndi',
];

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function dbToCsv(db) {
  const lines = [];
  lines.push(CSV_HEADERS.join(','));
  for (const [serial, data] of Object.entries(db)) {
    const row = [
      serial,
      data.status || 'not-active',
      data.activation_date || '',
      data.expires || '',
      (data.activeFeatures || []).includes('3d-models') ? 'True' : 'False',
      (data.activeFeatures || []).includes('parallax') ? 'True' : 'False',
      (data.activeFeatures || []).includes('image-addition') ? 'True' : 'False',
      (data.activeFeatures || []).includes('ndi') ? 'True' : 'False',
    ].map(csvEscape);
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

function csvToDb(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return {};
  // Parsing semplice (no virgole quotate complesse): il tuo CSV non usa campi con virgole.
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const serial = (cols[idx.serial] || '').toUpperCase().trim();
    if (!serial) continue;

    const features = [];
    if ((cols[idx.feature_3d_models] || '').trim() === 'True') features.push('3d-models');
    if ((cols[idx.feature_parallax] || '').trim() === 'True') features.push('parallax');
    if ((cols[idx.feature_image_addition] || '').trim() === 'True') features.push('image-addition');
    if ((cols[idx.feature_ndi] || '').trim() === 'True') features.push('ndi');

    out[serial] = {
      status: (cols[idx.status] || 'not-active').trim(),
      activation_date: (cols[idx.activation_date] || '').trim() || null,
      expires: (cols[idx.expiration_date] || '').trim() || null,
      activeFeatures: features,
    };
  }
  return out;
}

// Carica CSV da GitHub in memoria
let currentGitSha = null;
async function loadDatabaseFromGitHub() {
  try {
    const fileMeta = await githubGetFile(GITHUB_OWNER, GITHUB_REPO, GITHUB_FILE_PATH, GITHUB_BRANCH, GITHUB_TOKEN);
    if (!fileMeta) {
      console.warn('⚠️ database.csv non trovato su GitHub, inizializzo DB vuoto.');
      licenseDatabase = {};
      currentGitSha = null;
      return;
    }
    const content = Buffer.from(fileMeta.content, 'base64').toString('utf8');
    licenseDatabase = csvToDb(content);
    currentGitSha = fileMeta.sha;
    console.log('📁 Database CSV caricato da GitHub in memoria.');
  } catch (err) {
    console.error('Errore caricamento CSV da GitHub:', err.message);
    // Non crashare: tieni DB vuoto
    licenseDatabase = {};
    currentGitSha = null;
  }
}

// Salva CSV (aggiornato) su GitHub con commit
async function saveDatabaseToGitHub({ commitMessage = 'chore: update license database (webhook)' } = {}) {
  const csv = dbToCsv(licenseDatabase);
  const contentBase64 = Buffer.from(csv, 'utf8').toString('base64');
  const result = await githubPutFile({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path: GITHUB_FILE_PATH,
    branch: GITHUB_BRANCH,
    token: GITHUB_TOKEN,
    contentBase64,
    sha: currentGitSha || undefined,
    message: commitMessage,
  });
  currentGitSha = result.content?.sha || currentGitSha;
  console.log('✅ Database CSV aggiornato su GitHub.');
}

// ====== PREZZI (server-trusted) ======
const PRICES = {
  'dp-mini-base': 299000,          // € 2.990,00
  'dp-pro-base': 899000,           // € 8.990,00
  'license-base': 60000,           // €   600,00
  'feature-3d-models': 12900,      // €   129,00
  'feature-parallax': 4900,        // €    49,00
  'feature-image-addition': 4900,  // €    49,00
  'feature-ndi': 22000,            // €   220,00
};

const OPTIONS_PRICES = {
  objectives: { '50mm': 0, '60mm': 18000, '75mm': 35000 },
  eyepieces: { screen: 0, hd: 29000, '4k': 58000 },
  mounting: { handle: 0, arm: 22000 },
  stabilization: { '3axis': 0, enhanced: 45000 },
  care: { none: 0, basic: 29000, plus: 49000 },
};

function calculateItemPrice(item) {
  if (!item?.id || PRICES[item.id] == null) {
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

// ====== ROUTES ======
app.get('/', (req, res) => {
  res.send('DP Biotech Payment Server attivo ✅ (GitHub-backed CSV)');
});

app.get('/check-license/:serial', async (req, res) => {
  const serial = (req.params.serial || '').toUpperCase().trim();
  const licenseInfo = licenseDatabase[serial];
  if (licenseInfo) res.json(licenseInfo);
  else res.status(404).json({ error: 'License not found' });
});

app.post('/create-checkout-session', async (req, res) => {
  const { cart, customerEmail, serialNumber } = req.body || {};

  if (!customerEmail || !Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: 'Dati mancanti: carrello e email sono obbligatori.' });
  }

  // Valida cart server-side
  try {
    cart.forEach((i) => {
      if (!i?.id || PRICES[i.id] == null) {
        throw new Error(`ID Prodotto non valido: '${i?.id}'`);
      }
    });
  } catch (e) {
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
      payment_method_types: ['card'], // compatibile con tutte le versioni
      line_items: lineItems,
      metadata,
      success_url: `https://www.dpbiotech.com/success.html`,
      cancel_url: `https://www.dpbiotech.com/checkout.html`,
    });

    console.log('Stripe session created:', session.id);
    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    const status = error?.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    res.status(status).json({ error: error.message || 'Errore interno del server.' });
  }
});

// Webhook: usa raw body
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('⚠️ Webhook signature verification failed.', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const serial = (session.metadata?.serial_number || '').toUpperCase().trim();
    const featuresPurchased = (session.metadata?.features_purchased || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((fid) => fid.replace(/^feature-/, ''));

    console.log(`✅ Pagamento completato per serial: ${serial || '(nessun serial)'}`);

    if (serial) {
      if (!licenseDatabase[serial]) {
        licenseDatabase[serial] = {
          status: 'not-active',
          activation_date: null,
          expires: null,
          activeFeatures: [],
        };
      }

      // Aggiorna stato & date
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');

      licenseDatabase[serial].status = 'valid';
      licenseDatabase[serial].activation_date = `${yyyy}-${mm}-${dd}`;

      const nextYear = new Date(today);
      nextYear.setFullYear(today.getFullYear() + 1);
      const nyyyy = nextYear.getFullYear();
      const nmm = String(nextYear.getMonth() + 1).padStart(2, '0');
      const ndd = String(nextYear.getDate()).padStart(2, '0');
      licenseDatabase[serial].expires = `${nyyyy}-${nmm}-${ndd}`;

      // Merge features
      const set = new Set(licenseDatabase[serial].activeFeatures || []);
      featuresPurchased.forEach((f) => set.add(f));
      licenseDatabase[serial].activeFeatures = Array.from(set);

      try {
        await saveDatabaseToGitHub({ commitMessage: `feat(license): update ${serial} via Stripe webhook` });
      } catch (e) {
        console.error('❗ Errore salvataggio CSV su GitHub:', e.message);
        // Non ritorniamo errore al webhook (Stripe ritenterebbe) se l'update DB è ok in memoria
      }
    }
  }

  res.json({ received: true });
});

// ====== STARTUP ======
app.listen(PORT, async () => {
  console.log(`🚀 Server in ascolto sulla porta ${PORT}`);
  await loadDatabaseFromGitHub();
});
