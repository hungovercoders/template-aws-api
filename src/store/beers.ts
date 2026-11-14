// Beers in the single table:
//   beer       pk = BEER       sk = BEER#<id>
//   name lock  pk = BEERNAME   sk = <nameKey>   - makes names unique
// Each beer is also in two indexes, both sorted by its place in name order:
//   gsi1  gsi1pk = BEERS           - the whole catalogue
//   gsi2  gsi2pk = STYLE#<style>   - one style
// so a page of either is one Query that reads only the beers it returns.
// A beer and its name lock always change in one transaction, and every
// write that depends on a beer's name is conditioned on that name still being
// current, so a concurrent rename or retire can never strand a lock.
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { nameKey, orderKey, type BeerChanges, type StoredBeer } from "../domain/beer.ts";
import type { PageEnd } from "../domain/cursor.ts";
import { dynamo, tableName } from "../lib/dynamo.ts";

export class NameTaken extends Error {}
export class BeerNotFound extends Error {}

/** What was read has changed, or another write is in flight: read again and retry. */
class Stale extends Error {}

const beerKey = (id: string) => ({ pk: "BEER", sk: `BEER#${id}` });
const lockKey = (name: string) => ({ pk: "BEERNAME", sk: nameKey(name) });

/** The beer exists and still has the name this write was planned against. */
const STILL_NAMED = "attribute_exists(pk) AND #name = :expected_name";

const CATALOGUE = "BEERS";
const stylePartition = (style: string) => `STYLE#${style}`;

/** The attributes that place a beer in the two listing indexes. */
function indexed(beer: { name: string; style: string }) {
  const order = orderKey(beer.name);
  return { gsi1pk: CATALOGUE, gsi1sk: order, gsi2pk: stylePartition(beer.style), gsi2sk: order };
}

function fromItem(item: Record<string, any>): StoredBeer {
  const { pk, sk, gsi1pk, gsi1sk, gsi2pk, gsi2sk, ...beer } = item;
  return beer as StoredBeer;
}

/** Re-run `work` when it finds the data changed underneath it. */
async function retrying<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof Stale) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt * (0.5 + Math.random())));
    }
  }
}

/**
 * A DynamoDB error, told by its name. Not `instanceof`: the function runs on
 * the SDK its runtime provides, which need not share classes with the one
 * this was built against.
 */
function is(error: unknown, name: "ConditionalCheckFailedException" | "TransactionConflictException" | "TransactionCanceledException"): error is Error {
  return error instanceof Error && error.name === name;
}

/**
 * Why each item of a cancelled transaction failed, in order. From the error's
 * CancellationReasons, or - where a runtime's SDK leaves them off - from the
 * message DynamoDB always sends: "... specific reasons [ConditionalCheckFailed, None]".
 */
function cancellationCodes(error: Error): string[] {
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  if (reasons) return reasons.map((reason) => reason.Code ?? "None");
  return /\[([^\]]*)\]\s*$/.exec(error.message)?.[1]?.split(",").map((code) => code.trim()) ?? [];
}

/** For single-item writes: a failed condition or a clash with a transaction means the read was stale. */
function staleIfConcurrent(error: unknown): never {
  if (is(error, "ConditionalCheckFailedException") || is(error, "TransactionConflictException")) throw new Stale();
  throw error;
}

type Step = {
  item: NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
  /** What a failed condition on this item means: an error to report, or STALE to read again. */
  onConditionFailed?: Error | typeof STALE;
};
const STALE = Symbol("stale");

async function transact(steps: Step[]): Promise<void> {
  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: steps.map((step) => step.item) }));
  } catch (error) {
    if (!is(error, "TransactionCanceledException")) throw error;
    const codes = cancellationCodes(error);
    if (codes.includes("TransactionConflict")) throw new Stale();
    const failed = steps.filter((_, i) => codes[i] === "ConditionalCheckFailed").map((step) => step.onConditionFailed);
    // A stale read outranks everything else: the retry re-reads and reports what is true now.
    if (failed.includes(STALE)) throw new Stale();
    const reported = failed.find((outcome): outcome is Error => outcome instanceof Error);
    throw reported ?? error;
  }
}

export function putNewBeer(beer: StoredBeer): Promise<void> {
  return retrying(() =>
    transact([
      {
        item: { Put: { TableName: tableName, Item: { ...lockKey(beer.name), beer_id: beer.id }, ConditionExpression: "attribute_not_exists(pk)" } },
        onConditionFailed: new NameTaken(),
      },
      { item: { Put: { TableName: tableName, Item: { ...beerKey(beer.id), ...indexed(beer), ...beer }, ConditionExpression: "attribute_not_exists(pk)" } } },
    ]),
  );
}

