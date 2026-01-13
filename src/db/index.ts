import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing. Check your .env file.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default pool;

// also assign to CommonJS exports for interoperability with require()
// (some files in the repo use require/import interop)
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
(module as any).exports = pool;
