export default {
  variables: {
    NEXT_PUBLIC_API_URL: { required: true, secret: false },
    STRIPE_KEY: { required: true, secret: true },
    NEXT_PUBLIC_ADMIN_SECRET: { required: true, secret: true },
    UNUSED_FLAG: { required: false },
  },
} satisfies Record<string, unknown>;
