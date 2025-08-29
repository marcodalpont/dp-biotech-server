import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// --- Price Database ---
// Contains all purchasable items, physical or digital.
// Prices are in CENTS (e.g., €129.00 -> 12900).
const PRICES = {
  // Physical Products
  'dp-mini-base': 299000,
  'dp-pro-base': 899000,
  
  // License Products (Added)
  'license-base': 60000,               // 3000€ / 5 = 600€ -> 60000 cents
  'feature-3d-models': 12900,         // 129€ -> 12900 cents
  'feature-parallax': 4900,             // 49€  -> 4900 cents
  'feature-image-addition': 4900,     // 49€  -> 4900 cents
  'feature-ndi': 22000,                 // 220€ -> 22000 cents
};

const OPTIONS_PRICES = {
  // Options for physical products
  objectives: { '50mm': 0, '60mm': 18000, '75mm': 35000 },
  eyepieces: { screen: 0, hd: 29000, '4k': 58000 },
  mounting: { handle: 0, arm: 22000 },
  stabilization: { '3axis': 0, enhanced: 45000 },
  care: { none: 0, basic: 29000, plus: 49000 },
};

// Calculates the final price of an item on the server to prevent tampering
function calculateItemPrice(item) {
  // For items with options (like physical microscopes)
  if (item.options && Object.keys(item.options).length > 0) {
    if (!item || !item.id || PRICES[item.id] === undefined) {
      throw new Error(`Base product ID '${item.id}' is invalid.`);
    }
    let total = PRICES[item.id];
    for (const [category, selection] of Object.entries(item.options)) {
      if (OPTIONS_PRICES[category] && OPTIONS_PRICES[category][selection] !== undefined) {
        total += OPTIONS_PRICES[category][selection];
      }
    }
    return total;
  } 
  // For simple items without options (like licenses and features)
  else {
    if (!item || !item.id || PRICES[item.id] === undefined) {
      throw new Error(`Product ID '${item.id}' is invalid.`);
    }
    return PRICES[item.id];
  }
}

app.get('/', (req, res) => {
  res.send('DP Biotech Payment Server is active.');
});

app.post('/create-checkout-session', async (req, res) => {
  const { cart } = req.body;

  if (!cart || !Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: 'Cart is empty or invalid.' });
  }

  try {
    const lineItems = cart.map(item => {
      const serverPrice = calculateItemPrice(item);
      
      return {
        price_data: {
          currency: 'eur',
          product_data: {
            name: item.name,
            description: item.options ? Object.values(item.options).filter(val => val).join(', ') : undefined,
          },
          unit_amount: serverPrice,
        },
        quantity: 1,
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // MODIFICA 1: Aggiunto 'customer_balance' per abilitare il flusso del bonifico
      payment_method_types: ['card', 'paypal', 'customer_balance'],
      line_items: lineItems,
      // MODIFICA 2: Aggiunto blocco di opzioni per configurare il bonifico
      payment_method_options: {
        customer_balance: {
          funding_type: 'bank_transfer',
          bank_transfer: {
            type: 'eu_bank_transfer',
          },
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
            display_name: 'Standard International Shipping',
          },
        },
      ],
      success_url: `https://www.dpbiotech.com/success.html`,
      cancel_url: `https://www.dpbiotech.com/checkout.html`,
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error('Stripe session creation error:', error.message);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server is listening on port ${PORT}`));
