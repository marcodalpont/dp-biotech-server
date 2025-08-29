import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors()); // Permette al tuo sito su Aruba di comunicare con questo server
app.use(express.json());

// --- DA PERSONALIZZARE ---
// Inserisci qui l'ID esatto di ogni tuo prodotto/opzione e il suo prezzo IN CENTESIMI.
// Esempio: 299.00€ diventa 29900.
// Questo è fondamentale per la sicurezza, per non fidarsi mai del prezzo inviato dal browser.
const productDatabase = {
  'dp-mini-base':   { priceInCents: 29900, name: 'DP Mini - Configurazione Base' },
  'dp-pro-base':    { priceInCents: 89900, name: 'DP Pro - Configurazione Base' },
  // Aggiungi qui TUTTI gli altri tuoi ID prodotto con i rispettivi prezzi e nomi
  // 'id-opzione-1': { priceInCents: 5000, name: 'Opzione Extra Alpha' },
  // 'id-opzione-2': { priceInCents: 7500, name: 'Opzione Extra Beta' },
};


app.get('/', (req, res) => {
  res.send('Server di pagamento DP Biotech attivo.');
});


app.post('/create-checkout-session', async (req, res) => {
  const { cart } = req.body;

  if (!cart || !Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: 'Il carrello è vuoto o non valido.' });
  }

  try {
    const lineItems = cart.map(item => {
      const product = productDatabase[item.id];
      if (!product) {
        // Se un prodotto non è nel nostro database, blocca la transazione
        throw new Error(`Prodotto con ID '${item.id}' non trovato o non valido.`);
      }
      return {
        price_data: {
          currency: 'eur',
          product_data: {
            name: product.name,
            // Aggiunge una descrizione delle opzioni se presenti
            description: item.options ? Object.values(item.options).filter(val => val).join(', ') : 'Prodotto standard',
          },
          unit_amount: product.priceInCents,
        },
        quantity: 1, // La logica del tuo carrello gestisce la quantità duplicando gli oggetti
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
            fixed_amount: { amount: 4990, currency: 'eur' }, // 49.90€ in centesimi
            display_name: 'Spedizione Standard Internazionale',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 5 },
              maximum: { unit: 'business_day', value: 7 },
            },
          },
        },
      ],
      // --- DA PERSONALIZZARE ---
      // Inserisci qui l'indirizzo REALE del tuo sito su Aruba.
      success_url: `https://www.tuosito-su-aruba.it/success.html`,
      cancel_url: `https://www.tuosito-su-aruba.it/checkout.html`,
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error('Errore durante la creazione della sessione Stripe:', error.message);
    res.status(500).json({ error: 'Errore interno del server: ' + error.message });
  }
});

// Render usa la variabile PORT, altrimenti usa la 4242 per i test locali
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server in ascolto sulla porta ${PORT}`));