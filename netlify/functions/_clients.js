// One place that builds the server-side SDK clients, memoised per function
// instance. Handlers import these instead of constructing their own so tests
// can swap in fakes with a single vi.mock of this module.
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

let stripe;
export function getStripe() {
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

let supabase;
export function getSupabase() {
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return supabase;
}
