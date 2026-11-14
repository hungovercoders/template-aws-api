import { HttpProblem } from "../lib/problem.ts";
import { BeerNotFound, readBeer, NameTaken } from "../store/beers.ts";

export const notFound = () => new HttpProblem(404, "Not Found", "There is no such beer in the catalogue.");
export const nameTaken = () => new HttpProblem(409, "Conflict", "Another beer in the catalogue already has that name.");

export async function findBeer(id: string) {
  const beer = await readBeer(id);
  if (!beer) throw notFound();
  return beer;
}

/** Translate what the store reports into the responses the contract documents. */
export async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof NameTaken) throw nameTaken();
    if (error instanceof BeerNotFound) throw notFound();
    throw error;
  }
}
