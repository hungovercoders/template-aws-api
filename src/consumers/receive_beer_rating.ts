import type { BeerRatingSubmitted } from "../generated/messages.d.ts";
import { type MessageContext, Rejected } from "../lib/consumer.ts";
import { addRating, BeerNotFound } from "../store/beers.ts";

/** receive_beer_rating - a rating submitted elsewhere counts as a drinker's does. */
export async function receive_beer_rating({ event }: MessageContext<BeerRatingSubmitted>): Promise<void> {
  try {
    await addRating(event.data.beer_id, event.data.score, new Date().toISOString());
  } catch (error) {
    // No later delivery will find the beer either.
    if (error instanceof BeerNotFound) throw new Rejected("there is no such beer");
    throw error;
  }
}
