export async function GET() {
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  const authConfigured = Boolean(process.env["AUTH_SECRET"]);
  return Response.json({ databaseConfigured, authConfigured, mode: process.env.NODE_ENV });
}
