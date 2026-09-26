import { z } from "zod";

const csv = z
  .string()
  .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
  .pipe(z.array(z.string()).min(1));

const ConfigSchema = z
  .object({
    WORLD_APP_ID: z.string().startsWith("app_"),
    WORLD_RP_ID: z.string().startsWith("rp_"),
    WORLD_SIGNING_KEY: z.string().min(1),
    WORLD_ENVIRONMENT: z.enum(["production", "staging", "sandbox"]).default("sandbox"),
    WORLD_CREDENTIALS: csv.default(["proof_of_human", "selfie"]),
    WORLD_INVITE_CODE: z.stringbool().default(false),
    WORLD_STAGING_TOKEN: z.string().optional(),
    DATABASE_URL: z.string().startsWith("postgres"),
    JWT_SECRET: z.string().min(32),
    PUBLIC_URL: z.url().default("http://localhost:3000"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  })
  .refine((config) => config.WORLD_ENVIRONMENT !== "production" || config.PUBLIC_URL.startsWith("https://"), {
    path: ["PUBLIC_URL"],
    message: "must be https in production",
  });

export type Config = z.infer<typeof ConfigSchema>;

// Reports only the names of the bad variables, never their values: some of them are secrets.
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ");
    throw new Error(`Invalid or missing configuration: ${fields}`);
  }
  return parsed.data;
};

export const ACCOUNT_ACTION = "truth-skills-account-v1";
export const VOTE_SCOPE = "skills:vote";
export const ACCESS_TOKEN_TTL_S = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_S = 90 * 24 * 60 * 60; // 90 days
export const AUTH_REQUEST_TTL_S = 10 * 60; // a sign-in must finish within 10 min
export const AUTH_CODE_TTL_S = 60; // codes live 60 s
