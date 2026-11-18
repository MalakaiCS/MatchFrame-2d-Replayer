import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "../src/lib/auth-options.ts";
const m = await getMigrations(authOptions());
console.log(await m.compileMigrations());
process.exit(0);
