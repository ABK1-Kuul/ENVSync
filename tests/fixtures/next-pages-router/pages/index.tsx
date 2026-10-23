export default function Page() {
  const api = process.env.NEXT_PUBLIC_API_URL;
  const admin = process.env.NEXT_PUBLIC_ADMIN_SECRET;
  const missing = process.env.MISSING_IN_CONFIG;
  return <main data-api={api} data-admin={admin} data-missing={missing} />;
}