export async function readBeer(id: string): Promise<StoredBeer | undefined> {
  const { Item } = await dynamo.send(new GetCommand({ TableName: tableName, Key: beerKey(id), ConsistentRead: true }));
  return Item && fromItem(Item);
}

/**
 * One page of the catalogue, or of one style, in name order. `next` is where
 * the page ended when there are more beers after it.
 */
export async function readPage(style: string | undefined, limit: number, after?: PageEnd): Promise<{ beers: StoredBeer[]; next?: PageEnd }> {
  const index = style ? "gsi2" : "gsi1";
  const partition = style ? stylePartition(style) : CATALOGUE;
  const items: Record<string, any>[] = [];
  let start: Record<string, any> | undefined = after && { ...beerKey(after.id), [`${index}pk`]: partition, [`${index}sk`]: after.order };
  // Ask for one more than the page: its presence is how we know there is a next page.
  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: index,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": `${index}pk` },
        ExpressionAttributeValues: { ":pk": partition },
        Limit: limit + 1 - items.length,
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start && items.length <= limit);

  const beers = items.slice(0, limit);
  const last = beers.at(-1);
  return {
    beers: beers.map(fromItem),
    ...(items.length > limit && last ? { next: { order: last[`${index}sk`], id: last.id } } : {}),
  };
}

export function applyChanges(id: string, changes: BeerChanges, updated_at: string): Promise<StoredBeer> {
  return retrying(async () => {
    const current = await readBeer(id);
    if (!current) throw new BeerNotFound();

    const next = {
      ...changes,
      updated_at,
      // Keep the beer's place in the listing indexes in step with its name and style.
      ...(changes.name === undefined ? {} : { gsi1sk: orderKey(changes.name), gsi2sk: orderKey(changes.name) }),
      ...(changes.style === undefined ? {} : { gsi2pk: stylePartition(changes.style) }),
    };
    const fields = Object.keys(next);
    const update = {
      TableName: tableName,
      Key: beerKey(id),
      ConditionExpression: STILL_NAMED,
      UpdateExpression: "SET " + fields.map((f) => `#${f} = :${f}`).join(", "),
      ExpressionAttributeNames: { ...Object.fromEntries(fields.map((f) => [`#${f}`, f])), "#name": "name" },
      ExpressionAttributeValues: { ...Object.fromEntries(Object.entries(next).map(([f, v]) => [`:${f}`, v])), ":expected_name": current.name },
    };

    const takesNewLock = changes.name !== undefined && nameKey(changes.name) !== nameKey(current.name);
    if (!takesNewLock) {
      // Same lock (or no rename): one write, and it returns the beer as stored.
      const { Attributes } = await dynamo.send(new UpdateCommand({ ...update, ReturnValues: "ALL_NEW" })).catch(staleIfConcurrent);
      return fromItem(Attributes!);
    }

    await transact([
      {
        item: { Put: { TableName: tableName, Item: { ...lockKey(changes.name!), beer_id: id }, ConditionExpression: "attribute_not_exists(pk)" } },
        onConditionFailed: new NameTaken(),
      },
      { item: { Update: update }, onConditionFailed: STALE },
      { item: { Delete: { TableName: tableName, Key: lockKey(current.name) } } },
    ]);
    // A transaction cannot return the item. Read it for its current ratings;
    // if it has been retired since, the update still happened, so answer with it.
    return (await readBeer(id)) ?? fromItem({ ...current, ...next });
  });
}

export function deleteBeer(id: string): Promise<void> {
  return retrying(async () => {
    const current = await readBeer(id);
    if (!current) throw new BeerNotFound();
    await transact([
      {
        item: {
          Delete: {
            TableName: tableName,
            Key: beerKey(id),
            ConditionExpression: STILL_NAMED,
            ExpressionAttributeNames: { "#name": "name" },
            ExpressionAttributeValues: { ":expected_name": current.name },
          },
        },
        onConditionFailed: STALE,
      },
      { item: { Delete: { TableName: tableName, Key: lockKey(current.name) } } },
    ]);
  });
}

export function addRating(id: string, score: number, updated_at: string): Promise<StoredBeer> {
  return retrying(async () => {
    try {
      const { Attributes } = await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: beerKey(id),
          ConditionExpression: "attribute_exists(pk)",
          UpdateExpression: "ADD rating_count :one, rating_total :score SET updated_at = :updated_at",
          ExpressionAttributeValues: { ":one": 1, ":score": score, ":updated_at": updated_at },
          ReturnValues: "ALL_NEW",
        }),
      );
      return fromItem(Attributes!);
    } catch (error) {
      if (is(error, "ConditionalCheckFailedException")) throw new BeerNotFound();
      if (is(error, "TransactionConflictException")) throw new Stale();
      throw error;
    }
  });
}
