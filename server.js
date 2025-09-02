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

// JSON body for all routes except the webhook (which needs the raw body)
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
 *   [SERIAL]: {
 *     status: 'valid'|'expired'|'not-active',
 *     activation_date: 'YYYY-MM-DD' | null,
 *     expires: 'YYYY-MM-DD' | null,
 *     activeFeatures: ['3d-models','parallax','image-addition','ndi']
 *   }
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
  if (resp.status === 404) return null; // file does not exist
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

// ====== CSV HELPERS (without disk I/O) ======
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

// Load CSV from GitHub into memory
let currentGitSha = null;
async function loadDatabaseFromGitHub() {
  try {
    const fileMeta = await githubGetFile(GITHUB_OWNER, GITHUB_REPO, GITHUB_FILE_PATH, GITHUB_BRANCH, GITHUB_TOKEN);
    if (!fileMeta) {
      console.warn('⚠️ database.csv not found on GitHub, initializing empty DB.');
      licenseDatabase = {};
      currentGitSha = null;
      return;
    }
    const content = Buffer.from(fileMeta.content, 'base64').toString('utf8');
    licenseDatabase = csvToDb(content);
    currentGitSha = fileMeta.sha;
    console.log('📁 Database CSV loaded from GitHub into memory.');
  } catch (err) {
    console.error('Error loading CSV from GitHub:', err.message);
    licenseDatabase = {};
    currentGitSha = null;
  }
}

// Save updated CSV to GitHub with a commit
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
  console.log('✅ Database CSV updated on GitHub.');
}

// ====== MODIFICATION START: Updated Pricing Logic ======

// Server-trusted base prices in cents
const PRICES = {
    'dp-mini-base': 299000,          // €2,990.00 -> Mismatch in buydpmini.html JS, but this is correct.
    'dp-pro-base': 899000,           // €8,990.00
    'license-base': 60000,           // €  600.00
    'feature-3d-models': 12900,      // €  129.00
    'feature-parallax': 4900,        // €   49.00
    'feature-image-addition': 4900,  // €   49.00
    'feature-ndi': 22000,            // €  220.00
};

// Server-trusted option prices in cents, based on client-side files
const OPTIONS_PRICES = {
    // DP Mini Options from buydpmini.html
    objective: { '50mm': 0, '60mm': 29000, '75mm': 54000 },
    eyepiece: { 'Screen': 0, 'Full HD': 154000, '4K UHD': 208500 },
    mount: { 'Desk Mount': 0, 'Floor Stand': 0, 'Wall Mount': 0, 'Ceiling Mount': 0 },

    // DP Pro Options from buydppro.html
    stabilization: { 'Standard': 0, 'Enhanced': 45000 },
    arm: { 'Standard': 0, 'Extended': 68000 },
    ai: { 'Standard': 0, 'Advanced': 59000 },
    controls: {
        'Multifunctional Joystick': 28000,
        'Foot Pedal Control': 19000
    }
};

/**
 * Calculates the price of a cart item securely on the server.
 * @param {object} item - The cart item object.
 * @returns {number} The total price in cents.
 */
function calculateItemPrice(item) {
    if (!item || !item.id) {
        throw new Error(`Invalid product data provided.`);
    }

    // Handle simple products/licenses first (e.g., feature-ndi)
    if (PRICES[item.id]) {
        return PRICES[item.id];
    }

    const options = item.options || {};
    let total = 0;

    // Handle configured DP Mini
    if (item.id.startsWith('dp-mini-')) {
        total += PRICES['dp-mini-base'];
        
        const objectivePrice = OPTIONS_PRICES.objective?.[options.objective];
        const eyepiecePrice = OPTIONS_PRICES.eyepiece?.[options.eyepiece];
        
        if (objectivePrice === undefined || eyepiecePrice === undefined) {
             throw new Error(`Invalid options for DP Mini: ${JSON.stringify(options)}`);
        }

        total += objectivePrice;
        total += eyepiecePrice;
        total += OPTIONS_PRICES.mount?.[options.mount] ?? 0; // All mounts are free
        return total;
    }

    // Handle configured DP Pro
    if (item.id.startsWith('dppro-')) {
        total += PRICES['dp-pro-base'];
        
        const stabilizationKey = options.stabilization?.includes('Enhanced') ? 'Enhanced' : 'Standard';
        const armKey = options.arm?.includes('Extended') ? 'Extended' : 'Standard';
        const aiKey = options.ai?.includes('Advanced') ? 'Advanced' : 'Standard';
        
        total += OPTIONS_PRICES.stabilization?.[stabilizationKey] ?? 0;
        total += OPTIONS_PRICES.arm?.[armKey] ?? 0;
        total += OPTIONS_PRICES.ai?.[aiKey] ?? 0;
        
        if (options.controls?.includes('Multifunctional Joystick')) {
            total += OPTIONS_PRICES.controls['Multifunctional Joystick'];
        }
        if (options.controls?.includes('Foot Pedal Control')) {
            total += OPTIONS_PRICES.controls['Foot Pedal Control'];
        }

        return total;
    }

    // If the product ID is not recognized, throw an error.
    throw new Error(`ID Prodotto non valido: '${item.id}'`);
}

// ====== MODIFICATION END ======


// ====== ROUTES ======
app.get('/', (req, res) => {
  res.send('DP Biotech Payment Server active ✅ (GitHub-backed CSV)');
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
    return res.status(400).json({ error: 'Missing data: cart and email are required.' });
  }

  try {
    // The price for each item is calculated on the server to prevent tampering.
    const lineItems = cart.map((item) => ({
      price_data: {
        currency: 'eur',
        // Use the item name from the cart, fallback to ID
        product_data: { name: item.name || item.id },
        // The new function handles validation and calculation for all product types
        unit_amount: calculateItemPrice(item),
      },
      quantity: 1, // Each configured item is unique in the cart array
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
      payment_method_types: ['card', 'klarna', 'sofort'], // Added more compatible payment methods
      line_items: lineItems,
      shipping_address_collection: {
          allowed_countries: ['IT', 'AT', 'DE', 'CH', 'FR', 'ES', 'GB', 'US'], // Example countries
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: {
              amount: 4990, // Shipping cost in cents (€49.90)
              currency: 'eur',
            },
            display_name: 'Standard Shipping',
          },
        },
      ],
      metadata,
      success_url: `https://www.dpbiotech.com/success.html`, // Replace with your actual success page
      cancel_url: `https://www.dpbiotech.com/checkout.html`,   // Replace with your actual checkout page
    });

    console.log('Stripe session created:', session.id);
    res.json({ url: session.url });
  } catch (error) {
    // This now catches errors from both calculateItemPrice and Stripe
    console.error('Error creating checkout session:', error);
    // If it's our validation error, send a 400 Bad Request
    if (error.message.includes('ID Prodotto non valido') || error.message.includes('Invalid options')) {
        res.status(400).json({ error: error.message });
    } else { // Otherwise, it's likely a server or Stripe error
        const status = error?.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
        res.status(status).json({ error: error.message || 'Internal server error.' });
    }
  }
});

// Webhook: uses raw body
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

    console.log(`✅ Payment completed for serial: ${serial || '(no serial number)'}`);

    if (serial) {
      if (!licenseDatabase[serial]) {
        licenseDatabase[serial] = {
          status: 'not-active',
          activation_date: null,
          expires: null,
          activeFeatures: [],
        };
      }

      // Update status & dates
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
        console.error('❗ Error saving CSV to GitHub:', e.message);
      }
    }
  }

  res.json({ received: true });
});

// ====== STARTUP ======
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  await loadDatabaseFromGitHub();
});
