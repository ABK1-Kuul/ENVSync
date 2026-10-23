// Mentions like process.env.NOT_A_REAL_REFERENCE in comments must be ignored.
const { LOG_LEVEL = "info" } = process.env;

export const logger = {
  level: LOG_LEVEL,
  hint: "set process.env.ALSO_NOT_A_REFERENCE to change this",
};
