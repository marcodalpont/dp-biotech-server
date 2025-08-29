import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// --- DA PERSONALIZZARE ---
// Ho ricreato una struttura prezzi dettagliata.
// Assicurati che i prezzi qui corrispondano a quelli sul tuo sito.
// Tutti i prezzi sono in CENTESIMI (es. 299.00€ -> 29900).

const PRICES = {
  'dp-mini-base': 29900,
  'dp-pro-base': 89900,
  // Aggiungi qui gli altri prodotti base
};

const OPTIONS_PRICES = {
  // Opzioni DP Mini
  objectives: { '50mm': 0, '60mm': 1800, '75mm': 3500 },
  eyepieces: { screen: 0, hd: 2900, '4k': 5800 },
  mounting: { handle: 0, arm: 2200 },
  // Opzioni DP Pro (aggiungi le altre se necessario)
  stabilization: { '3axis': 0, enhanced: 4500 },
  // Opzioni comuni
  care: { none: 0, basic: 2900, plus: 4900 },
  // Aggiungi qui tutte le altre opzioni...
};

// Funzione per calcolare il prezzo di un singolo articolo in modo sicuro
function calculateItemPrice(item) {
  if (!item || !item.id || PRICES[item.id] === undefined) {
    throw new Error(`ID prodotto base '${item.id}' non valido.`);
  }

  let total = PRICES[item.id];

  // Aggiunge il costo delle opzioni
  if (item.options) {
    for (const [category, selection] of Object.entries(item.options)) {
      if (OPTIONS_PRICES[category] && OPTIONS_PRICES[category][selection] !== undefined) {
        total += OPTIONS_PRICES[category][selection];
      }
    }
  }
  return total;
}


app.get('/', (req, res) => {
  res.send('Server di pagamento DP Biotech attivo.');
});


app.post('/create-checkout-session', async (req, res) => {
  const { cart } = req.body;

  if (!cart || !Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: 'Il carrello è vuoto o non valido.' });
  }

  try {
    // NUOVA LOGICA: Calcoliamo il prezzo per ogni articolo sul server
    const lineItems = cart.map(item => {
      const serverPrice = calculateItemPrice(item);
      
      return {
        price_data: {
          currency: 'eur',
          product_data: {
            name: item.name, // Prendiamo il nome completo dal frontend
            description: item.options ? Object.values(item.options).filter(val => val).join(', ') : 'Prodotto standard',
          },
          unit_amount: serverPrice, // Usiamo il prezzo calcolato e sicuro
        },
        quantity: 1,
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'paypal'],
      line_items: lineItems,
      shipping_address_collection: {
        allowed_countries: ['IT', 'FR', 'DE', 'ES', 'GB', 'US', 'CH', 'AT', 'BE', 'NL'],
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 4990, currency: 'eur' },
            display_name: 'Spedizione Standard Internazionale',
          },
        },
      ],
      success_url: `https://www.tuosito-su-aruba.it/success.html`, // Assicurati sia il tuo URL reale
      cancel_url: `https://www.tuosito-su-aruba.it/checkout.html`,  // Assicurati sia il tuo URL reale
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error('Errore durante la creazione della sessione Stripe:', error.message);
    res.status(500).json({ error: 'Errore interno del server: ' + error.message });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server in ascolto sulla porta ${PORT}`));