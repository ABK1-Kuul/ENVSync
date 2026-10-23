export default function handler(req: { query: { name: string } }, res: { json(body: unknown): void }) {
  const key = req.query.name;
  const value = process.env[key];
  const stripe = process.env.STRIPE_KEY;
  const again = process.env.MISSING_IN_CONFIG;
  res.json({ configured: Boolean(value && stripe && again) });
}
