import type { Routes } from "./lib/router.ts";
import { create_beer } from "./operations/create_beer.ts";
import { get_beer } from "./operations/get_beer.ts";
import { list_beers } from "./operations/list_beers.ts";
import { rate_beer } from "./operations/rate_beer.ts";
import { retire_beer } from "./operations/retire_beer.ts";
import { update_beer } from "./operations/update_beer.ts";

// One entry per operationId in specs/openapi.yaml.
export const routes: Routes = { create_beer, get_beer, list_beers, rate_beer, retire_beer, update_beer };
