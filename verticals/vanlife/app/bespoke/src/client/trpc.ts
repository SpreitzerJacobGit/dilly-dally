import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../server/router-type.js";

/** The one place the typed client is created. */
export const trpc = createTRPCReact<AppRouter>();
