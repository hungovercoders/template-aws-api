import { createHandler } from "./lib/router.ts";
import { routes } from "./routes.ts";

export const handler = createHandler(routes);
