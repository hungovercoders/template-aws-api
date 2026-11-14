import type { Routes } from "./lib/router.ts";

// One entry per operationId in specs/openapi.yaml, each implemented in
// src/operations/<operationId>.ts. Empty in the template: `task ci` is red
// until every operation in the contract has a handler here.
export const routes: Routes = {};
