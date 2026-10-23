import { defineConfig } from "envsync";

export default defineConfig({
  variables: {
    DATABASE_URL: { required: true, secret: true, type: "url", description: "Postgres connection string" },
    AUTH_SECRET: { required: true, secret: true },
    NEXT_PUBLIC_SITE_URL: { required: true, secret: false, type: "url" },
    LOG_LEVEL: { required: false },
  },
});
