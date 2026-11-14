import { createHandler } from "./lib/router.ts";
import { routes } from "./generated/routes.ts";

export const handler = createHandler(routes);
