import { writeFileSync } from "node:fs";
import { shared } from "./shared";

writeFileSync("ENVSYNC_CONFIG_WAS_EXECUTED", "the config module ran");
const isProd = process.env.NODE_ENV === "production";

export default defineConfig({
  variables: {
    ...shared,
    "lower-case": { required: true },
    DUPLICATE: { required: true },
    DUPLICATE: { required: false },
    BAD_TYPE: { type: "datetime" },
    COMPUTED: { required: isProd },
  },
});
