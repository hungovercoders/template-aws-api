import type { Routes } from "./lib/router.ts";
import { createBeer } from "./operations/createBeer.ts";
import { getBeer } from "./operations/getBeer.ts";
import { listBeers } from "./operations/listBeers.ts";
import { rateBeer } from "./operations/rateBeer.ts";
import { retireBeer } from "./operations/retireBeer.ts";
import { updateBeer } from "./operations/updateBeer.ts";

// One entry per operationId in specs/openapi.yaml.
export const routes: Routes = { createBeer, getBeer, listBeers, rateBeer, retireBeer, updateBeer };
